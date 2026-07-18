use tauri::State;

use crate::terminal::runtime::TerminalManager;
use crate::xiao::repository::XiaoRepository;

use super::models::{ExecutionContext, ManagedWorktreeSummary};
use super::service;

#[tauri::command]
pub fn get_xiao_execution_context(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<ExecutionContext, String> {
    service::resolve_execution_context(&repository, &project_path, task_id.as_deref())
}

#[tauri::command]
pub fn prepare_xiao_managed_worktree(
    project_path: String,
    task_id: String,
    repository: State<'_, XiaoRepository>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<ExecutionContext, String> {
    let current = service::resolve_execution_context(&repository, &project_path, Some(&task_id))?;
    terminal_manager.stop_for_execution_change(&current.project_path, &task_id)?;
    service::prepare_managed_task_environment(&repository, &project_path, &task_id)
}

#[tauri::command]
pub fn list_xiao_managed_worktrees(
    project_path: String,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<ManagedWorktreeSummary>, String> {
    service::list_managed_worktrees(&repository, &project_path)
}

#[tauri::command]
pub fn remove_xiao_managed_worktree(
    project_path: String,
    task_id: String,
    worktree_id: String,
    confirmed: bool,
    repository: State<'_, XiaoRepository>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<ExecutionContext, String> {
    if !confirmed {
        return Err("Managed worktree cleanup requires explicit confirmation.".to_owned());
    }
    if let Ok(current) =
        service::resolve_execution_context(&repository, &project_path, Some(&task_id))
    {
        terminal_manager.stop_for_execution_change(&current.project_path, &task_id)?;
    }
    service::remove_managed_task_environment(
        &repository,
        &project_path,
        &task_id,
        &worktree_id,
        confirmed,
    )
}
