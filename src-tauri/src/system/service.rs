use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use semver::Version;
use serde::Deserialize;
use ureq::Agent;

use super::models::{CodexUpdateResult, CodexUpdateStatus, SystemInfo};

const CODEX_PACKAGE_URL: &str = "https://registry.npmjs.org/@openai%2Fcodex/latest";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy)]
enum UpdateMethod {
    Codex,
    Npm,
}

impl UpdateMethod {
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex updater",
            Self::Npm => "npm global",
        }
    }
}

#[derive(Deserialize)]
struct RegistryPackage {
    version: String,
}

pub fn read_system_info() -> SystemInfo {
    let shell = std::env::var("COMSPEC")
        .or_else(|_| std::env::var("SHELL"))
        .unwrap_or_else(|_| "Unknown shell".to_owned());

    SystemInfo {
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
        shell,
        codex_version: codex_output(&["--version"]),
    }
}

pub fn check_codex_update() -> Result<CodexUpdateStatus, String> {
    let current = current_codex_version()?;
    let latest = latest_codex_version()?;
    let method = codex_update_method();

    Ok(CodexUpdateStatus {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        can_update: method.is_some(),
        update_method: method.map(|value| value.label().to_owned()),
        installation_source: codex_installation_source(),
    })
}

pub fn update_codex() -> Result<CodexUpdateResult, String> {
    let previous = current_codex_version()?;
    let method = codex_update_method().ok_or(
        "This Codex installation cannot be updated safely from Xiao. Use the installer that provided it."
            .to_owned(),
    )?;
    let output = run_update(method)?;
    let version = current_codex_version()?;

    Ok(CodexUpdateResult {
        previous_version: previous.to_string(),
        version: version.to_string(),
        output: output_text(&output),
    })
}

fn latest_codex_version() -> Result<Version, String> {
    let config = Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(12)))
        .build();
    let agent: Agent = config.into();
    let mut response = agent
        .get(CODEX_PACKAGE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "Xiao-Workbench")
        .call()
        .map_err(|error| format!("Could not check the latest Codex release: {error}"))?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("Could not read the Codex release response: {error}"))?;
    let package: RegistryPackage = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Codex release response: {error}"))?;
    Version::parse(package.version.trim_start_matches('v'))
        .map_err(|error| format!("Invalid Codex release version: {error}"))
}

fn current_codex_version() -> Result<Version, String> {
    let output =
        codex_output(&["--version"]).ok_or("Codex CLI was not found on PATH.".to_owned())?;
    parse_codex_version(&output)
        .ok_or_else(|| format!("Could not parse Codex version from `{output}`."))
}

fn parse_codex_version(output: &str) -> Option<Version> {
    output
        .split_whitespace()
        .rev()
        .find_map(|part| Version::parse(part.trim_start_matches('v')).ok())
}

fn codex_update_method() -> Option<UpdateMethod> {
    if codex_command_succeeds(&["update", "--help"]) {
        return Some(UpdateMethod::Codex);
    }
    npm_manages_active_codex().then_some(UpdateMethod::Npm)
}

fn codex_installation_source() -> String {
    let Some(path) = resolve_codex_path() else {
        return "Codex CLI".to_owned();
    };
    if npm_prefix().is_some_and(|prefix| path_is_within(&path, &prefix)) {
        return "npm global".to_owned();
    }
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if normalized.contains("/openai/codex/") {
        return "Codex desktop".to_owned();
    }
    "Codex CLI".to_owned()
}

fn npm_manages_active_codex() -> bool {
    let Some(path) = resolve_codex_path() else {
        return false;
    };
    npm_prefix().is_some_and(|prefix| path_is_within(&path, &prefix))
}

fn resolve_codex_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        command_output("where.exe", &["codex"])
            .and_then(|output| first_windows_command_path(&output))
            .or_else(codex_desktop_path)
    }
    #[cfg(not(windows))]
    {
        command_output("which", &["codex"]).and_then(|output| first_command_path(&output))
    }
}

#[cfg(windows)]
fn first_windows_command_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "bat" | "cmd" | "com" | "exe"
                    )
                })
        })
}

#[cfg(not(windows))]
fn first_command_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

#[cfg(windows)]
fn codex_desktop_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .and_then(|directory| codex_desktop_path_in(&directory))
}

#[cfg(windows)]
fn codex_desktop_path_in(local_app_data: &Path) -> Option<PathBuf> {
    let executable = local_app_data
        .join("OpenAI")
        .join("Codex")
        .join("bin")
        .join("codex.exe");
    executable.is_file().then_some(executable)
}

pub(crate) fn codex_command() -> Option<Command> {
    #[cfg(windows)]
    {
        resolve_codex_path().map(command_for_codex_path)
    }
    #[cfg(not(windows))]
    {
        Some(Command::new("codex"))
    }
}

#[cfg(windows)]
fn command_for_codex_path(path: PathBuf) -> Command {
    Command::new(path)
}

fn npm_prefix() -> Option<PathBuf> {
    command_output(npm_program(), &["prefix", "-g"])
        .map(|output| output.trim().to_owned())
        .filter(|output| !output.is_empty())
        .map(PathBuf::from)
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let parent = parent
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase();
        path == parent
            || path
                .strip_prefix(&parent)
                .is_some_and(|remainder| remainder.starts_with('/'))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(parent)
    }
}

fn run_update(method: UpdateMethod) -> Result<Output, String> {
    let command = match method {
        UpdateMethod::Codex => {
            let mut command =
                codex_command().ok_or("Codex CLI was not found on PATH.".to_owned())?;
            command.arg("update");
            command
        }
        UpdateMethod::Npm => {
            let mut command = Command::new(npm_program());
            command.args(["install", "-g", "@openai/codex@latest"]);
            command
        }
    };
    run_command_with_timeout(command, method.label(), UPDATE_TIMEOUT)
}

fn run_command_with_timeout(
    mut command: Command,
    label: &str,
    timeout: Duration,
) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {label}: {error}"))?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Could not read {label} output."));
    };
    let Some(mut stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Could not read {label} errors."));
    };
    let stdout_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let stderr_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).map(|_| output)
    });
    let started = Instant::now();

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "{label} timed out after {} seconds.",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("Could not monitor {label}: {error}"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("{label} output reader stopped unexpectedly."))?
        .map_err(|error| format!("Could not read {label} output: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("{label} error reader stopped unexpectedly."))?
        .map_err(|error| format!("Could not read {label} errors: {error}"))?;
    let output = Output {
        status,
        stdout,
        stderr,
    };
    if output.status.success() {
        return Ok(output);
    }
    let message = output_text(&output);
    Err(if message.is_empty() {
        format!("{label} exited with {}.", output.status)
    } else {
        message
    })
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    [stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn codex_command_succeeds(arguments: &[&str]) -> bool {
    let Some(mut command) = codex_command() else {
        return false;
    };
    command.args(arguments);
    hide_window(&mut command);
    command.status().is_ok_and(|status| status.success())
}

fn codex_output(arguments: &[&str]) -> Option<String> {
    let mut command = codex_command()?;
    command.args(arguments);
    hide_window(&mut command);
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn command_output(program: &str, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(arguments);
    hide_window(&mut command);
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(windows)]
fn npm_program() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn npm_program() -> &'static str {
    "npm"
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
    use super::*;

    #[test]
    fn parses_codex_cli_version() {
        assert_eq!(
            parse_codex_version("codex-cli 0.144.3"),
            Some(Version::new(0, 144, 3))
        );
        assert_eq!(
            parse_codex_version("codex v1.2.0-beta.1"),
            Version::parse("1.2.0-beta.1").ok()
        );
    }

    #[test]
    fn semver_comparison_detects_new_releases() {
        let current = Version::parse("0.144.3").unwrap();
        let latest = Version::parse("0.144.4").unwrap();
        assert!(latest > current);
        assert!(current <= latest);
    }

    #[test]
    fn drains_large_child_output_before_the_process_exits() {
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("cmd.exe");
            command.args([
                "/D",
                "/Q",
                "/C",
                "(for /L %i in (1,1,6000) do @echo 0123456789abcdef0123456789abcdef) & (for /L %i in (1,1,6000) do @echo fedcba9876543210fedcba9876543210 1>&2)",
            ]);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "i=0; while [ $i -lt 6000 ]; do printf '0123456789abcdef0123456789abcdef\\n'; i=$((i+1)); done; i=0; while [ $i -lt 6000 ]; do printf 'fedcba9876543210fedcba9876543210\\n' >&2; i=$((i+1)); done",
            ]);
            command
        };

        let output = run_command_with_timeout(command, "output test", Duration::from_secs(10))
            .expect("large child output should not fill the pipe and deadlock");

        assert!(output.stdout.len() > 64 * 1024);
        assert!(output.stderr.len() > 64 * 1024);
    }

    #[cfg(windows)]
    #[test]
    fn npm_path_check_rejects_sibling_with_shared_prefix() {
        let prefix = Path::new(r"C:\Users\xiao\AppData\Roaming\npm");

        assert!(path_is_within(
            Path::new(r"C:\Users\xiao\AppData\Roaming\npm\codex.cmd"),
            prefix,
        ));
        assert!(!path_is_within(
            Path::new(r"C:\Users\xiao\AppData\Roaming\npm-backup\codex.cmd"),
            prefix,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn resolved_npm_cmd_shim_can_run() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-codex-shim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let shim = directory.join("codex.cmd");
        std::fs::write(&shim, "@echo off\r\necho codex-cli 9.8.7\r\n").unwrap();

        let output = command_for_codex_path(shim)
            .arg("--version")
            .output()
            .expect("the resolved npm shim should launch");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "codex-cli 9.8.7"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(windows)]
    #[test]
    fn skips_extensionless_npm_shims_on_windows() {
        let output = "C:\\Users\\xiao\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\xiao\\AppData\\Roaming\\npm\\codex.cmd\r\n";

        assert_eq!(
            first_windows_command_path(output),
            Some(PathBuf::from(
                r"C:\Users\xiao\AppData\Roaming\npm\codex.cmd"
            ))
        );
    }

    #[cfg(windows)]
    #[test]
    fn finds_the_codex_desktop_bundled_cli() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-codex-desktop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let executable = directory.join("OpenAI/Codex/bin/codex.exe");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, []).unwrap();

        assert_eq!(codex_desktop_path_in(&directory), Some(executable));
        let _ = std::fs::remove_dir_all(directory);
    }
}
