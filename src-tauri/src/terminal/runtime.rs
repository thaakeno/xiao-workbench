use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 4;

#[cfg(windows)]
fn shell_workspace_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(windows))]
fn shell_workspace_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

struct TerminalSession {
    project_path: String,
    task_id: Option<String>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub session_id: String,
    pub shell: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: Option<u32>,
    error: Option<String>,
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        self.decode(false)
    }

    fn finish(&mut self) -> String {
        self.decode(true)
    }

    fn decode(&mut self, finish: bool) -> String {
        let bytes = std::mem::take(&mut self.pending);
        let mut remaining = bytes.as_slice();
        let mut output = String::new();
        loop {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    output.push_str(text);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&remaining[..valid]).unwrap_or_default());
                    remaining = &remaining[valid..];
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{FFFD}');
                            remaining = &remaining[length..];
                            if remaining.is_empty() {
                                break;
                            }
                        }
                        None => {
                            if finish {
                                output.push('\u{FFFD}');
                            } else {
                                self.pending.extend_from_slice(remaining);
                            }
                            break;
                        }
                    }
                }
            }
        }
        output
    }
}

impl TerminalManager {
    pub fn start(
        &self,
        app: AppHandle,
        session_id: String,
        project_path: String,
        task_id: Option<String>,
        workspace_path: String,
        shell: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalStartResult, String> {
        validate_session_id(&session_id)?;
        let workspace = Path::new(&workspace_path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !workspace.is_dir() {
            return Err("The terminal workspace is not a directory.".to_owned());
        }
        let shell = shell.trim();
        if shell.is_empty() || shell == "Unknown shell" {
            return Err("No system shell is available.".to_owned());
        }
        if self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(&session_id)
        {
            return Err("This terminal session already exists.".to_owned());
        }

        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| error.to_string())?;
        // Windows canonicalization returns a `\\?\` device path. CMD treats
        // that as a UNC path and silently falls back to the Windows directory.
        let shell_workspace = shell_workspace_path(&workspace);
        let mut command = CommandBuilder::new(shell);
        command.cwd(&shell_workspace);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let session = Arc::new(TerminalSession {
            project_path,
            task_id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
        });
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .insert(session_id.clone(), session);

        let output_app = app.clone();
        let output_session_id = session_id.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            let mut decoder = Utf8StreamDecoder::default();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let data = decoder.push(&buffer[..read]);
                        if data.is_empty() {
                            continue;
                        }
                        let _ = output_app.emit(
                            "terminal://output",
                            TerminalOutput {
                                session_id: output_session_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                let _ = output_app.emit(
                    "terminal://output",
                    TerminalOutput {
                        session_id: output_session_id,
                        data,
                    },
                );
            }
        });

        let sessions = Arc::clone(&self.sessions);
        let exit_session_id = session_id.clone();
        thread::spawn(move || {
            let result = child.wait();
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&exit_session_id);
            }
            let (exit_code, error) = match result {
                Ok(status) => (Some(status.exit_code()), None),
                Err(error) => (None, Some(error.to_string())),
            };
            let _ = app.emit(
                "terminal://exit",
                TerminalExit {
                    session_id: exit_session_id,
                    exit_code,
                    error,
                },
            );
        });

        Ok(TerminalStartResult {
            session_id,
            shell: shell.to_owned(),
        })
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let result = session
            .master
            .lock()
            .map_err(|error| error.to_string())?
            .resize(pty_size(cols, rows))
            .map_err(|error| error.to_string());
        result
    }

    pub(crate) fn stop_for_execution_change(
        &self,
        project_path: &str,
        task_id: &str,
    ) -> Result<(), String> {
        let session_ids = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(_, session)| {
                session.project_path == project_path
                    && session.task_id.as_deref().is_none_or(|id| id == task_id)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            self.stop(&session_id)?;
        }
        Ok(())
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(session_id);
        if let Some(session) = session {
            session
                .killer
                .lock()
                .map_err(|error| error.to_string())?
                .kill()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "The terminal session is no longer running.".to_owned())
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(MIN_COLS),
        rows: rows.max(MIN_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.len() > 64
        || session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid terminal session id.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn cmd_workspace_path_removes_windows_device_prefix() {
        assert_eq!(
            shell_workspace_path(Path::new(r"\\?\D:\Project Archive\xiao-workbench")),
            PathBuf::from(r"D:\Project Archive\xiao-workbench"),
        );
    }

    #[test]
    fn terminal_sizes_have_safe_minimums() {
        let size = pty_size(0, 0);
        assert_eq!(size.cols, MIN_COLS);
        assert_eq!(size.rows, MIN_ROWS);
    }

    #[test]
    fn terminal_session_ids_are_restricted() {
        assert!(validate_session_id("terminal-123").is_ok());
        assert!(validate_session_id("../terminal").is_err());
    }

    #[test]
    fn utf8_decoder_preserves_characters_split_across_chunks() {
        let expected = "ASCII \u{00b7} \u{03bb} \u{00b7} \u{6c49}\u{5b57} \u{00b7} \u{10348}";
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = String::new();
        for byte in expected.as_bytes() {
            output.push_str(&decoder.push(std::slice::from_ref(byte)));
        }
        output.push_str(&decoder.finish());

        assert_eq!(output, expected);
        assert!(!output.contains('\u{FFFD}'));
    }

    #[test]
    fn native_pty_captures_shell_output() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        #[cfg(windows)]
        let mut command = {
            let mut command = CommandBuilder::new(
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned()),
            );
            command.args(["/D", "/Q", "/C", "echo xiao-pty-ready"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = CommandBuilder::new(
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()),
            );
            command.args(["-lc", "printf xiao-pty-ready"]);
            command
        };
        command.cwd(std::env::temp_dir());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let status = child.wait().unwrap();
        drop(pair.master);
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();

        assert!(status.success());
        assert!(
            output.contains("xiao-pty-ready"),
            "PTY output was {output:?}"
        );
    }
}
