mod agent;
mod browser;
mod execution;
mod git;
mod routines;
mod runs;
mod system;
mod terminal;
mod workspace;
mod xiao;

use agent::commands::{
    agent_request, list_agent_models, list_codex_threads_page, read_agent_account,
    read_agent_thread_usage, read_agent_usage, read_codex_rate_limits, read_codex_thread_turns,
    start_agent_runtime, stop_agent_runtime,
};
use agent::runtime::EnvironmentRuntimeRegistry;
use browser::commands::{
    get_browser_url, go_back_browser, go_forward_browser, navigate_browser, reload_browser,
    set_browser_muted,
};
use execution::commands::{
    get_xiao_execution_context, list_xiao_managed_worktrees, prepare_xiao_managed_worktree,
    remove_xiao_managed_worktree,
};
use git::commands::{
    add_git_worktree, apply_git_patch, compare_git_branch, create_git_checkpoint,
    discard_git_checkpoint, finish_git_checkpoint, get_git_branches, get_git_worktrees, mutate_git,
};
use routines::commands::{
    create_xiao_routine, delete_xiao_routine, list_xiao_routines, run_xiao_routine_now,
    set_xiao_routine_enabled, update_xiao_routine,
};
use routines::service::RoutineService;
use runs::commands::{
    cancel_xiao_run, enqueue_xiao_run, list_xiao_pending_inputs, list_xiao_runs,
    load_xiao_run_events, resolve_xiao_run_input, retry_xiao_run,
};
use runs::service::RunService;
use system::commands::{check_codex_update, get_system_info, send_desktop_notification, update_codex_cli};
use terminal::commands::{resize_terminal, start_terminal, stop_terminal, write_terminal};
use terminal::runtime::TerminalManager;
use workspace::commands::{get_workspace_snapshot, list_workspace_files, read_workspace_file};
use xiao::commands::{
    list_xiao_projects, load_xiao_timeline_page, load_xiao_workspace, open_xiao_project,
    read_xiao_contribution_summary, save_xiao_workspace,
};
use xiao::repository::XiaoRepository;

use tauri::Manager;

pub fn run_runtime_supervisor_if_requested() -> Option<i32> {
    agent::supervisor::run_if_requested()
}

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
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let app_data_dir = match std::env::var_os("XIAO_WORKBENCH_STATE_DIR") {
                Some(path) => {
                    let path = std::path::PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err("XIAO_WORKBENCH_STATE_DIR must be an absolute path.".into());
                    }
                    path
                }
                None => app_data_dir,
            };
            app.manage(XiaoRepository::initialize(app_data_dir));
            app.manage(EnvironmentRuntimeRegistry::default());
            app.manage(RunService::default());
            app.manage(RoutineService::default());
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            routines::service::configure_tray(app)?;
            app.state::<RunService>().start(app.handle().clone());
            app.state::<RoutineService>().start(app.handle().clone());
            Ok(())
        })
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            get_workspace_snapshot,
            get_xiao_execution_context,
            prepare_xiao_managed_worktree,
            list_xiao_managed_worktrees,
            remove_xiao_managed_worktree,
            list_workspace_files,
            read_workspace_file,
            get_system_info,
            check_codex_update,
            update_codex_cli,
            send_desktop_notification,
            start_agent_runtime,
            stop_agent_runtime,
            agent_request,
            read_agent_account,
            read_agent_usage,
            read_agent_thread_usage,
            list_codex_threads_page,
            read_codex_thread_turns,
            read_codex_rate_limits,
            list_agent_models,
            enqueue_xiao_run,
            list_xiao_runs,
            list_xiao_pending_inputs,
            load_xiao_run_events,
            cancel_xiao_run,
            retry_xiao_run,
            resolve_xiao_run_input,
            create_xiao_routine,
            update_xiao_routine,
            list_xiao_routines,
            set_xiao_routine_enabled,
            run_xiao_routine_now,
            delete_xiao_routine,
            mutate_git,
            get_git_branches,
            compare_git_branch,
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
            load_xiao_timeline_page,
            save_xiao_workspace,
            list_xiao_projects,
            read_xiao_contribution_summary,
            open_xiao_project,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Xiao Workbench");
}
