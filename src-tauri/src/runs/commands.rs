use serde_json::Value;
use tauri::{AppHandle, State};

use crate::xiao::repository::XiaoRepository;

use super::models::{EnqueueRunRequest, PendingInputSnapshot, RunEventPage, RunSnapshot};
use super::service::RunService;

#[tauri::command]
pub fn enqueue_xiao_run(
    app: AppHandle,
    request: EnqueueRunRequest,
    service: State<'_, RunService>,
) -> Result<RunSnapshot, String> {
    service.enqueue(&app, request)
}

#[tauri::command]
pub fn list_xiao_runs(
    workspace_path: String,
    task_id: Option<String>,
    limit: Option<usize>,
    service: State<'_, RunService>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<RunSnapshot>, String> {
    service.list(&repository, &workspace_path, task_id.as_deref(), limit)
}

#[tauri::command]
pub fn list_xiao_pending_inputs(
    workspace_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<PendingInputSnapshot>, String> {
    repository.list_pending_inputs(&workspace_path, task_id.as_deref())
}

#[tauri::command]
pub fn load_xiao_run_events(
    run_id: String,
    after_sequence: Option<i64>,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<RunEventPage, String> {
    let events = repository.list_run_events(&run_id, after_sequence, limit)?;
    let next_sequence = events.last().map(|event| event.sequence);
    Ok(RunEventPage {
        events,
        next_sequence,
    })
}

#[tauri::command]
pub async fn cancel_xiao_run(
    app: AppHandle,
    run_id: String,
    service: State<'_, RunService>,
) -> Result<RunSnapshot, String> {
    service.cancel(&app, &run_id).await
}

#[tauri::command]
pub fn retry_xiao_run(
    app: AppHandle,
    run_id: String,
    idempotency_key: String,
    service: State<'_, RunService>,
) -> Result<RunSnapshot, String> {
    service.retry(&app, &run_id, &idempotency_key)
}

#[tauri::command]
pub async fn resolve_xiao_run_input(
    app: AppHandle,
    pending_input_id: String,
    result: Value,
    service: State<'_, RunService>,
) -> Result<RunSnapshot, String> {
    service.resolve_input(&app, &pending_input_id, result).await
}
