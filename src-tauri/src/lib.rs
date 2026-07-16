mod agent;
mod browser;
mod git;
mod system;
mod terminal;
mod workspace;
mod xiao;

use agent::commands::{
    agent_reply, agent_request, list_agent_models, read_agent_account, read_agent_thread_usage,
    read_agent_usage, start_agent_runtime, start_xiao_session, stop_agent_runtime,
};
use agent::runtime::AgentRuntime;
use browser::commands::{
    get_browser_url, go_back_browser, go_forward_browser, navigate_browser, reload_browser,
    set_browser_muted,
};
use git::commands::{
    add_git_worktree, apply_git_patch, create_git_checkpoint, discard_git_checkpoint,
    finish_git_checkpoint, get_git_worktrees, mutate_git,
};
use system::commands::{check_codex_update, get_system_info, update_codex_cli};
use terminal::commands::{resize_terminal, start_terminal, stop_terminal, write_terminal};
use terminal::runtime::TerminalManager;
use workspace::commands::{get_workspace_snapshot, list_workspace_files, read_workspace_file};
use xiao::commands::{
    list_xiao_projects, load_xiao_workspace, open_xiao_project, save_xiao_workspace,
};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentRuntime::default())
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            get_workspace_snapshot,
            list_workspace_files,
            read_workspace_file,
            get_system_info,
            check_codex_update,
            update_codex_cli,
            start_agent_runtime,
            stop_agent_runtime,
            agent_request,
            agent_reply,
            read_agent_account,
            read_agent_usage,
            read_agent_thread_usage,
            list_agent_models,
            start_xiao_session,
            mutate_git,
            get_git_worktrees,
            add_git_worktree,
            apply_git_patch,
            create_git_checkpoint,
            finish_git_checkpoint,
            discard_git_checkpoint,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            navigate_browser,
            go_back_browser,
            go_forward_browser,
            reload_browser,
            get_browser_url,
            set_browser_muted,
            load_xiao_workspace,
            save_xiao_workspace,
            list_xiao_projects,
            open_xiao_project,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Xiao Workbench");
}
