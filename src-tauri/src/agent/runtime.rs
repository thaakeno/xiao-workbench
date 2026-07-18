use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::protocol;
use crate::runs::repository::bounded_diagnostic;
use crate::runs::service::RunService;
use crate::system::service::codex_command;
use crate::xiao::repository::XiaoRepository;

type PendingResponse = oneshot::Sender<Result<Value, RequestFailure>>;
type PendingRequests = Arc<Mutex<HashMap<u64, PendingResponse>>>;
const DEFAULT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT_GRACE: u64 = 5_000;

pub struct AgentRuntime {
    lifecycle: Mutex<()>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: PendingRequests,
    generation: Arc<AtomicU64>,
    thread_bindings: Mutex<HashMap<String, String>>,
    next_id: AtomicU64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RequestFailure {
    StaleGeneration,
    Rejected(String),
    Ambiguous(String),
}

impl RequestFailure {
    fn into_message(self) -> String {
        match self {
            Self::StaleGeneration => {
                "The agent request belongs to a stale runtime generation.".to_owned()
            }
            Self::Rejected(message) | Self::Ambiguous(message) => message,
        }
    }

    fn requires_shutdown(&self) -> bool {
        matches!(self, Self::Ambiguous(_))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub version: String,
    pub already_running: bool,
    pub environment_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMessageEnvelope {
    pub environment_id: String,
    pub generation: u64,
    pub message: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnosticEnvelope {
    pub environment_id: String,
    pub generation: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStoppedEnvelope {
    pub environment_id: String,
    pub generation: u64,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
            thread_bindings: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl AgentRuntime {
    pub fn start_for_environment(
        &self,
        app: AppHandle,
        environment_id: &str,
    ) -> Result<StartResult, String> {
        validate_environment_id(environment_id)?;
        let _lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
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
                    environment_id: environment_id.to_owned(),
                    generation: self.generation.load(Ordering::Acquire),
                });
            }
        }

        let previous_generation = self.generation.load(Ordering::Acquire);
        if previous_generation != 0 {
            if let Some(service) = app.try_state::<RunService>() {
                service.handle_runtime_stopped(&app, environment_id, previous_generation);
            }
        }
        let generation = app
            .state::<XiaoRepository>()
            .allocate_runtime_generation(environment_id)?;
        self.generation.store(generation, Ordering::Release);
        fail_pending_requests(&self.pending, "Agent runtime restarted before responding.");
        self.thread_bindings
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        *child_slot = None;
        *self.stdin.lock().map_err(|error| error.to_string())? = None;

        let mut command = codex_command().ok_or_else(|| {
            "Codex CLI was not found. Install it before connecting the agent runtime.".to_owned()
        })?;
        let runtime_state_dir = app
            .state::<XiaoRepository>()
            .app_data_dir()
            .join("codex-runtime")
            .join(environment_id);
        std::fs::create_dir_all(&runtime_state_dir).map_err(|error| error.to_string())?;
        command
            .args([
                "app-server",
                "--stdio",
                "--enable",
                "default_mode_request_user_input",
            ])
            .env("CODEX_SQLITE_HOME", runtime_state_dir);
        let mut command = super::supervisor::supervise_command(command)?;
        command
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
        let stdout_environment_id = environment_id.to_owned();
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
                                if let Some(service) = stdout_app.try_state::<RunService>() {
                                    service.handle_runtime_message(
                                        &stdout_app,
                                        &stdout_environment_id,
                                        generation,
                                        message.clone(),
                                    );
                                }
                                let _ = stdout_app.emit(
                                    "agent://runtime-message",
                                    RuntimeMessageEnvelope {
                                        environment_id: stdout_environment_id.clone(),
                                        generation,
                                        message,
                                    },
                                );
                            }
                            Err(error) => {
                                let diagnostic =
                                    bounded_diagnostic(&format!("Invalid agent message: {error}"));
                                let _ = stdout_app.emit(
                                    "agent://runtime-stderr",
                                    RuntimeDiagnosticEnvelope {
                                        environment_id: stdout_environment_id.clone(),
                                        generation,
                                        message: diagnostic,
                                    },
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let diagnostic = bounded_diagnostic(&error.to_string());
                        let _ = stdout_app.emit(
                            "agent://runtime-stderr",
                            RuntimeDiagnosticEnvelope {
                                environment_id: stdout_environment_id.clone(),
                                generation,
                                message: diagnostic,
                            },
                        );
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
                if let Some(service) = stdout_app.try_state::<RunService>() {
                    service.handle_runtime_stopped(&stdout_app, &stdout_environment_id, generation);
                }
                let _ = stdout_app.emit(
                    "agent://runtime-stopped",
                    RuntimeStoppedEnvelope {
                        environment_id: stdout_environment_id,
                        generation,
                    },
                );
            }
        });

        let stderr_generation = Arc::clone(&self.generation);
        let stderr_environment_id = environment_id.to_owned();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !is_current_generation(&stderr_generation, generation) {
                    break;
                }
                if !line.trim().is_empty() {
                    let _ = app.emit(
                        "agent://runtime-stderr",
                        RuntimeDiagnosticEnvelope {
                            environment_id: stderr_environment_id.clone(),
                            generation,
                            message: bounded_diagnostic(&line),
                        },
                    );
                }
            }
        });

        Ok(StartResult {
            version,
            already_running: false,
            environment_id: environment_id.to_owned(),
            generation,
        })
    }

    pub fn stop(&self) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
        self.stop_locked()
    }

    pub(crate) fn stop_generation(&self, expected_generation: u64) -> Result<bool, String> {
        let _lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
        if self.generation.load(Ordering::Acquire) != expected_generation {
            return Ok(false);
        }
        self.stop_locked()?;
        Ok(true)
    }

    fn stop_locked(&self) -> Result<(), String> {
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
        self.thread_bindings
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        Ok(())
    }

    pub fn bind_thread_to_task(
        &self,
        thread_id: &str,
        project_path: &str,
        task_id: &str,
        execution_root: &str,
    ) -> Result<(), String> {
        let binding = format!("{project_path}\0{task_id}\0{execution_root}");
        let mut bindings = self
            .thread_bindings
            .lock()
            .map_err(|error| error.to_string())?;
        if bindings
            .get(thread_id)
            .is_some_and(|existing| existing != &binding)
        {
            return Err(
                "The agent thread is already bound to another Xiao task or execution environment."
                    .to_owned(),
            );
        }
        bindings.insert(thread_id.to_owned(), binding);
        Ok(())
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn is_thread_bound(
        &self,
        thread_id: &str,
        project_path: &str,
        task_id: &str,
        execution_root: &str,
    ) -> Result<bool, String> {
        let binding = format!("{project_path}\0{task_id}\0{execution_root}");
        Ok(self
            .thread_bindings
            .lock()
            .map_err(|error| error.to_string())?
            .get(thread_id)
            .is_some_and(|existing| existing == &binding))
    }

    pub fn require_thread_task(
        &self,
        thread_id: &str,
        project_path: &str,
        task_id: &str,
        execution_root: &str,
    ) -> Result<(), String> {
        let binding = format!("{project_path}\0{task_id}\0{execution_root}");
        match self
            .thread_bindings
            .lock()
            .map_err(|error| error.to_string())?
            .get(thread_id)
        {
            Some(existing) if existing == &binding => Ok(()),
            Some(_) => Err(
                "The agent thread belongs to another Xiao task or execution environment."
                    .to_owned(),
            ),
            None => Err("The agent thread is not owned by this Xiao runtime.".to_owned()),
        }
    }

    async fn request_with_generation(
        &self,
        expected_generation: Option<u64>,
        method: String,
        params: Value,
    ) -> Result<Value, RequestFailure> {
        let response_timeout = response_timeout(&method, &params);
        let (id, receiver) = {
            let _lifecycle = self
                .lifecycle
                .lock()
                .map_err(|error| RequestFailure::Ambiguous(error.to_string()))?;
            if expected_generation
                .is_some_and(|expected| self.generation.load(Ordering::Acquire) != expected)
            {
                return Err(RequestFailure::StaleGeneration);
            }
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let (sender, receiver) = oneshot::channel();
            self.pending
                .lock()
                .map_err(|error| RequestFailure::Ambiguous(error.to_string()))?
                .insert(id, sender);
            if let Err(error) = self.send_locked(&protocol::request(id, &method, params)) {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(RequestFailure::Ambiguous(error));
            }
            (id, receiver)
        };

        match response_timeout {
            Some(duration) => match timeout(duration, receiver).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(RequestFailure::Ambiguous(
                    "Agent response channel closed unexpectedly.".to_owned(),
                )),
                Err(_) => {
                    if let Ok(mut pending) = self.pending.lock() {
                        pending.remove(&id);
                    }
                    Err(RequestFailure::Ambiguous(format!(
                        "Agent request `{method}` timed out."
                    )))
                }
            },
            None => receiver.await.map_err(|_| {
                RequestFailure::Ambiguous("Agent response channel closed unexpectedly.".to_owned())
            })?,
        }
    }

    pub async fn request(&self, method: String, params: Value) -> Result<Value, String> {
        self.request_with_generation(None, method, params)
            .await
            .map_err(RequestFailure::into_message)
    }

    pub(crate) async fn request_turn_start(
        &self,
        expected_generation: u64,
        params: Value,
    ) -> Result<Value, String> {
        match self
            .request_with_generation(Some(expected_generation), "turn/start".to_owned(), params)
            .await
        {
            Ok(result) => Ok(result),
            Err(failure) if !failure.requires_shutdown() => Err(failure.into_message()),
            Err(failure) => {
                let dispatch_error = failure.into_message();
                match self.stop_generation(expected_generation) {
                    Ok(_) => Err(dispatch_error),
                    Err(stop_error) => Err(format!(
                        "{dispatch_error} The ambiguous runtime could not be stopped safely: {stop_error}"
                    )),
                }
            }
        }
    }

    pub(crate) async fn request_turn_interrupt(
        &self,
        expected_generation: u64,
        params: Value,
    ) -> Result<Value, String> {
        match self
            .request_with_generation(
                Some(expected_generation),
                "turn/interrupt".to_owned(),
                params,
            )
            .await
        {
            Ok(result) => Ok(result),
            Err(failure) if !failure.requires_shutdown() => Err(failure.into_message()),
            Err(failure) => {
                let interrupt_error = failure.into_message();
                match self.stop_generation(expected_generation) {
                    Ok(_) => Ok(Value::Null),
                    Err(stop_error) => Err(format!(
                        "{interrupt_error} The interrupted runtime could not be stopped safely: {stop_error}"
                    )),
                }
            }
        }
    }

    pub fn reply_for_generation(
        &self,
        expected_generation: u64,
        request_id: Value,
        result: Value,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
        if self.generation.load(Ordering::Acquire) != expected_generation {
            return Err(RequestFailure::StaleGeneration.into_message());
        }
        self.send_locked(&protocol::response(request_id, result))
    }

    fn send_locked(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|error| error.to_string())?;
        let stdin = stdin
            .as_mut()
            .ok_or("Agent runtime is not connected. Start it before sending requests.")?;
        write_message(stdin, message)
    }
}

#[derive(Default)]
pub struct EnvironmentRuntimeRegistry {
    runtimes: Mutex<HashMap<String, Arc<AgentRuntime>>>,
}

impl EnvironmentRuntimeRegistry {
    pub(crate) fn runtime(&self, environment_id: &str) -> Result<Arc<AgentRuntime>, String> {
        validate_environment_id(environment_id)?;
        let mut runtimes = self.runtimes.lock().map_err(|error| error.to_string())?;
        Ok(Arc::clone(
            runtimes
                .entry(environment_id.to_owned())
                .or_insert_with(|| Arc::new(AgentRuntime::default())),
        ))
    }

    pub fn start(&self, app: AppHandle, environment_id: &str) -> Result<StartResult, String> {
        self.runtime(environment_id)?
            .start_for_environment(app, environment_id)
    }

    pub fn stop(&self, environment_id: &str) -> Result<(), String> {
        let runtime = self.runtime(environment_id)?;
        runtime.stop()
    }

    pub async fn request(
        &self,
        environment_id: &str,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        self.runtime(environment_id)?.request(method, params).await
    }

    pub fn reply(
        &self,
        environment_id: &str,
        generation: u64,
        request_id: Value,
        result: Value,
    ) -> Result<(), String> {
        let runtime = self.runtime(environment_id)?;
        runtime.reply_for_generation(generation, request_id, result)
    }

    pub fn require_thread_task(
        &self,
        environment_id: &str,
        thread_id: &str,
        project_path: &str,
        task_id: &str,
        execution_root: &str,
    ) -> Result<(), String> {
        self.runtime(environment_id)?.require_thread_task(
            thread_id,
            project_path,
            task_id,
            execution_root,
        )
    }

    pub fn generation(&self, environment_id: &str) -> Result<u64, String> {
        Ok(self.runtime(environment_id)?.generation())
    }
}

fn validate_environment_id(environment_id: &str) -> Result<(), String> {
    if environment_id.is_empty()
        || environment_id.len() > 128
        || !environment_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The execution environment id is invalid.".to_owned());
    }
    Ok(())
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

#[cfg(test)]
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
        Err(RequestFailure::Rejected(
            error
                .get("message")
                .and_then(Value::as_str)
                .map(sanitize_agent_error)
                .unwrap_or_else(|| "Agent request failed.".to_owned()),
        ))
    } else {
        message.get("result").cloned().ok_or_else(|| {
            RequestFailure::Ambiguous("Agent response did not include a result.".to_owned())
        })
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
        let _ = sender.send(Err(RequestFailure::Ambiguous(message.to_owned())));
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
            receiver
                .blocking_recv()
                .unwrap()
                .unwrap_err()
                .into_message(),
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
    fn runtime_threads_cannot_cross_task_bindings() {
        let runtime = AgentRuntime::default();
        runtime
            .bind_thread_to_task("thread", "C:/project", "task-a", "C:/project")
            .unwrap();
        runtime
            .require_thread_task("thread", "C:/project", "task-a", "C:/project")
            .unwrap();
        assert!(runtime
            .require_thread_task("thread", "C:/project", "task-b", "C:/project")
            .unwrap_err()
            .contains("another Xiao task"));
        assert!(runtime
            .require_thread_task("thread", "C:/project", "task-a", "C:/managed")
            .unwrap_err()
            .contains("another Xiao task"));
        assert!(runtime
            .bind_thread_to_task("thread", "C:/other", "task-a", "C:/other")
            .unwrap_err()
            .contains("another Xiao task"));
        assert!(runtime
            .require_thread_task("unknown", "C:/project", "task-a", "C:/project")
            .unwrap_err()
            .contains("not owned"));
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
    fn failed_turn_dispatch_closes_runtime_ownership() {
        let runtime = AgentRuntime::default();
        runtime
            .bind_thread_to_task("thread", "C:/project", "task", "C:/project")
            .unwrap();

        let error =
            tauri::async_runtime::block_on(runtime.request_turn_start(0, json!({}))).unwrap_err();

        assert!(error.contains("not connected"));
        assert!(!runtime
            .is_thread_bound("thread", "C:/project", "task", "C:/project")
            .unwrap());
    }

    #[test]
    fn failed_turn_interrupt_succeeds_after_closing_runtime() {
        let runtime = AgentRuntime::default();
        runtime
            .bind_thread_to_task("thread", "C:/project", "task", "C:/project")
            .unwrap();

        tauri::async_runtime::block_on(runtime.request_turn_interrupt(0, json!({}))).unwrap();

        assert!(!runtime
            .is_thread_bound("thread", "C:/project", "task", "C:/project")
            .unwrap());
    }

    #[test]
    fn stale_generation_write_never_stops_the_current_runtime() {
        let runtime = AgentRuntime::default();
        runtime.generation.store(2, Ordering::Release);
        runtime
            .bind_thread_to_task("thread", "C:/project", "task", "C:/project")
            .unwrap();

        let request_error =
            tauri::async_runtime::block_on(runtime.request_turn_start(1, json!({}))).unwrap_err();
        let reply_error = runtime
            .reply_for_generation(1, json!(7), json!({ "decision": "decline" }))
            .unwrap_err();

        assert!(request_error.contains("stale runtime generation"));
        assert!(reply_error.contains("stale runtime generation"));
        assert!(runtime
            .is_thread_bound("thread", "C:/project", "task", "C:/project")
            .unwrap());
    }

    #[test]
    fn only_ambiguous_request_failures_require_runtime_shutdown() {
        assert!(RequestFailure::Ambiguous("timeout".to_owned()).requires_shutdown());
        assert!(!RequestFailure::Rejected("invalid turn".to_owned()).requires_shutdown());
        assert!(!RequestFailure::StaleGeneration.requires_shutdown());
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
