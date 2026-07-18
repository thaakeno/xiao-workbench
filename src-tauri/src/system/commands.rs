use tauri::State;

use crate::agent::runtime::AgentRuntime;

use super::models::{CodexUpdateResult, CodexUpdateStatus, SystemInfo};
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
