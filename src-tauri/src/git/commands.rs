use tauri::State;

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

use super::models::{GitBranch, GitSummary, GitWorktree};
use super::service::{
    apply_workspace_patch, create_workspace_checkpoint, create_worktree,
    discard_workspace_checkpoint, finish_workspace_checkpoint, list_branches, list_worktrees,
    read_git_comparison, run_git_action,
};

fn task_root(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    resolve_execution_context(repository, project_path, task_id)
        .map(|context| context.execution_root)
}

fn persisted_task_root(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    task_root(repository, project_path, Some(task_id))
}

#[tauri::command]
pub fn mutate_git(
    project_path: String,
    task_id: Option<String>,
    action: String,
    paths: Vec<String>,
    message: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let task_id = task_id
        .as_deref()
        .ok_or("This Git operation requires a persisted Xiao task.")?;
    let context = resolve_execution_context(&repository, &project_path, Some(task_id))?;
    if action == "switch"
        && context.workspace_mode == crate::xiao::models::XiaoWorkspaceMode::ManagedWorktree
    {
        return Err("Branch switching is disabled inside a Xiao-managed worktree.".to_owned());
    }
    run_git_action(&context.execution_root, &action, &paths, message.as_deref())
}

#[tauri::command]
pub fn get_git_branches(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<GitBranch>, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    list_branches(&root)
}

#[tauri::command]
pub fn compare_git_branch(
    project_path: String,
    task_id: Option<String>,
    base_branch: String,
    repository: State<'_, XiaoRepository>,
) -> Result<GitSummary, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    read_git_comparison(&root, &base_branch)
}

#[tauri::command]
pub fn get_git_worktrees(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<GitWorktree>, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    list_worktrees(&root)
}

#[tauri::command]
pub fn add_git_worktree(
    project_path: String,
    target_path: String,
    branch: String,
) -> Result<(), String> {
    create_worktree(&project_path, &target_path, &branch)
}

#[tauri::command]
pub fn apply_git_patch(
    project_path: String,
    task_id: Option<String>,
    patch: String,
    reverse: bool,
    check_only: bool,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    apply_workspace_patch(&root, &patch, reverse, check_only)
}

#[tauri::command]
pub fn create_git_checkpoint(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    create_workspace_checkpoint(&root)
}

#[tauri::command]
pub fn finish_git_checkpoint(
    project_path: String,
    task_id: Option<String>,
    token: String,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    finish_workspace_checkpoint(&root, &token)
}

#[tauri::command]
pub fn discard_git_checkpoint(token: String) -> Result<(), String> {
    discard_workspace_checkpoint(&token)
}
