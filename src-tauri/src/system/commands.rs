use tauri::{Emitter, State};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::agent::runtime::AgentRuntime;

use super::models::{AutostartSettings, CodexUpdateResult, CodexUpdateStatus, SystemInfo, XiaoUpdateStatus};
use super::service::{check_codex_update as check_update, read_system_info, update_codex};

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    read_system_info()
}

#[tauri::command]
pub async fn check_codex_update() -> Result<CodexUpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(check_update)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_codex_cli(
    runtime: State<'_, AgentRuntime>,
) -> Result<CodexUpdateResult, String> {
    runtime.stop()?;
    tauri::async_runtime::spawn_blocking(update_codex)
        .await
        .map_err(|error| error.to_string())?
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "XiaoWorkbench";

#[tauri::command]
pub async fn get_autostart_settings() -> Result<AutostartSettings, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| {
        let output = std::process::Command::new("reg.exe")
            .args(["query", RUN_KEY, "/v", RUN_VALUE])
            .creation_flags(0x08000000)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(AutostartSettings { enabled: false, background: false });
        }
        let value = String::from_utf8_lossy(&output.stdout);
        Ok(AutostartSettings { enabled: true, background: value.contains("--background") })
    }).await.map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Ok(AutostartSettings { enabled: false, background: false })
}

#[tauri::command]
pub async fn set_autostart_settings(enabled: bool, background: bool) -> Result<AutostartSettings, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let status = if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let mut value = format!("\"{}\"", executable.display());
            if background { value.push_str(" --background"); }
            std::process::Command::new("reg.exe")
                .args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])
                .creation_flags(0x08000000).status()
        } else {
            std::process::Command::new("reg.exe")
                .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
                .creation_flags(0x08000000).status()
        }.map_err(|error| error.to_string())?;
        if !status.success() && enabled { return Err("Windows rejected the startup registration.".to_owned()); }
        Ok(AutostartSettings { enabled, background: enabled && background })
    }).await.map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Err("Automatic startup is currently available on Windows only.".to_owned())
}

#[derive(Clone, serde::Deserialize)]
struct ReleaseAuthor { login: String }
#[derive(Clone, serde::Deserialize)]
struct ReleaseAsset { name: String, browser_download_url: String, size: u64, digest: Option<String> }
#[derive(Clone, serde::Deserialize)]
struct XiaoRelease { tag_name: String, name: Option<String>, body: Option<String>, published_at: Option<String>, author: ReleaseAuthor, assets: Vec<ReleaseAsset> }

fn latest_xiao_release() -> Result<(XiaoRelease, ReleaseAsset), String> {
    let config = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(20))).build();
    let agent: ureq::Agent = config.into();
    let mut response = agent.get("https://api.github.com/repos/ryan-mt/xiao-workbench/releases/latest")
        .header("Accept", "application/vnd.github+json").header("User-Agent", "Xiao-Workbench-Updater")
        .call().map_err(|error| format!("Could not check Xiao updates: {error}"))?;
    let body = response.body_mut().read_to_string().map_err(|error| error.to_string())?;
    let release: XiaoRelease = serde_json::from_str(&body).map_err(|error| format!("Invalid release metadata: {error}"))?;
    if !release.author.login.eq_ignore_ascii_case("ryan-mt") { return Err("The release author did not match Xiao's trusted upstream publisher.".to_owned()); }
    let asset = release.assets.iter().find(|asset| asset.name.ends_with("-setup.exe") || asset.name.ends_with("_x64-setup.exe"))
        .cloned().ok_or("The release has no Windows installer.".to_owned())?;
    if !asset.digest.as_deref().is_some_and(|value| value.starts_with("sha256:")) { return Err("The release installer has no GitHub SHA-256 digest.".to_owned()); }
    Ok((release, asset))
}

#[tauri::command]
pub async fn check_xiao_update() -> Result<XiaoUpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (release, asset) = latest_xiao_release()?;
        let current = env!("CARGO_PKG_VERSION").to_owned();
        Ok(XiaoUpdateStatus {
            update_available: release.tag_name.trim_start_matches('v') != current,
            current_version: current, latest_version: release.tag_name.clone(),
            release_name: release.name.unwrap_or(release.tag_name), release_notes: release.body.unwrap_or_default(),
            published_at: release.published_at.unwrap_or_default(), installer_size: asset.size,
        })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_xiao_update(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Write};
        let (_, asset) = latest_xiao_release()?;
        let expected = asset.digest.as_deref().unwrap_or_default().trim_start_matches("sha256:").to_ascii_lowercase();
        let destination = std::env::temp_dir().join(format!("xiao-update-{}", asset.name));
        let config = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(300))).build();
        let agent: ureq::Agent = config.into();
        let mut response = agent.get(&asset.browser_download_url).header("User-Agent", "Xiao-Workbench-Updater").call().map_err(|error| error.to_string())?;
        let mut reader = response.body_mut().as_reader();
        let mut output = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new(); let mut buffer = [0u8; 64 * 1024]; let mut written = 0u64;
        loop { let count = reader.read(&mut buffer).map_err(|error| error.to_string())?; if count == 0 { break; }
            output.write_all(&buffer[..count]).map_err(|error| error.to_string())?; hasher.update(&buffer[..count]); written += count as u64;
            let _ = app.emit("xiao://update-progress", serde_json::json!({"downloaded": written, "total": asset.size}));
        }
        let actual = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        if actual != expected { let _ = std::fs::remove_file(&destination); return Err("Installer integrity verification failed.".to_owned()); }
        std::process::Command::new(&destination).args(["/S", "/UPDATE"]).creation_flags(0x08000000).spawn().map_err(|error| error.to_string())?;
        app.exit(0); Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn send_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let app_id = app.config().identifier.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let mut notification = notify_rust::Notification::new();
            notification.summary(&title).body(&body);
            notification.app_id(&app_id);
            let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("icons")
                .join("app-icon.png");
            notification.icon(&icon.to_string_lossy());
            notification.show().map(|_| ()).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
        Err("Native desktop notifications are not available on this platform yet.".to_owned())
    }
}
