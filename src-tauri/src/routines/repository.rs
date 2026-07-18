use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::{json, Value};

use crate::runs::models::NewRun;
use crate::runs::repository::{bounded_diagnostic, new_uuid_v7};
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{
    MissedRunPolicy, NewRoutine, RoutineNotificationTarget, RoutineOccurrenceRecord,
    RoutineOccurrenceStatus, RoutineOpenRunTarget, RoutineRecord, RoutineReservation,
    RoutineScheduleKind, RoutineTriggerKind,
};
use super::schedule;

const MAX_ROUTINE_TITLE_BYTES: usize = 512;
const MAX_ROUTINE_PROMPT_BYTES: usize = 64 * 1024;
const MAX_ROUTINE_IDENTITY_BYTES: usize = 512;
const DEFAULT_HISTORY_LIMIT: usize = 5;
const MAX_HISTORY_LIMIT: usize = 20;

const ROUTINE_SELECT: &str = r#"
SELECT
    r.id, r.workspace_id, w.workspace_path, r.task_id, r.title, r.prompt,
    r.schedule_kind, r.timezone, r.schedule_payload_json, r.missed_run_policy,
    r.model, r.reasoning_effort, r.service_tier, r.mode, r.approval_policy,
    r.sandbox_mode, r.goal_json, r.execution_environment_id, r.execution_root,
    r.managed_worktree_id, r.enabled, r.next_run_at, r.last_run_at,
    r.last_error, r.isolation_warning, r.version, r.created_at, r.updated_at,
    r.deleted_at
FROM routines r
JOIN workspaces w ON w.id = r.workspace_id
"#;

impl XiaoRepository {
    pub(crate) fn create_routine(&self, routine: NewRoutine) -> Result<RoutineRecord, String> {
        validate_new_routine(&routine)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao routine creation: {error}"))?;
            validate_new_routine_task(&transaction, &routine)?;
            let payload = json_string(&routine.schedule_payload, "routine schedule")?;
            let goal = optional_json_string(routine.goal.as_ref(), "routine goal")?;
            transaction
                .execute(
                    r#"INSERT INTO routines(
                        id, workspace_id, task_id, title, prompt, schedule_kind,
                        timezone, schedule_payload_json, missed_run_policy, model,
                        reasoning_effort, service_tier, mode, approval_policy,
                        sandbox_mode, goal_json, execution_environment_id,
                        execution_root, managed_worktree_id, enabled, next_run_at,
                        last_run_at, last_error, isolation_warning, version,
                        created_at, updated_at, deleted_at
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                        ?13, ?14, ?15, ?16, ?17, ?18, ?19, 1, ?20,
                        NULL, NULL, ?21, 0, ?22, ?22, NULL
                     )"#,
                    params![
                        routine.id,
                        routine.workspace_id,
                        routine.task_id,
                        routine.title,
                        routine.prompt,
                        routine.schedule_kind.as_database(),
                        routine.timezone,
                        payload,
                        routine.missed_run_policy.as_database(),
                        routine.model,
                        routine.reasoning_effort,
                        routine.service_tier,
                        routine.mode,
                        routine.approval_policy,
                        routine.sandbox_mode,
                        goal,
                        routine.execution_environment_id,
                        routine.execution_root,
                        routine.managed_worktree_id,
                        routine.next_run_at,
                        routine.isolation_warning,
                        routine.created_at,
                    ],
                )
                .map_err(|error| format!("Could not create Xiao routine: {error}"))?;
            let record = load_routine(&transaction, &routine.id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao routine creation: {error}"))?;
            Ok(record)
        })
    }

    pub(crate) fn update_routine(&self, routine: NewRoutine) -> Result<RoutineRecord, String> {
        validate_new_routine(&routine)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao routine update: {error}"))?;
            let current = load_routine(&transaction, &routine.id)?;
            if current.deleted_at.is_some() {
                return Err("Deleted Xiao routines cannot be edited.".to_owned());
            }
            if current.workspace_id != routine.workspace_id || current.task_id != routine.task_id {
                return Err("The Xiao routine task binding cannot be changed.".to_owned());
            }
            validate_new_routine_task(&transaction, &routine)?;
            let payload = json_string(&routine.schedule_payload, "routine schedule")?;
            let goal = optional_json_string(routine.goal.as_ref(), "routine goal")?;
            transaction
                .execute(
                    r#"UPDATE routines SET
                        title = ?1, prompt = ?2, schedule_kind = ?3, timezone = ?4,
                        schedule_payload_json = ?5, missed_run_policy = ?6,
                        model = ?7, reasoning_effort = ?8, service_tier = ?9,
                        mode = ?10, approval_policy = ?11, sandbox_mode = ?12,
                        goal_json = ?13, execution_environment_id = ?14,
                        execution_root = ?15, managed_worktree_id = ?16,
                        next_run_at = ?17, last_error = NULL, isolation_warning = ?18,
                        version = version + 1, updated_at = ?19
                     WHERE id = ?20 AND deleted_at IS NULL"#,
                    params![
                        routine.title,
                        routine.prompt,
                        routine.schedule_kind.as_database(),
                        routine.timezone,
                        payload,
                        routine.missed_run_policy.as_database(),
                        routine.model,
                        routine.reasoning_effort,
                        routine.service_tier,
                        routine.mode,
                        routine.approval_policy,
                        routine.sandbox_mode,
                        goal,
                        routine.execution_environment_id,
                        routine.execution_root,
                        routine.managed_worktree_id,
                        routine.next_run_at,
                        routine.isolation_warning,
                        routine.created_at,
                        routine.id,
                    ],
                )
                .map_err(|error| format!("Could not update Xiao routine: {error}"))?;
            let record = load_routine(&transaction, &routine.id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao routine update: {error}"))?;
            Ok(record)
        })
    }

    pub(crate) fn get_routine_record(&self, routine_id: &str) -> Result<RoutineRecord, String> {
        self.with_connection(|connection| load_routine(connection, routine_id))
    }

    pub(crate) fn list_routine_records(
        &self,
        workspace_path: &str,
    ) -> Result<Vec<RoutineRecord>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let sql = format!(
                r#"{ROUTINE_SELECT}
                   WHERE w.workspace_path = ?1 AND r.deleted_at IS NULL
                   ORDER BY r.enabled DESC, r.updated_at DESC, r.id DESC"#
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Xiao routine list: {error}"))?;
            let rows = statement
                .query_map([workspace_path], routine_from_row)
                .map_err(|error| format!("Could not query Xiao routines: {error}"))?;
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao routine: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn list_routine_occurrences(
        &self,
        routine_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<RoutineOccurrenceRecord>, String> {
        let limit = limit
            .unwrap_or(DEFAULT_HISTORY_LIMIT)
            .clamp(1, MAX_HISTORY_LIMIT) as i64;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    r#"SELECT id, routine_id, scheduled_for, idempotency_key,
                        trigger_kind, status, run_id, last_notification_key, created_at
                     FROM routine_occurrences WHERE routine_id = ?1
                     ORDER BY scheduled_for DESC, id DESC LIMIT ?2"#,
                )
                .map_err(|error| {
                    format!("Could not prepare routine occurrence history: {error}")
                })?;
            let rows = statement
                .query_map(params![routine_id, limit], occurrence_from_row)
                .map_err(|error| format!("Could not query routine occurrence history: {error}"))?;
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode routine occurrence: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn set_routine_enabled(
        &self,
        routine_id: &str,
        enabled: bool,
        next_run_at: Option<i64>,
        timestamp: i64,
    ) -> Result<RoutineRecord, String> {
        self.with_connection(|connection| {
            if enabled {
                if let Some(next_run_at) = next_run_at {
                    let settled = connection
                        .query_row(
                            r#"SELECT 1 FROM routine_occurrences
                             WHERE routine_id = ?1 AND scheduled_for = ?2
                               AND trigger_kind = 'automatic'"#,
                            params![routine_id, next_run_at],
                            |_| Ok(()),
                        )
                        .optional()
                        .map_err(|error| {
                            format!("Could not inspect settled routine schedule: {error}")
                        })?
                        .is_some();
                    if settled {
                        return Err(
                            "This one-shot occurrence is already settled. Edit its schedule before enabling it again."
                                .to_owned(),
                        );
                    }
                }
            }
            let changed = connection
                .execute(
                    r#"UPDATE routines SET enabled = ?1,
                        next_run_at = CASE WHEN ?1 = 1 THEN ?2 ELSE next_run_at END,
                        last_error = CASE WHEN ?1 = 1 THEN NULL ELSE last_error END,
                        version = version + 1, updated_at = ?3
                     WHERE id = ?4 AND deleted_at IS NULL"#,
                    params![bool_to_i64(enabled), next_run_at, timestamp, routine_id],
                )
                .map_err(|error| format!("Could not change Xiao routine state: {error}"))?;
            if changed != 1 {
                return Err("The Xiao routine was not found.".to_owned());
            }
            load_routine(connection, routine_id)
        })
    }

    pub(crate) fn delete_routine(
        &self,
        routine_id: &str,
        timestamp: i64,
    ) -> Result<RoutineRecord, String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    r#"UPDATE routines SET enabled = 0, next_run_at = NULL,
                        deleted_at = ?1, updated_at = ?1, version = version + 1
                     WHERE id = ?2 AND deleted_at IS NULL"#,
                    params![timestamp, routine_id],
                )
                .map_err(|error| format!("Could not delete Xiao routine: {error}"))?;
            if changed != 1 {
                return Err("The Xiao routine was not found.".to_owned());
            }
            load_routine(connection, routine_id)
        })
    }

    pub(crate) fn next_routine_wake_at(&self) -> Result<Option<i64>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    r#"SELECT MIN(next_run_at) FROM routines
                     WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at IS NOT NULL"#,
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not read the next Xiao routine wake: {error}"))
        })
    }

    pub(crate) fn reserve_due_routine(
        &self,
        now: i64,
        on_time_grace_ms: i64,
    ) -> Result<Option<RoutineReservation>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao routine reservation: {error}"))?;
            let routine_id = transaction
                .query_row(
                    r#"SELECT id FROM routines
                     WHERE enabled = 1 AND deleted_at IS NULL
                       AND next_run_at IS NOT NULL AND next_run_at <= ?1
                     ORDER BY next_run_at, id LIMIT 1"#,
                    [now],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("Could not find a due Xiao routine: {error}"))?;
            let Some(routine_id) = routine_id else {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish routine due check: {error}"))?;
                return Ok(None);
            };
            let routine = load_routine(&transaction, &routine_id)?;
            if !routine_binding_matches(&transaction, &routine)? {
                let routine = disable_routine_for_binding_change(&transaction, &routine, now)?;
                transaction
                    .commit()
                    .map_err(|error| format!("Could not commit disabled stale routine: {error}"))?;
                return Ok(Some(RoutineReservation::Disabled { routine }));
            }

            let scheduled_for = routine
                .next_run_at
                .ok_or("The due Xiao routine has no next occurrence.")?;
            let next_run_at = match schedule::next_after(
                routine.schedule_kind,
                &routine.timezone,
                &routine.schedule_payload,
                now,
            ) {
                Ok(next_run_at) => next_run_at,
                Err(error) => {
                    let routine = disable_routine_with_error(
                        &transaction,
                        &routine,
                        &format!("Could not advance the routine schedule: {error}"),
                        now,
                    )?;
                    transaction.commit().map_err(|commit_error| {
                        format!("Could not commit invalid routine disable: {commit_error}")
                    })?;
                    return Ok(Some(RoutineReservation::Disabled { routine }));
                }
            };
            let enabled_after = next_run_at.is_some();
            let idempotency_key = automatic_idempotency_key(&routine.id, scheduled_for);
            if load_occurrence_by_key(&transaction, &idempotency_key)?.is_some() {
                update_routine_after_occurrence(
                    &transaction,
                    &routine.id,
                    enabled_after,
                    next_run_at,
                    None,
                    now,
                )?;
                let routine = load_routine(&transaction, &routine.id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not reconcile duplicate routine occurrence: {error}")
                })?;
                return Ok(Some(RoutineReservation::Unchanged { routine }));
            }

            let should_dispatch = routine.missed_run_policy == MissedRunPolicy::RunOnce
                || now.saturating_sub(scheduled_for) <= on_time_grace_ms;
            let occurrence_id = new_uuid_v7();
            if !should_dispatch {
                insert_occurrence(
                    &transaction,
                    NewOccurrence {
                        id: &occurrence_id,
                        routine_id: &routine.id,
                        scheduled_for,
                        idempotency_key: &idempotency_key,
                        trigger_kind: RoutineTriggerKind::Automatic,
                        status: RoutineOccurrenceStatus::Skipped,
                        created_at: now,
                    },
                )?;
                update_routine_after_occurrence(
                    &transaction,
                    &routine.id,
                    enabled_after,
                    next_run_at,
                    None,
                    now,
                )?;
                let routine = load_routine(&transaction, &routine.id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit skipped routine occurrence: {error}")
                })?;
                return Ok(Some(RoutineReservation::Skipped { routine }));
            }

            insert_occurrence(
                &transaction,
                NewOccurrence {
                    id: &occurrence_id,
                    routine_id: &routine.id,
                    scheduled_for,
                    idempotency_key: &idempotency_key,
                    trigger_kind: RoutineTriggerKind::Automatic,
                    status: RoutineOccurrenceStatus::Reserved,
                    created_at: now,
                },
            )?;
            let run = XiaoRepository::enqueue_run_in_transaction(
                &transaction,
                &new_run_for_occurrence(&routine, &occurrence_id, &idempotency_key, now),
            )?;
            if let Err(error) =
                require_occurrence_run(&run.run.routine_occurrence_id, &occurrence_id)
            {
                transaction
                    .execute(
                        "DELETE FROM routine_occurrences WHERE id = ?1",
                        [&occurrence_id],
                    )
                    .map_err(|delete_error| {
                        format!("Could not release conflicting routine occurrence: {delete_error}")
                    })?;
                let routine = disable_routine_with_error(&transaction, &routine, &error, now)?;
                transaction.commit().map_err(|commit_error| {
                    format!("Could not commit conflicting routine disable: {commit_error}")
                })?;
                return Ok(Some(RoutineReservation::Disabled { routine }));
            }
            mark_occurrence_dispatched(&transaction, &occurrence_id, &run.run.id)?;
            update_routine_after_occurrence(
                &transaction,
                &routine.id,
                enabled_after,
                next_run_at,
                Some(scheduled_for),
                now,
            )?;
            let routine = load_routine(&transaction, &routine.id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit routine dispatch: {error}"))?;
            Ok(Some(RoutineReservation::Dispatched {
                routine,
                run: Box::new(run),
            }))
        })
    }

    pub(crate) fn run_routine_now(
        &self,
        routine_id: &str,
        request_key: &str,
        now: i64,
    ) -> Result<RoutineReservation, String> {
        if request_key.trim().is_empty() || request_key.len() > 128 {
            return Err("A valid routine run-now idempotency key is required.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start routine run-now: {error}"))?;
            let routine = load_routine(&transaction, routine_id)?;
            if routine.deleted_at.is_some() {
                return Err("Deleted Xiao routines cannot run.".to_owned());
            }
            if !routine_binding_matches(&transaction, &routine)? {
                let routine = disable_routine_for_binding_change(&transaction, &routine, now)?;
                transaction
                    .commit()
                    .map_err(|error| format!("Could not commit disabled stale routine: {error}"))?;
                return Ok(RoutineReservation::Disabled { routine });
            }
            let idempotency_key = format!("routine:{}:manual:{request_key}", routine.id);
            let existing = load_occurrence_by_key(&transaction, &idempotency_key)?;
            if existing
                .as_ref()
                .is_some_and(|occurrence| occurrence.run_id.is_some())
            {
                let routine = load_routine(&transaction, &routine.id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish duplicate routine run-now: {error}")
                })?;
                return Ok(RoutineReservation::Unchanged { routine });
            }
            let (occurrence_id, scheduled_for) = match existing {
                Some(existing) => (existing.id, existing.scheduled_for),
                None => {
                    let occurrence_id = new_uuid_v7();
                    let scheduled_for = available_manual_time(&transaction, &routine.id, now)?;
                    insert_occurrence(
                        &transaction,
                        NewOccurrence {
                            id: &occurrence_id,
                            routine_id: &routine.id,
                            scheduled_for,
                            idempotency_key: &idempotency_key,
                            trigger_kind: RoutineTriggerKind::Manual,
                            status: RoutineOccurrenceStatus::Reserved,
                            created_at: now,
                        },
                    )?;
                    (occurrence_id, scheduled_for)
                }
            };
            let run = XiaoRepository::enqueue_run_in_transaction(
                &transaction,
                &new_run_for_occurrence(&routine, &occurrence_id, &idempotency_key, now),
            )?;
            require_occurrence_run(&run.run.routine_occurrence_id, &occurrence_id)?;
            mark_occurrence_dispatched(&transaction, &occurrence_id, &run.run.id)?;
            transaction
                .execute(
                    r#"UPDATE routines SET last_run_at = ?1, last_error = NULL,
                        version = version + 1, updated_at = ?2 WHERE id = ?3"#,
                    params![scheduled_for, now, routine.id],
                )
                .map_err(|error| format!("Could not update run-now routine: {error}"))?;
            let routine = load_routine(&transaction, &routine.id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit routine run-now: {error}"))?;
            Ok(RoutineReservation::Dispatched {
                routine,
                run: Box::new(run),
            })
        })
    }

    pub(crate) fn routine_for_run(&self, run_id: &str) -> Result<Option<RoutineRecord>, String> {
        self.with_connection(|connection| {
            let sql = format!(
                r#"{ROUTINE_SELECT}
                   JOIN routine_occurrences o ON o.routine_id = r.id
                   WHERE o.run_id = ?1"#
            );
            connection
                .query_row(&sql, [run_id], routine_from_row)
                .optional()
                .map_err(|error| format!("Could not find the Xiao routine run: {error}"))?
                .map(StoredRoutineRow::decode)
                .transpose()
        })
    }

    pub(crate) fn claim_routine_notification(
        &self,
        run_id: &str,
        notification_key: &str,
    ) -> Result<Option<RoutineNotificationTarget>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start routine notification claim: {error}"))?;
            let row = transaction
                .query_row(
                    r#"SELECT o.id, o.last_notification_key, r.id, r.workspace_id,
                        w.workspace_path, r.task_id, r.title, r.prompt
                     FROM routine_occurrences o
                     JOIN routines r ON r.id = o.routine_id
                     JOIN workspaces w ON w.id = r.workspace_id
                     WHERE o.run_id = ?1"#,
                    [run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("Could not inspect routine notification: {error}"))?;
            let Some((
                occurrence_id,
                current_key,
                routine_id,
                _workspace_id,
                workspace_path,
                task_id,
                title,
                prompt,
            )) = row
            else {
                transaction.commit().map_err(|error| {
                    format!("Could not finish non-routine notification check: {error}")
                })?;
                return Ok(None);
            };
            if current_key.as_deref() == Some(notification_key) {
                transaction.commit().map_err(|error| {
                    format!("Could not finish duplicate notification check: {error}")
                })?;
                return Ok(None);
            }
            transaction
                .execute(
                    "UPDATE routine_occurrences SET last_notification_key = ?1 WHERE id = ?2",
                    params![notification_key, occurrence_id],
                )
                .map_err(|error| format!("Could not claim routine notification: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit routine notification: {error}"))?;
            Ok(Some(RoutineNotificationTarget {
                route: RoutineOpenRunTarget {
                    workspace_path,
                    task_id,
                    routine_id,
                    run_id: run_id.to_owned(),
                },
                routine_title: title,
                prompt,
            }))
        })
    }
}

fn validate_new_routine(routine: &NewRoutine) -> Result<(), String> {
    if routine.id.trim().is_empty()
        || routine.task_id.trim().is_empty()
        || routine.title.trim().is_empty()
        || routine.prompt.trim().is_empty()
        || routine.timezone.trim().is_empty()
        || routine.execution_environment_id.trim().is_empty()
        || routine.execution_root.trim().is_empty()
    {
        return Err(
            "A Xiao routine requires identity, task, schedule and execution context.".to_owned(),
        );
    }
    if routine.id.len() > MAX_ROUTINE_IDENTITY_BYTES
        || routine.task_id.len() > MAX_ROUTINE_IDENTITY_BYTES
        || routine.execution_environment_id.len() > MAX_ROUTINE_IDENTITY_BYTES
    {
        return Err("Xiao routine identity exceeds the 512-byte limit.".to_owned());
    }
    if routine.title.len() > MAX_ROUTINE_TITLE_BYTES {
        return Err("Xiao routine title exceeds the 512-byte limit.".to_owned());
    }
    if routine.prompt.len() > MAX_ROUTINE_PROMPT_BYTES {
        return Err("Xiao routine prompt exceeds the 64 KiB limit.".to_owned());
    }
    schedule::build_schedule(
        routine.schedule_kind,
        &routine.timezone,
        routine.schedule_payload.scheduled_for,
        schedule::daily_time(&routine.schedule_payload).as_deref(),
        routine.created_at,
    )?;
    Ok(())
}

fn validate_new_routine_task(
    transaction: &Transaction<'_>,
    routine: &NewRoutine,
) -> Result<(), String> {
    let binding = transaction
        .query_row(
            r#"SELECT w.workspace_path, t.execution_environment_id, t.managed_worktree_id
             FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
             WHERE t.workspace_id = ?1 AND t.task_id = ?2"#,
            params![routine.workspace_id, routine.task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not validate Xiao routine task: {error}"))?
        .ok_or("The Xiao routine task does not exist.")?;
    if normalize_workspace_path(&binding.0) != normalize_workspace_path(&routine.workspace_path)
        || binding.1.as_deref() != Some(routine.execution_environment_id.as_str())
        || binding.2 != routine.managed_worktree_id
    {
        return Err("The Xiao routine execution binding changed before save.".to_owned());
    }
    Ok(())
}

fn routine_binding_matches(
    transaction: &Transaction<'_>,
    routine: &RoutineRecord,
) -> Result<bool, String> {
    transaction
        .query_row(
            r#"SELECT execution_environment_id, managed_worktree_id FROM tasks
             WHERE workspace_id = ?1 AND task_id = ?2"#,
            params![routine.workspace_id, routine.task_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not validate routine dispatch binding: {error}"))
        .map(|binding| {
            binding.is_some_and(|binding| {
                binding.0.as_deref() == Some(routine.execution_environment_id.as_str())
                    && binding.1 == routine.managed_worktree_id
            })
        })
}

fn disable_routine_for_binding_change(
    transaction: &Transaction<'_>,
    routine: &RoutineRecord,
    timestamp: i64,
) -> Result<RoutineRecord, String> {
    disable_routine_with_error(
        transaction,
        routine,
        "The routine task execution environment changed. Review and edit the routine before enabling it again.",
        timestamp,
    )
}

fn disable_routine_with_error(
    transaction: &Transaction<'_>,
    routine: &RoutineRecord,
    diagnostic: &str,
    timestamp: i64,
) -> Result<RoutineRecord, String> {
    let diagnostic = bounded_diagnostic(diagnostic);
    transaction
        .execute(
            r#"UPDATE routines SET enabled = 0, next_run_at = NULL, last_error = ?1,
                version = version + 1, updated_at = ?2 WHERE id = ?3"#,
            params![diagnostic, timestamp, routine.id],
        )
        .map_err(|error| format!("Could not disable Xiao routine: {error}"))?;
    load_routine(transaction, &routine.id)
}

fn update_routine_after_occurrence(
    transaction: &Transaction<'_>,
    routine_id: &str,
    enabled: bool,
    next_run_at: Option<i64>,
    last_run_at: Option<i64>,
    timestamp: i64,
) -> Result<(), String> {
    transaction
        .execute(
            r#"UPDATE routines SET enabled = ?1, next_run_at = ?2,
                last_run_at = COALESCE(?3, last_run_at), last_error = NULL,
                version = version + 1, updated_at = ?4 WHERE id = ?5"#,
            params![
                bool_to_i64(enabled),
                next_run_at,
                last_run_at,
                timestamp,
                routine_id
            ],
        )
        .map_err(|error| format!("Could not advance Xiao routine schedule: {error}"))?;
    Ok(())
}

struct NewOccurrence<'a> {
    id: &'a str,
    routine_id: &'a str,
    scheduled_for: i64,
    idempotency_key: &'a str,
    trigger_kind: RoutineTriggerKind,
    status: RoutineOccurrenceStatus,
    created_at: i64,
}

fn insert_occurrence(
    transaction: &Transaction<'_>,
    occurrence: NewOccurrence<'_>,
) -> Result<(), String> {
    transaction
        .execute(
            r#"INSERT INTO routine_occurrences(
                id, routine_id, scheduled_for, idempotency_key, trigger_kind,
                status, run_id, last_notification_key, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)"#,
            params![
                occurrence.id,
                occurrence.routine_id,
                occurrence.scheduled_for,
                occurrence.idempotency_key,
                occurrence.trigger_kind.as_database(),
                occurrence.status.as_database(),
                occurrence.created_at
            ],
        )
        .map_err(|error| format!("Could not reserve Xiao routine occurrence: {error}"))?;
    Ok(())
}

fn mark_occurrence_dispatched(
    transaction: &Transaction<'_>,
    occurrence_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let changed = transaction
        .execute(
            r#"UPDATE routine_occurrences SET status = 'dispatched', run_id = ?1
             WHERE id = ?2 AND status IN ('reserved', 'dispatched')"#,
            params![run_id, occurrence_id],
        )
        .map_err(|error| format!("Could not dispatch Xiao routine occurrence: {error}"))?;
    if changed != 1 {
        return Err("The Xiao routine occurrence reservation was lost.".to_owned());
    }
    Ok(())
}

fn new_run_for_occurrence(
    routine: &RoutineRecord,
    occurrence_id: &str,
    idempotency_key: &str,
    queued_at: i64,
) -> NewRun {
    NewRun {
        id: new_uuid_v7(),
        workspace_id: routine.workspace_id,
        task_id: routine.task_id.clone(),
        idempotency_key: idempotency_key.to_owned(),
        parent_run_id: None,
        candidate_group_id: None,
        routine_occurrence_id: Some(occurrence_id.to_owned()),
        execution_environment_id: routine.execution_environment_id.clone(),
        execution_root: routine.execution_root.clone(),
        managed_worktree_id: routine.managed_worktree_id.clone(),
        prompt: routine.prompt.clone(),
        input: vec![json!({
            "type": "text",
            "text": routine.prompt,
            "text_elements": [],
        })],
        history: Vec::new(),
        model: routine.model.clone(),
        reasoning_effort: routine.reasoning_effort.clone(),
        service_tier: routine.service_tier.clone(),
        mode: routine.mode.clone(),
        approval_policy: routine.approval_policy.clone(),
        sandbox_mode: routine.sandbox_mode.clone(),
        goal: routine.goal.clone(),
        queued_at,
    }
}

fn automatic_idempotency_key(routine_id: &str, scheduled_for: i64) -> String {
    format!("routine:{routine_id}:scheduled:{scheduled_for}")
}

fn require_occurrence_run(
    run_occurrence_id: &Option<String>,
    expected_occurrence_id: &str,
) -> Result<(), String> {
    if run_occurrence_id.as_deref() != Some(expected_occurrence_id) {
        return Err(
            "The Xiao routine occurrence idempotency key belongs to another run.".to_owned(),
        );
    }
    Ok(())
}

fn available_manual_time(
    transaction: &Transaction<'_>,
    routine_id: &str,
    now: i64,
) -> Result<i64, String> {
    for offset in 0..100_i64 {
        let candidate = now.saturating_add(offset);
        let exists = transaction
            .query_row(
                r#"SELECT 1 WHERE
                    EXISTS(SELECT 1 FROM routine_occurrences
                           WHERE routine_id = ?1 AND scheduled_for = ?2)
                    OR EXISTS(SELECT 1 FROM routines
                              WHERE id = ?1 AND next_run_at = ?2)"#,
                params![routine_id, candidate],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Could not reserve manual routine time: {error}"))?
            .is_some();
        if !exists {
            return Ok(candidate);
        }
    }
    Err("Could not allocate a unique manual routine occurrence time.".to_owned())
}

fn load_routine(connection: &Connection, routine_id: &str) -> Result<RoutineRecord, String> {
    let sql = format!("{ROUTINE_SELECT} WHERE r.id = ?1");
    connection
        .query_row(&sql, [routine_id], routine_from_row)
        .optional()
        .map_err(|error| format!("Could not load Xiao routine: {error}"))?
        .ok_or_else(|| format!("Xiao routine `{routine_id}` was not found."))?
        .decode()
}

fn load_occurrence_by_key(
    connection: &Connection,
    idempotency_key: &str,
) -> Result<Option<RoutineOccurrenceRecord>, String> {
    connection
        .query_row(
            r#"SELECT id, routine_id, scheduled_for, idempotency_key,
                trigger_kind, status, run_id, last_notification_key, created_at
             FROM routine_occurrences WHERE idempotency_key = ?1"#,
            [idempotency_key],
            occurrence_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not inspect routine idempotency: {error}"))?
        .map(StoredOccurrenceRow::decode)
        .transpose()
}

struct StoredRoutineRow {
    id: String,
    workspace_id: i64,
    workspace_path: String,
    task_id: String,
    title: String,
    prompt: String,
    schedule_kind: String,
    timezone: String,
    schedule_payload_json: String,
    missed_run_policy: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    mode: String,
    approval_policy: String,
    sandbox_mode: String,
    goal_json: Option<String>,
    execution_environment_id: String,
    execution_root: String,
    managed_worktree_id: Option<String>,
    enabled: bool,
    next_run_at: Option<i64>,
    last_run_at: Option<i64>,
    last_error: Option<String>,
    isolation_warning: Option<String>,
    version: i64,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

impl StoredRoutineRow {
    fn decode(self) -> Result<RoutineRecord, String> {
        Ok(RoutineRecord {
            id: self.id,
            workspace_id: self.workspace_id,
            workspace_path: self.workspace_path,
            task_id: self.task_id,
            title: self.title,
            prompt: self.prompt,
            schedule_kind: RoutineScheduleKind::from_database(&self.schedule_kind)?,
            timezone: self.timezone,
            schedule_payload: parse_json(&self.schedule_payload_json, "routine schedule")?,
            missed_run_policy: MissedRunPolicy::from_database(&self.missed_run_policy)?,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            service_tier: self.service_tier,
            mode: self.mode,
            approval_policy: self.approval_policy,
            sandbox_mode: self.sandbox_mode,
            goal: parse_optional_json(self.goal_json.as_deref(), "routine goal")?,
            execution_environment_id: self.execution_environment_id,
            execution_root: self.execution_root,
            managed_worktree_id: self.managed_worktree_id,
            enabled: self.enabled,
            next_run_at: self.next_run_at,
            last_run_at: self.last_run_at,
            last_error: self.last_error,
            isolation_warning: self.isolation_warning,
            version: self.version,
            created_at: self.created_at,
            updated_at: self.updated_at,
            deleted_at: self.deleted_at,
        })
    }
}

fn routine_from_row(row: &Row<'_>) -> rusqlite::Result<StoredRoutineRow> {
    Ok(StoredRoutineRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        workspace_path: row.get(2)?,
        task_id: row.get(3)?,
        title: row.get(4)?,
        prompt: row.get(5)?,
        schedule_kind: row.get(6)?,
        timezone: row.get(7)?,
        schedule_payload_json: row.get(8)?,
        missed_run_policy: row.get(9)?,
        model: row.get(10)?,
        reasoning_effort: row.get(11)?,
        service_tier: row.get(12)?,
        mode: row.get(13)?,
        approval_policy: row.get(14)?,
        sandbox_mode: row.get(15)?,
        goal_json: row.get(16)?,
        execution_environment_id: row.get(17)?,
        execution_root: row.get(18)?,
        managed_worktree_id: row.get(19)?,
        enabled: row.get::<_, i64>(20)? != 0,
        next_run_at: row.get(21)?,
        last_run_at: row.get(22)?,
        last_error: row.get(23)?,
        isolation_warning: row.get(24)?,
        version: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        deleted_at: row.get(28)?,
    })
}

struct StoredOccurrenceRow {
    id: String,
    _routine_id: String,
    scheduled_for: i64,
    _idempotency_key: String,
    trigger_kind: String,
    status: String,
    run_id: Option<String>,
    _last_notification_key: Option<String>,
    _created_at: i64,
}

impl StoredOccurrenceRow {
    fn decode(self) -> Result<RoutineOccurrenceRecord, String> {
        Ok(RoutineOccurrenceRecord {
            id: self.id,
            scheduled_for: self.scheduled_for,
            trigger_kind: RoutineTriggerKind::from_database(&self.trigger_kind)?,
            status: RoutineOccurrenceStatus::from_database(&self.status)?,
            run_id: self.run_id,
        })
    }
}

fn occurrence_from_row(row: &Row<'_>) -> rusqlite::Result<StoredOccurrenceRow> {
    Ok(StoredOccurrenceRow {
        id: row.get(0)?,
        _routine_id: row.get(1)?,
        scheduled_for: row.get(2)?,
        _idempotency_key: row.get(3)?,
        trigger_kind: row.get(4)?,
        status: row.get(5)?,
        run_id: row.get(6)?,
        _last_notification_key: row.get(7)?,
        _created_at: row.get(8)?,
    })
}

fn json_string(value: &impl serde::Serialize, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not encode {label}: {error}"))
}

fn optional_json_string(value: Option<&Value>, label: &str) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, label)).transpose()
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not decode {label}: {error}"))
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<T>, String> {
    value.map(|value| parse_json(value, label)).transpose()
}

fn bool_to_i64(value: bool) -> i64 {
    i64::from(value)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::routines::models::RoutineSchedulePayload;
    use crate::runs::models::RunStatus;
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate, XIAO_SCHEMA_VERSION,
    };

    const DUE_AT: i64 = 1_700_000_000_000;
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-m4-{label}-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn task(id: &str) -> XiaoTaskDocument {
        XiaoTaskDocument {
            id: id.to_owned(),
            title: id.to_owned(),
            created_at: 1,
            updated_at: 1,
            draft_text: String::new(),
            follow_ups: Vec::new(),
            archived: false,
            pinned: false,
            unread: false,
            model: Some("gpt-test".to_owned()),
            reasoning_effort: Some("medium".to_owned()),
            thread_id: None,
            thread_binding: None,
            mode: "default".to_owned(),
            approval_policy: "on-request".to_owned(),
            sandbox_mode: "workspace-write".to_owned(),
            goal: None,
            timeline: Vec::new(),
            timeline_loaded: true,
            timeline_complete: true,
            timeline_start: 0,
            timeline_entry_count: 0,
            plan: None,
            execution_environment_id: None,
            workspace_mode: XiaoWorkspaceMode::Local,
            managed_worktree_id: None,
        }
    }

    fn repository_with_task(directory: &Path) -> (XiaoRepository, String) {
        let repository = XiaoRepository::open(directory).unwrap();
        let workspace = directory.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let workspace_path = workspace.to_string_lossy().into_owned();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace_path.clone(),
                active_task_id: Some("routine-task".to_owned()),
                show_archived: false,
                task_ids: vec!["routine-task".to_owned()],
                tasks: vec![task("routine-task")],
            })
            .unwrap();
        (repository, normalize_workspace_path(&workspace_path))
    }

    fn new_routine(
        repository: &XiaoRepository,
        workspace_path: &str,
        id: &str,
        schedule_kind: RoutineScheduleKind,
        missed_run_policy: MissedRunPolicy,
        next_run_at: i64,
    ) -> NewRoutine {
        let defaults = repository
            .run_task_defaults(workspace_path, "routine-task")
            .unwrap();
        let binding = repository
            .task_execution_binding(workspace_path, "routine-task")
            .unwrap();
        NewRoutine {
            id: id.to_owned(),
            workspace_id: defaults.workspace_id,
            workspace_path: workspace_path.to_owned(),
            task_id: "routine-task".to_owned(),
            title: "Routine".to_owned(),
            prompt: "Inspect the workspace".to_owned(),
            schedule_kind,
            timezone: "UTC".to_owned(),
            schedule_payload: match schedule_kind {
                RoutineScheduleKind::OneShot => RoutineSchedulePayload {
                    scheduled_for: Some(next_run_at),
                    hour: None,
                    minute: None,
                },
                RoutineScheduleKind::Daily => RoutineSchedulePayload {
                    scheduled_for: None,
                    hour: Some(9),
                    minute: Some(0),
                },
            },
            missed_run_policy,
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: None,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            execution_environment_id: binding.environment.id,
            execution_root: workspace_path.to_owned(),
            managed_worktree_id: None,
            next_run_at,
            isolation_warning: None,
            created_at: next_run_at - 1,
        }
    }

    fn conflicting_run(
        repository: &XiaoRepository,
        workspace_path: &str,
        idempotency_key: String,
    ) -> NewRun {
        let defaults = repository
            .run_task_defaults(workspace_path, "routine-task")
            .unwrap();
        let binding = repository
            .task_execution_binding(workspace_path, "routine-task")
            .unwrap();
        NewRun {
            id: new_uuid_v7(),
            workspace_id: defaults.workspace_id,
            task_id: "routine-task".to_owned(),
            idempotency_key,
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            execution_environment_id: binding.environment.id,
            execution_root: workspace_path.to_owned(),
            managed_worktree_id: None,
            prompt: "Conflicting run".to_owned(),
            input: vec![json!({ "type": "text", "text": "Conflicting run" })],
            history: Vec::new(),
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: None,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            queued_at: DUE_AT - 1,
        }
    }

    #[test]
    fn automatic_dispatch_is_durable_and_duplicate_safe_after_restart() {
        let directory = TestDirectory::new("restart-idempotency");
        let run_id = {
            let (repository, workspace_path) = repository_with_task(&directory.0);
            repository
                .create_routine(new_routine(
                    &repository,
                    &workspace_path,
                    "routine-one",
                    RoutineScheduleKind::OneShot,
                    MissedRunPolicy::RunOnce,
                    DUE_AT,
                ))
                .unwrap();
            let reservation = repository
                .reserve_due_routine(DUE_AT + 120_000, 60_000)
                .unwrap()
                .unwrap();
            let RoutineReservation::Dispatched { routine, run } = reservation else {
                panic!("expected a dispatched occurrence")
            };
            assert!(!routine.enabled);
            assert_eq!(routine.next_run_at, None);
            assert!(run.event.is_some());
            assert!(run.run.routine_occurrence_id.is_some());
            run.run.id
        };

        let repository = XiaoRepository::open(&directory.0).unwrap();
        let history = repository
            .list_routine_occurrences("routine-one", None)
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!(history[0].status, RoutineOccurrenceStatus::Dispatched);
        assert!(repository
            .set_routine_enabled("routine-one", true, Some(DUE_AT), DUE_AT + 150_000)
            .unwrap_err()
            .contains("already settled"));
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE routines SET enabled = 1, next_run_at = ?1 WHERE id = 'routine-one'",
                        [DUE_AT],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let duplicate = repository
            .reserve_due_routine(DUE_AT + 180_000, 60_000)
            .unwrap()
            .unwrap();
        assert!(matches!(duplicate, RoutineReservation::Unchanged { .. }));
        assert_eq!(
            repository
                .list_routine_occurrences("routine-one", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            repository.get_run(&run_id).unwrap().status,
            RunStatus::Queued
        );
    }

    #[test]
    fn missed_skip_advances_daily_schedule_without_enqueuing() {
        let directory = TestDirectory::new("missed-skip");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-skip",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::Skip,
                DUE_AT,
            ))
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT + 120_000, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Skipped { routine } = reservation else {
            panic!("expected a skipped occurrence")
        };
        assert!(routine.enabled);
        assert!(routine
            .next_run_at
            .is_some_and(|next| next > DUE_AT + 120_000));
        let history = repository
            .list_routine_occurrences("routine-skip", None)
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, RoutineOccurrenceStatus::Skipped);
        let run_count: i64 = repository
            .with_connection(|connection| {
                connection
                    .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(run_count, 0);
    }

    #[test]
    fn missed_run_once_coalesces_daily_backlog_into_one_run() {
        let directory = TestDirectory::new("missed-run-once");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-catch-up",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        let now = DUE_AT + 3 * 86_400_000;
        let reservation = repository
            .reserve_due_routine(now, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Dispatched { routine, .. } = reservation else {
            panic!("expected one catch-up dispatch")
        };
        assert!(routine.next_run_at.is_some_and(|next| next > now));
        assert!(repository
            .reserve_due_routine(now, 60_000)
            .unwrap()
            .is_none());
        assert_eq!(
            repository
                .list_routine_occurrences("routine-catch-up", None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn run_now_request_key_enqueues_once() {
        let directory = TestDirectory::new("run-now");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-now",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::RunOnce,
                DUE_AT + 86_400_000,
            ))
            .unwrap();
        let automatic_next = repository
            .get_routine_record("routine-now")
            .unwrap()
            .next_run_at;
        let first = repository
            .run_routine_now("routine-now", "request-one", DUE_AT)
            .unwrap();
        assert!(matches!(first, RoutineReservation::Dispatched { .. }));
        assert_eq!(
            repository
                .get_routine_record("routine-now")
                .unwrap()
                .next_run_at,
            automatic_next
        );
        let duplicate = repository
            .run_routine_now("routine-now", "request-one", DUE_AT)
            .unwrap();
        assert!(matches!(duplicate, RoutineReservation::Unchanged { .. }));
        assert_eq!(
            repository
                .list_routine_occurrences("routine-now", None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn disable_reenable_edit_and_delete_preserve_history() {
        let directory = TestDirectory::new("lifecycle-history");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-lifecycle",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        let disabled = repository
            .set_routine_enabled("routine-lifecycle", false, Some(DUE_AT), DUE_AT - 10)
            .unwrap();
        assert!(!disabled.enabled);
        assert!(repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .is_none());
        repository
            .set_routine_enabled("routine-lifecycle", true, Some(DUE_AT), DUE_AT - 5)
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Dispatched { run, .. } = reservation else {
            panic!("expected the re-enabled routine to dispatch")
        };
        let run_id = run.run.id;
        let history_before = repository
            .list_routine_occurrences("routine-lifecycle", None)
            .unwrap();
        assert_eq!(history_before.len(), 1);

        repository
            .update_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-lifecycle",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::Skip,
                DUE_AT + 172_800_000,
            ))
            .unwrap();
        let history_after_edit = repository
            .list_routine_occurrences("routine-lifecycle", None)
            .unwrap();
        assert_eq!(history_after_edit, history_before);
        assert_eq!(repository.get_run(&run_id).unwrap().id, run_id);

        repository
            .delete_routine("routine-lifecycle", DUE_AT + 1)
            .unwrap();
        assert!(repository
            .list_routine_records(&workspace_path)
            .unwrap()
            .is_empty());
        assert_eq!(
            repository
                .list_routine_occurrences("routine-lifecycle", None)
                .unwrap(),
            history_before
        );
        assert_eq!(repository.get_run(&run_id).unwrap().id, run_id);
    }

    #[test]
    fn run_now_at_the_automatic_instant_keeps_both_occurrences_unique() {
        let directory = TestDirectory::new("manual-automatic-time");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-same-time",
                RoutineScheduleKind::Daily,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        repository
            .run_routine_now("routine-same-time", "manual-at-due", DUE_AT)
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .unwrap();
        assert!(matches!(reservation, RoutineReservation::Dispatched { .. }));
        let history = repository
            .list_routine_occurrences("routine-same-time", None)
            .unwrap();
        assert_eq!(history.len(), 2);
        assert_ne!(history[0].scheduled_for, history[1].scheduled_for);
    }

    #[test]
    fn dispatch_collision_releases_occurrence_and_disables_schedule() {
        let directory = TestDirectory::new("collision-rollback");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-collision",
                RoutineScheduleKind::OneShot,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        let key = automatic_idempotency_key("routine-collision", DUE_AT);
        repository
            .enqueue_run(conflicting_run(&repository, &workspace_path, key))
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Disabled { routine } = reservation else {
            panic!("expected the conflicting routine to be disabled")
        };
        assert!(routine
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("belongs to another run")));
        assert!(repository
            .list_routine_occurrences("routine-collision", None)
            .unwrap()
            .is_empty());
        assert!(!routine.enabled);
        assert_eq!(routine.next_run_at, None);
    }

    #[test]
    fn stale_task_binding_disables_routine_before_dispatch() {
        let directory = TestDirectory::new("stale-binding");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-stale",
                RoutineScheduleKind::OneShot,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE tasks SET execution_environment_id = NULL WHERE task_id = 'routine-task'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Disabled { routine } = reservation else {
            panic!("expected the stale routine to be disabled")
        };
        assert!(!routine.enabled);
        assert!(routine
            .last_error
            .unwrap()
            .contains("execution environment changed"));
        assert!(repository
            .list_routine_occurrences("routine-stale", None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn notification_claim_is_durable_and_task_removal_is_blocked() {
        let directory = TestDirectory::new("notification-claim");
        let (repository, workspace_path) = repository_with_task(&directory.0);
        repository
            .create_routine(new_routine(
                &repository,
                &workspace_path,
                "routine-notification",
                RoutineScheduleKind::OneShot,
                MissedRunPolicy::RunOnce,
                DUE_AT,
            ))
            .unwrap();
        let reservation = repository
            .reserve_due_routine(DUE_AT, 60_000)
            .unwrap()
            .unwrap();
        let RoutineReservation::Dispatched { run, .. } = reservation else {
            panic!("expected a dispatched occurrence")
        };
        let target = repository
            .claim_routine_notification(&run.run.id, "terminal:completed:1")
            .unwrap()
            .unwrap();
        assert_eq!(target.route.workspace_path, workspace_path);
        assert_eq!(target.route.task_id, "routine-task");
        assert_eq!(target.route.routine_id, "routine-notification");
        assert_eq!(target.route.run_id, run.run.id);
        assert!(repository
            .claim_routine_notification(&run.run.id, "terminal:completed:1")
            .unwrap()
            .is_none());
        assert!(repository
            .claim_routine_notification(&run.run.id, "input:request-one")
            .unwrap()
            .is_some());
        repository
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE runs SET status = 'completed', agent_outcome = 'completed', finished_at = ?1 WHERE id = ?2",
                        params![DUE_AT + 1, run.run.id],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        let removal_error = repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path,
                active_task_id: None,
                show_archived: false,
                task_ids: Vec::new(),
                tasks: Vec::new(),
            })
            .unwrap_err();
        assert!(removal_error.contains("routine history"));
    }
}
