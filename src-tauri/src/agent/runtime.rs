use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::protocol;
use crate::system::service::codex_command;

type PendingResponse = oneshot::Sender<Result<Value, String>>;
type PendingRequests = Arc<Mutex<HashMap<u64, PendingResponse>>>;
const DEFAULT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT_GRACE: u64 = 5_000;

pub struct AgentRuntime {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: PendingRequests,
    generation: Arc<AtomicU64>,
    next_id: AtomicU64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub version: String,
    pub already_running: bool,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
            next_id: AtomicU64::new(1),
        }
    }
}

impl AgentRuntime {
    pub fn start(&self, app: AppHandle) -> Result<StartResult, String> {
        let version = codex_version().ok_or_else(|| {
            "Codex CLI was not found. Install it before connecting the agent runtime.".to_owned()
        })?;

        let mut child_slot = self.child.lock().map_err(|error| error.to_string())?;
        if let Some(child) = child_slot.as_mut() {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(StartResult {
                    version,
                    already_running: true,
                });
            }
        }

        let generation = advance_generation(&self.generation);
        fail_pending_requests(&self.pending, "Agent runtime restarted before responding.");
        *child_slot = None;
        *self.stdin.lock().map_err(|error| error.to_string())? = None;

        let mut command = codex_command().ok_or_else(|| {
            "Codex CLI was not found. Install it before connecting the agent runtime.".to_owned()
        })?;
        command
            .args([
                "app-server",
                "--stdio",
                "--enable",
                "default_mode_request_user_input",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut command);

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let Some(mut child_stdin) = child.stdin.take() else {
            terminate_child(&mut child);
            return Err("Agent stdin is unavailable".to_owned());
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_child(&mut child);
            return Err("Agent stdout is unavailable".to_owned());
        };
        let Some(stderr) = child.stderr.take() else {
            terminate_child(&mut child);
            return Err("Agent stderr is unavailable".to_owned());
        };

        if let Err(error) = write_message(&mut child_stdin, &protocol::initialize_request())
            .and_then(|_| write_message(&mut child_stdin, &protocol::initialized_notification()))
        {
            terminate_child(&mut child);
            return Err(error);
        }

        let shared_stdin = Arc::clone(&self.stdin);
        let pending = Arc::clone(&self.pending);
        *shared_stdin.lock().map_err(|error| error.to_string())? = Some(child_stdin);
        *child_slot = Some(child);
        drop(child_slot);

        let stdout_app = app.clone();
        let shared_child = Arc::clone(&self.child);
        let active_generation = Arc::clone(&self.generation);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if !is_current_generation(&active_generation, generation) {
                    break;
                }
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        match serde_json::from_str::<Value>(&line) {
                            Ok(mut message) => {
                                sanitize_response_error(&mut message);
                                resolve_pending_response(&pending, &message);
                                let _ = stdout_app.emit("agent://message", message);
                            }
                            Err(error) => {
                                let _ = stdout_app.emit(
                                    "agent://stderr",
                                    format!("Invalid agent message: {error}"),
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = stdout_app.emit("agent://stderr", error.to_string());
                        break;
                    }
                }
            }

            if let Ok(mut child_slot) = shared_child.lock() {
                if !is_current_generation(&active_generation, generation) {
                    return;
                }
                if let Ok(mut stdin) = shared_stdin.lock() {
                    *stdin = None;
                }
                if let Some(mut child) = child_slot.take() {
                    terminate_child(&mut child);
                }
                fail_pending_requests(&pending, "Agent runtime stopped before responding.");
                let _ = stdout_app.emit("agent://stopped", ());
            }
        });

        let stderr_generation = Arc::clone(&self.generation);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !is_current_generation(&stderr_generation, generation) {
                    break;
                }
                if !line.trim().is_empty() {
                    let _ = app.emit("agent://stderr", line);
                }
            }
        });

        Ok(StartResult {
            version,
            already_running: false,
        })
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut child_slot = self.child.lock().map_err(|error| error.to_string())?;
        *self.stdin.lock().map_err(|error| error.to_string())? = None;
        fail_pending_requests(&self.pending, "Agent runtime was disconnected.");
        if let Some(mut child) = child_slot.take() {
            if let Err(kill_error) = child.kill() {
                let still_running = child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none();
                if still_running {
                    *child_slot = Some(child);
                    return Err(format!("Could not stop the agent runtime: {kill_error}"));
                }
            }
            child.wait().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn request(&self, method: String, params: Value) -> Result<Value, String> {
        let response_timeout = response_timeout(&method, &params);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, sender);

        if let Err(error) = self.send(&protocol::request(id, &method, params)) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }

        match response_timeout {
            Some(duration) => match timeout(duration, receiver).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("Agent response channel closed unexpectedly.".to_owned()),
                Err(_) => {
                    if let Ok(mut pending) = self.pending.lock() {
                        pending.remove(&id);
                    }
                    Err(format!("Agent request `{method}` timed out."))
                }
            },
            None => receiver
                .await
                .map_err(|_| "Agent response channel closed unexpectedly.".to_owned())?,
        }
    }

    pub fn reply(&self, request_id: Value, result: Value) -> Result<(), String> {
        self.send(&protocol::response(request_id, result))
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|error| error.to_string())?;
        let stdin = stdin
            .as_mut()
            .ok_or("Agent runtime is not connected. Start it before sending requests.")?;
        write_message(stdin, message)
    }
}

fn response_timeout(method: &str, params: &Value) -> Option<Duration> {
    if method != "command/exec" {
        return Some(DEFAULT_RESPONSE_TIMEOUT);
    }
    if params
        .get("disableTimeout")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map(|milliseconds| {
            Duration::from_millis(milliseconds.saturating_add(COMMAND_TIMEOUT_GRACE))
        })
        .or(Some(DEFAULT_RESPONSE_TIMEOUT))
}

fn advance_generation(generation: &AtomicU64) -> u64 {
    generation.fetch_add(1, Ordering::AcqRel) + 1
}

fn is_current_generation(generation: &AtomicU64, expected: u64) -> bool {
    generation.load(Ordering::Acquire) == expected
}

fn resolve_pending_response(pending: &Mutex<HashMap<u64, PendingResponse>>, message: &Value) {
    if message.get("method").is_some() {
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    let sender = pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    let Some(sender) = sender else {
        return;
    };

    let result = if let Some(error) = message.get("error") {
        Err(error
            .get("message")
            .and_then(Value::as_str)
            .map(sanitize_agent_error)
            .unwrap_or_else(|| "Agent request failed.".to_owned()))
    } else {
        message
            .get("result")
            .cloned()
            .ok_or_else(|| "Agent response did not include a result.".to_owned())
    };
    let _ = sender.send(result);
}

fn sanitize_response_error(message: &mut Value) {
    let Some(error_message) = message
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let sanitized = sanitize_agent_error(error_message);
    if sanitized == error_message {
        return;
    }
    if let Some(error_message) = message
        .get_mut("error")
        .and_then(|error| error.get_mut("message"))
    {
        *error_message = Value::String(sanitized);
    }
}

fn sanitize_agent_error(message: &str) -> String {
    const MAX_ERROR_CHARS: usize = 1_000;
    let lowercase = message.to_ascii_lowercase();
    let html_start = ["<!doctype html", "<html"]
        .iter()
        .filter_map(|marker| lowercase.find(marker))
        .min()
        .unwrap_or(message.len());
    let concise = message[..html_start].trim().trim_end_matches(':').trim();
    let concise = if concise.is_empty() {
        "Agent request failed."
    } else {
        concise
    };
    if concise.chars().count() <= MAX_ERROR_CHARS {
        return concise.to_owned();
    }
    format!(
        "{}...",
        concise.chars().take(MAX_ERROR_CHARS).collect::<String>()
    )
}

fn fail_pending_requests(pending: &Mutex<HashMap<u64, PendingResponse>>, message: &str) {
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(message.to_owned()));
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, message).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn codex_version() -> Option<String> {
    let mut command = codex_command()?;
    command.arg("--version");
    hide_window(&mut command);
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn resolves_pending_result() {
        let pending = Mutex::new(HashMap::new());
        let (sender, receiver) = oneshot::channel();
        pending.lock().unwrap().insert(7, sender);

        resolve_pending_response(&pending, &json!({ "id": 7, "result": { "ok": true } }));

        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap(),
            json!({ "ok": true })
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn resolves_pending_error() {
        let pending = Mutex::new(HashMap::new());
        let (sender, receiver) = oneshot::channel();
        pending.lock().unwrap().insert(8, sender);

        resolve_pending_response(
            &pending,
            &json!({ "id": 8, "error": { "message": "thread missing" } }),
        );

        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap_err(),
            "thread missing"
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn strips_html_from_agent_errors() {
        let mut message = json!({
            "id": 8,
            "error": {
                "message": "failed to list apps: Request failed with status 403 Forbidden: <html><body>challenge</body></html>"
            }
        });

        sanitize_response_error(&mut message);

        assert_eq!(
            message["error"]["message"],
            "failed to list apps: Request failed with status 403 Forbidden"
        );
    }

    #[test]
    fn server_request_does_not_resolve_pending_client_request() {
        let pending = Mutex::new(HashMap::new());
        let (sender, _receiver) = oneshot::channel();
        pending.lock().unwrap().insert(9, sender);

        resolve_pending_response(
            &pending,
            &json!({
                "id": 9,
                "method": "item/commandExecution/requestApproval",
                "params": { "command": "cargo test" }
            }),
        );

        assert!(pending.lock().unwrap().contains_key(&9));
    }

    #[test]
    fn command_requests_honor_their_execution_timeout() {
        assert_eq!(
            response_timeout("command/exec", &json!({ "timeoutMs": 120_000 })),
            Some(Duration::from_secs(125))
        );
        assert_eq!(
            response_timeout("command/exec", &json!({ "disableTimeout": true })),
            None
        );
        assert_eq!(
            response_timeout("model/list", &json!({ "timeoutMs": 120_000 })),
            Some(DEFAULT_RESPONSE_TIMEOUT)
        );
    }

    #[test]
    fn a_new_runtime_generation_invalidates_older_readers() {
        let generation = AtomicU64::new(0);
        let first = advance_generation(&generation);
        assert!(is_current_generation(&generation, first));

        let second = advance_generation(&generation);

        assert!(!is_current_generation(&generation, first));
        assert!(is_current_generation(&generation, second));
    }
}
