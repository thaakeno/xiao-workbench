use tauri::{AppHandle, State};

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

use super::runtime::{TerminalManager, TerminalStartResult};

#[tauri::command]
pub fn start_terminal(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    project_path: String,
    task_id: Option<String>,
    shell: String,
    cols: u16,
    rows: u16,
    repository: State<'_, XiaoRepository>,
) -> Result<TerminalStartResult, String> {
    let persisted_task_id = task_id
        .as_deref()
        .ok_or("Terminal sessions require a persisted Xiao task.")?;
    let context = resolve_execution_context(&repository, &project_path, Some(persisted_task_id))?;
    manager.start(
        app,
        session_id,
        context.project_path,
        task_id,
        context.execution_root,
        shell,
        cols,
        rows,
    )
}

#[tauri::command]
pub fn write_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn stop_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id)
}
