use tauri::State;

use super::models::{
    XiaoProjectSummary, XiaoTimelinePage, XiaoWorkspaceDocument, XiaoWorkspaceUpdate,
};
use super::repository::XiaoRepository;
use super::service;

#[tauri::command]
pub fn load_xiao_workspace(
    workspace_path: String,
    include_active_timeline: Option<bool>,
    repository: State<'_, XiaoRepository>,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    service::load_workspace(
        &repository,
        &workspace_path,
        include_active_timeline.unwrap_or(true),
    )
}

#[tauri::command]
pub fn load_xiao_timeline_page(
    workspace_path: String,
    task_id: String,
    before: Option<usize>,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<XiaoTimelinePage, String> {
    service::load_timeline_page(&repository, &workspace_path, &task_id, before, limit)
}

#[tauri::command]
pub fn save_xiao_workspace(
    update: XiaoWorkspaceUpdate,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    service::save_workspace(&repository, update)
}

#[tauri::command]
pub fn list_xiao_projects(
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<XiaoProjectSummary>, String> {
    service::list_projects(&repository)
}

#[tauri::command]
pub fn open_xiao_project(path: String) -> Result<(), String> {
    service::open_project(&path)
}
