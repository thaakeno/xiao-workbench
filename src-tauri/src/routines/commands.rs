use tauri::{AppHandle, State};

use crate::xiao::repository::XiaoRepository;

use super::models::{CreateRoutineRequest, RoutineSummary, UpdateRoutineRequest};
use super::service::RoutineService;

#[tauri::command]
pub fn create_xiao_routine(
    app: AppHandle,
    request: CreateRoutineRequest,
    service: State<'_, RoutineService>,
) -> Result<RoutineSummary, String> {
    service.create(&app, request)
}

#[tauri::command]
pub fn update_xiao_routine(
    app: AppHandle,
    request: UpdateRoutineRequest,
    service: State<'_, RoutineService>,
) -> Result<RoutineSummary, String> {
    service.update(&app, request)
}

#[tauri::command]
pub fn list_xiao_routines(
    workspace_path: String,
    service: State<'_, RoutineService>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<RoutineSummary>, String> {
    service.list(&repository, &workspace_path)
}

#[tauri::command]
pub fn set_xiao_routine_enabled(
    app: AppHandle,
    routine_id: String,
    enabled: bool,
    service: State<'_, RoutineService>,
) -> Result<RoutineSummary, String> {
    service.set_enabled(&app, &routine_id, enabled)
}

#[tauri::command]
pub fn run_xiao_routine_now(
    app: AppHandle,
    routine_id: String,
    idempotency_key: String,
    service: State<'_, RoutineService>,
) -> Result<RoutineSummary, String> {
    service.run_now(&app, &routine_id, &idempotency_key)
}

#[tauri::command]
pub fn delete_xiao_routine(
    app: AppHandle,
    routine_id: String,
    service: State<'_, RoutineService>,
) -> Result<(), String> {
    service.delete(&app, &routine_id)
}
