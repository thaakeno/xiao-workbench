use std::path::Path;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::models::{
    XiaoProjectSummary, XiaoTimelinePage, XiaoWorkspaceDocument, XiaoWorkspaceUpdate,
};
use super::repository::XiaoRepository;

pub fn load_workspace(
    repository: &XiaoRepository,
    workspace_path: &str,
    include_active_timeline: bool,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    repository.load_workspace(workspace_path, include_active_timeline)
}

pub fn load_timeline_page(
    repository: &XiaoRepository,
    workspace_path: &str,
    task_id: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<XiaoTimelinePage, String> {
    repository.load_timeline_page(workspace_path, task_id, before, limit)
}

pub fn save_workspace(
    repository: &XiaoRepository,
    update: XiaoWorkspaceUpdate,
) -> Result<(), String> {
    repository.save_workspace(update)
}

pub fn list_projects(repository: &XiaoRepository) -> Result<Vec<XiaoProjectSummary>, String> {
    repository.list_projects()
}

pub fn open_project(path: &str) -> Result<(), String> {
    let directory = Path::new(path);
    if !directory.is_dir() {
        return Err(format!(
            "Xiao project path is not an existing directory: {}",
            directory.display()
        ));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new("explorer");
        command.arg(directory).creation_flags(CREATE_NO_WINDOW);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(directory);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(directory);
        command
    };

    command.spawn().map(|_| ()).map_err(|error| {
        format!(
            "Failed to open Xiao project directory {}: {error}",
            directory.display()
        )
    })
}
