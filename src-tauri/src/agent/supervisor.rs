use std::process::Command;

const RUNTIME_SUPERVISOR_FLAG: &str = "--xiao-runtime-supervisor";

pub fn run_if_requested() -> Option<i32> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;

        let mut arguments = std::env::args_os();
        let _executable = arguments.next();
        if arguments.next().as_deref() != Some(OsStr::new(RUNTIME_SUPERVISOR_FLAG)) {
            return None;
        }
        Some(match run_supervisor(arguments) {
            Ok(exit_code) => exit_code,
            Err(error) => {
                eprintln!("Xiao runtime supervisor failed: {error}");
                1
            }
        })
    }

    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
pub(crate) fn supervise_command(command: Command) -> Result<Command, String> {
    let program = command.get_program().to_os_string();
    let arguments = command
        .get_args()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let current_directory = command.get_current_dir().map(ToOwned::to_owned);
    let environment = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(ToOwned::to_owned)))
        .collect::<Vec<_>>();

    let mut supervised = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    supervised
        .arg(RUNTIME_SUPERVISOR_FLAG)
        .arg(program)
        .args(arguments);
    if let Some(current_directory) = current_directory {
        supervised.current_dir(current_directory);
    }
    for (key, value) in environment {
        match value {
            Some(value) => {
                supervised.env(key, value);
            }
            None => {
                supervised.env_remove(key);
            }
        }
    }
    Ok(supervised)
}

#[cfg(not(windows))]
pub(crate) fn supervise_command(command: Command) -> Result<Command, String> {
    Ok(command)
}

#[cfg(windows)]
fn run_supervisor(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<i32, String> {
    use std::io;
    use std::process::Stdio;
    use std::thread;

    let program = arguments
        .next()
        .ok_or("The runtime supervisor target is missing.")?;
    create_kill_on_close_job()?;

    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Could not start the supervised runtime: {error}"))?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or("The supervised runtime stdin is unavailable.")?;

    thread::Builder::new()
        .name("xiao-runtime-stdin".to_owned())
        .spawn(move || {
            let mut parent_stdin = io::stdin().lock();
            let exit_code = if io::copy(&mut parent_stdin, &mut child_stdin).is_ok() {
                0
            } else {
                1
            };
            // Exiting closes the only job handle and terminates the complete runtime tree.
            std::process::exit(exit_code);
        })
        .map_err(|error| format!("Could not monitor the Xiao runtime pipe: {error}"))?;

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for the supervised runtime: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<(), String> {
    use std::ffi::c_void;
    use std::mem::{forget, size_of};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    struct JobHandle(HANDLE);

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let job = JobHandle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err(format!(
            "Could not create the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(format!(
            "Could not configure the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { AssignProcessToJobObject(job.0, GetCurrentProcess()) } == 0 {
        return Err(format!(
            "Could not join the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    // This process is the sole owner. The OS closes the handle on every exit path,
    // which applies KILL_ON_JOB_CLOSE to Codex and any descendants it spawned.
    forget(job);
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn supervised_command_preserves_target_arguments_and_environment() {
        let mut target = Command::new("codex-test.exe");
        target
            .args(["app-server", "--stdio"])
            .env("XIAO_SUPERVISOR_TEST", "preserved");

        let supervised = supervise_command(target).unwrap();
        let arguments = supervised.get_args().collect::<Vec<_>>();

        assert_eq!(arguments[0], OsStr::new(RUNTIME_SUPERVISOR_FLAG));
        assert_eq!(arguments[1], OsStr::new("codex-test.exe"));
        assert_eq!(arguments[2], OsStr::new("app-server"));
        assert_eq!(arguments[3], OsStr::new("--stdio"));
        assert!(supervised.get_envs().any(|(key, value)| {
            key == OsStr::new("XIAO_SUPERVISOR_TEST") && value == Some(OsStr::new("preserved"))
        }));
    }
}
