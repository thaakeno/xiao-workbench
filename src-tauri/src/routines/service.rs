use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::execution::service::{prepare_managed_task_environment, resolve_execution_context};
use crate::runs::models::{PendingInputSnapshot, RunRecord, RunStatus};
use crate::runs::repository::{new_uuid_v7, now_millis};
use crate::runs::service::RunService;
use crate::xiao::models::XiaoWorkspaceMode;
use crate::xiao::repository::XiaoRepository;

use super::models::{
    CreateRoutineRequest, NewRoutine, RoutineNotificationTarget, RoutineOccurrenceSummary,
    RoutineOpenRunTarget, RoutineRecord, RoutineReservation, RoutineScheduleKind, RoutineSummary,
    RoutineUpdateEnvelope, UpdateRoutineRequest,
};
use super::schedule;

const ON_TIME_GRACE_MS: i64 = 60_000;
const MAX_SCHEDULER_SLEEP: Duration = Duration::from_secs(60);
const ERROR_SCHEDULER_SLEEP: Duration = Duration::from_secs(5);
const MIN_SCHEDULER_SLEEP: Duration = Duration::from_millis(100);
const MAX_DUE_PER_WAKE: usize = 100;

pub struct RoutineService {
    notify: Arc<Notify>,
    worker_started: AtomicBool,
}

impl Default for RoutineService {
    fn default() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            worker_started: AtomicBool::new(false),
        }
    }
}

impl RoutineService {
    pub fn start(&self, app: AppHandle) {
        if self.worker_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let notify = Arc::clone(&self.notify);
        tauri::async_runtime::spawn(async move {
            loop {
                let healthy = process_due_routines(&app);
                let delay = if healthy {
                    scheduler_delay(&app).unwrap_or(MAX_SCHEDULER_SLEEP)
                } else {
                    ERROR_SCHEDULER_SLEEP
                };
                tokio::select! {
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        });
    }

    pub fn wake(&self) {
        self.notify.notify_one();
    }

    pub fn create(
        &self,
        app: &AppHandle,
        request: CreateRoutineRequest,
    ) -> Result<RoutineSummary, String> {
        let now = now_millis()?;
        let title = clean_title(&request.title, &request.prompt)?;
        let prompt = clean_prompt(&request.prompt)?;
        let (schedule_payload, next_run_at) = schedule::build_schedule(
            request.schedule_kind,
            &request.timezone,
            request.scheduled_for,
            request.daily_time.as_deref(),
            now,
        )?;
        let repository = app.state::<XiaoRepository>();
        let defaults = repository.run_task_defaults(&request.project_path, &request.task_id)?;
        require_dangerous_access_confirmation(
            &defaults.sandbox_mode,
            request.dangerous_access_confirmed,
        )?;
        let (context, isolation_warning) = resolve_context(
            app,
            &request.project_path,
            &request.task_id,
            request.prefer_isolation,
        )?;
        let record = repository.create_routine(NewRoutine {
            id: new_uuid_v7(),
            workspace_id: defaults.workspace_id,
            workspace_path: context.project_path,
            task_id: request.task_id,
            title,
            prompt,
            schedule_kind: request.schedule_kind,
            timezone: request.timezone,
            schedule_payload,
            missed_run_policy: request.missed_run_policy,
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: request.service_tier,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            execution_environment_id: context.environment.id,
            execution_root: context.execution_root,
            managed_worktree_id: context.managed_worktree.map(|worktree| worktree.id),
            next_run_at,
            isolation_warning,
            created_at: now,
        })?;
        let summary = summarize_routine(&repository, record)?;
        emit_routine_update(app, Some(summary.clone()), None);
        self.wake();
        Ok(summary)
    }

    pub fn update(
        &self,
        app: &AppHandle,
        request: UpdateRoutineRequest,
    ) -> Result<RoutineSummary, String> {
        let now = now_millis()?;
        let repository = app.state::<XiaoRepository>();
        let current = repository.get_routine_record(&request.routine_id)?;
        if current.deleted_at.is_some() {
            return Err("Deleted Xiao routines cannot be edited.".to_owned());
        }
        let title = clean_title(&request.title, &request.prompt)?;
        let prompt = clean_prompt(&request.prompt)?;
        let (schedule_payload, next_run_at) = schedule::build_schedule(
            request.schedule_kind,
            &request.timezone,
            request.scheduled_for,
            request.daily_time.as_deref(),
            now,
        )?;
        let defaults = repository.run_task_defaults(&current.workspace_path, &current.task_id)?;
        require_dangerous_access_confirmation(
            &defaults.sandbox_mode,
            request.dangerous_access_confirmed,
        )?;
        let (context, isolation_warning) = resolve_context(
            app,
            &current.workspace_path,
            &current.task_id,
            request.prefer_isolation,
        )?;
        let record = repository.update_routine(NewRoutine {
            id: current.id,
            workspace_id: current.workspace_id,
            workspace_path: current.workspace_path,
            task_id: current.task_id,
            title,
            prompt,
            schedule_kind: request.schedule_kind,
            timezone: request.timezone,
            schedule_payload,
            missed_run_policy: request.missed_run_policy,
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: request.service_tier,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            execution_environment_id: context.environment.id,
            execution_root: context.execution_root,
            managed_worktree_id: context.managed_worktree.map(|worktree| worktree.id),
            next_run_at,
            isolation_warning,
            created_at: now,
        })?;
        let summary = summarize_routine(&repository, record)?;
        emit_routine_update(app, Some(summary.clone()), None);
        self.wake();
        Ok(summary)
    }

    pub fn list(
        &self,
        repository: &XiaoRepository,
        workspace_path: &str,
    ) -> Result<Vec<RoutineSummary>, String> {
        repository
            .list_routine_records(workspace_path)?
            .into_iter()
            .map(|record| summarize_routine(repository, record))
            .collect()
    }

    pub fn set_enabled(
        &self,
        app: &AppHandle,
        routine_id: &str,
        enabled: bool,
    ) -> Result<RoutineSummary, String> {
        let now = now_millis()?;
        let repository = app.state::<XiaoRepository>();
        let current = repository.get_routine_record(routine_id)?;
        if current.deleted_at.is_some() {
            return Err("Deleted Xiao routines cannot be enabled.".to_owned());
        }
        let next_run_at = if enabled {
            match current.schedule_kind {
                RoutineScheduleKind::OneShot => current.schedule_payload.scheduled_for,
                RoutineScheduleKind::Daily => schedule::next_after(
                    current.schedule_kind,
                    &current.timezone,
                    &current.schedule_payload,
                    now.saturating_sub(1),
                )?,
            }
        } else {
            current.next_run_at
        };
        if enabled && next_run_at.is_none() {
            return Err(
                "The Xiao routine has no future schedule. Edit it before enabling.".to_owned(),
            );
        }
        let record = repository.set_routine_enabled(routine_id, enabled, next_run_at, now)?;
        let summary = summarize_routine(&repository, record)?;
        emit_routine_update(app, Some(summary.clone()), None);
        if enabled {
            self.wake();
        }
        Ok(summary)
    }

    pub fn run_now(
        &self,
        app: &AppHandle,
        routine_id: &str,
        idempotency_key: &str,
    ) -> Result<RoutineSummary, String> {
        let repository = app.state::<XiaoRepository>();
        let reservation = repository.run_routine_now(routine_id, idempotency_key, now_millis()?)?;
        let record = publish_reservation(app, reservation)?;
        summarize_routine(&repository, record)
    }

    pub fn delete(&self, app: &AppHandle, routine_id: &str) -> Result<(), String> {
        let repository = app.state::<XiaoRepository>();
        let record = repository.delete_routine(routine_id, now_millis()?)?;
        let _ = app.emit(
            "xiao://routine-update",
            RoutineUpdateEnvelope {
                workspace_path: record.workspace_path,
                routine: None,
                deleted_id: Some(record.id),
            },
        );
        self.wake();
        Ok(())
    }

    pub fn handle_run_update(
        &self,
        app: &AppHandle,
        run: &RunRecord,
        pending_input: Option<&PendingInputSnapshot>,
    ) {
        let Some(_) = run.routine_occurrence_id.as_ref() else {
            return;
        };
        let repository = app.state::<XiaoRepository>();
        match repository.routine_for_run(&run.id) {
            Ok(Some(record)) => match summarize_routine(&repository, record) {
                Ok(summary) => emit_routine_update(app, Some(summary), None),
                Err(error) => emit_service_error(app, &error),
            },
            Ok(None) => return,
            Err(error) => {
                emit_service_error(app, &error);
                return;
            }
        }

        let notification = if let Some(pending_input) = pending_input {
            if pending_input.resolved_at.is_none() && pending_input.invalidated_at.is_none() {
                Some((
                    format!("input:{}", pending_input.id),
                    "Xiao routine needs input".to_owned(),
                ))
            } else {
                None
            }
        } else {
            match run.status {
                RunStatus::Completed => Some((
                    format!("terminal:completed:{}", run.version),
                    "Xiao routine finished".to_owned(),
                )),
                RunStatus::Failed => Some((
                    format!("terminal:failed:{}", run.version),
                    "Xiao routine failed".to_owned(),
                )),
                RunStatus::Interrupted => Some((
                    format!("terminal:interrupted:{}", run.version),
                    "Xiao routine was interrupted".to_owned(),
                )),
                RunStatus::Cancelled => Some((
                    format!("terminal:cancelled:{}", run.version),
                    "Xiao routine was cancelled".to_owned(),
                )),
                RunStatus::NeedsAttention => Some((
                    format!("terminal:attention:{}", run.version),
                    "Xiao routine needs attention".to_owned(),
                )),
                _ => None,
            }
        };
        let Some((notification_key, title)) = notification else {
            return;
        };
        match repository.claim_routine_notification(&run.id, &notification_key) {
            Ok(Some(target)) => show_notification(app, &title, target),
            Ok(None) => {}
            Err(error) => emit_service_error(app, &error),
        }
    }
}

fn resolve_context(
    app: &AppHandle,
    project_path: &str,
    task_id: &str,
    prefer_isolation: bool,
) -> Result<(crate::execution::models::ExecutionContext, Option<String>), String> {
    let repository = app.state::<XiaoRepository>();
    let mut context = resolve_execution_context(&repository, project_path, Some(task_id))?;
    let mut isolation_warning = None;
    if prefer_isolation && context.workspace_mode == XiaoWorkspaceMode::Local {
        if context.isolation_available {
            context = prepare_managed_task_environment(&repository, project_path, task_id)?;
        } else {
            isolation_warning = Some(
                context
                    .isolation_unavailable_reason
                    .clone()
                    .unwrap_or_else(|| "Managed worktree isolation is unavailable.".to_owned()),
            );
        }
    }
    Ok((context, isolation_warning))
}

fn require_dangerous_access_confirmation(
    sandbox_mode: &str,
    confirmed: bool,
) -> Result<(), String> {
    if sandbox_mode == "danger-full-access" && !confirmed {
        return Err(
            "Creating a danger-full-access routine requires explicit confirmation.".to_owned(),
        );
    }
    Ok(())
}

fn clean_title(title: &str, prompt: &str) -> Result<String, String> {
    let title = title.trim();
    if !title.is_empty() {
        return Ok(title.to_owned());
    }
    let prompt = clean_prompt(prompt)?;
    Ok(prompt.chars().take(72).collect())
}

fn clean_prompt(prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("A prompt is required for a Xiao routine.".to_owned());
    }
    Ok(prompt.to_owned())
}

fn process_due_routines(app: &AppHandle) -> bool {
    for _ in 0..MAX_DUE_PER_WAKE {
        let reservation = {
            let repository = app.state::<XiaoRepository>();
            repository.reserve_due_routine(now_millis().unwrap_or_default(), ON_TIME_GRACE_MS)
        };
        match reservation {
            Ok(Some(reservation)) => {
                if let Err(error) = publish_reservation(app, reservation) {
                    emit_service_error(app, &error);
                    return false;
                }
            }
            Ok(None) => return true,
            Err(error) => {
                emit_service_error(app, &error);
                return false;
            }
        }
    }
    true
}

fn publish_reservation(
    app: &AppHandle,
    reservation: RoutineReservation,
) -> Result<RoutineRecord, String> {
    let record = match reservation {
        RoutineReservation::Dispatched { routine, run, .. } => {
            app.state::<RunService>().publish_enqueued(app, &run);
            routine
        }
        RoutineReservation::Skipped { routine, .. }
        | RoutineReservation::Disabled { routine }
        | RoutineReservation::Unchanged { routine } => routine,
    };
    let summary = summarize_routine(&app.state::<XiaoRepository>(), record.clone())?;
    emit_routine_update(app, Some(summary), None);
    Ok(record)
}

fn scheduler_delay(app: &AppHandle) -> Result<Duration, String> {
    let next = app.state::<XiaoRepository>().next_routine_wake_at()?;
    let Some(next) = next else {
        return Ok(MAX_SCHEDULER_SLEEP);
    };
    let now = now_millis()?;
    let millis = next.saturating_sub(now).max(0) as u64;
    Ok(Duration::from_millis(millis).clamp(MIN_SCHEDULER_SLEEP, MAX_SCHEDULER_SLEEP))
}

fn summarize_routine(
    repository: &XiaoRepository,
    record: RoutineRecord,
) -> Result<RoutineSummary, String> {
    let occurrences = repository.list_routine_occurrences(&record.id, None)?;
    let mut history = Vec::with_capacity(occurrences.len());
    for occurrence in occurrences {
        let run = occurrence
            .run_id
            .as_deref()
            .map(|run_id| repository.get_run(run_id).map(|run| run.snapshot()))
            .transpose()?;
        history.push(RoutineOccurrenceSummary {
            id: occurrence.id,
            scheduled_for: occurrence.scheduled_for,
            trigger_kind: occurrence.trigger_kind,
            status: occurrence.status,
            run,
        });
    }
    let last_status = history
        .iter()
        .find_map(|occurrence| occurrence.run.as_ref().map(|run| run.status));
    let workspace_mode = if record.managed_worktree_id.is_some() {
        XiaoWorkspaceMode::ManagedWorktree
    } else {
        XiaoWorkspaceMode::Local
    };
    Ok(RoutineSummary {
        id: record.id,
        workspace_path: record.workspace_path,
        task_id: record.task_id,
        title: record.title,
        prompt: record.prompt,
        schedule_kind: record.schedule_kind,
        timezone: record.timezone,
        scheduled_for: record.schedule_payload.scheduled_for,
        daily_time: schedule::daily_time(&record.schedule_payload),
        missed_run_policy: record.missed_run_policy,
        model: record.model,
        reasoning_effort: record.reasoning_effort,
        service_tier: record.service_tier,
        mode: record.mode,
        approval_policy: record.approval_policy,
        sandbox_mode: record.sandbox_mode,
        execution_environment_id: record.execution_environment_id,
        execution_root: record.execution_root,
        managed_worktree_id: record.managed_worktree_id,
        workspace_mode,
        enabled: record.enabled,
        next_run_at: record.next_run_at,
        last_run_at: record.last_run_at,
        last_error: record.last_error,
        isolation_warning: record.isolation_warning,
        last_status,
        history,
        version: record.version,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

fn emit_routine_update(
    app: &AppHandle,
    routine: Option<RoutineSummary>,
    deleted_id: Option<String>,
) {
    let workspace_path = routine
        .as_ref()
        .map(|routine| routine.workspace_path.clone())
        .unwrap_or_default();
    let _ = app.emit(
        "xiao://routine-update",
        RoutineUpdateEnvelope {
            workspace_path,
            routine,
            deleted_id,
        },
    );
}

fn emit_service_error(app: &AppHandle, error: &str) {
    let _ = app.emit("xiao://routine-service-error", error.to_owned());
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_notification_target(app: &AppHandle, target: RoutineOpenRunTarget) {
    show_main_window(app);
    let _ = app.emit("xiao://routine-open-run", target);
}

#[cfg(windows)]
fn show_notification(app: &AppHandle, title: &str, target: RoutineNotificationTarget) {
    use notify_rust::{Notification, NotificationResponse};

    let mut notification = Notification::new();
    notification
        .summary(title)
        .body(&format!(
            "{}\n{}",
            target.routine_title,
            truncate_text(&target.prompt, 160)
        ))
        .action("open", "Open run");
    if !cfg!(debug_assertions) {
        notification.app_id(&app.config().identifier);
    }
    match notification.show() {
        Ok(handle) => {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle.wait_for_response(move |response: &NotificationResponse| {
                    let should_open = match response {
                        NotificationResponse::Default => true,
                        NotificationResponse::Action(action) => action == "open",
                        NotificationResponse::Reply(_) | NotificationResponse::Closed(_) => false,
                    };
                    if should_open {
                        open_notification_target(&app, target.route);
                    }
                });
            });
        }
        Err(error) => emit_service_error(
            app,
            &format!("Could not show routine notification: {error}"),
        ),
    }
}

#[cfg(not(windows))]
fn show_notification(app: &AppHandle, _title: &str, target: RoutineNotificationTarget) {
    let _ = app.emit("xiao://routine-notification", target.route);
}

fn truncate_text(value: &str, limit: usize) -> String {
    let mut characters = value.chars();
    let truncated = characters.by_ref().take(limit).collect::<String>();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn configure_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "tray-open", "Open Xiao", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Xiao", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("xiao-main")
        .menu(&menu)
        .tooltip("Xiao Workbench: routines run while Xiao is in the tray")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routine_notification_text_is_bounded() {
        let value = "a".repeat(200);
        let truncated = truncate_text(&value, 160);
        assert_eq!(truncated.chars().count(), 161);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn scheduler_delay_is_bounded_by_constants() {
        assert!(MIN_SCHEDULER_SLEEP < MAX_SCHEDULER_SLEEP);
        assert_eq!(ON_TIME_GRACE_MS, 60_000);
    }
}
