use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::xiao::models::{XiaoThreadBinding, XiaoThreadPersistence};
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{
    AgentOutcome, NewPendingInput, NewRun, PendingInputKind, PendingInputSnapshot, RunEventRecord,
    RunRecord, RunStatus, RunTaskDefaults, RuntimeAttachment, VerificationOutcome,
};

const MAX_SAFE_EVENT_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;
const MAX_RUN_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RUN_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_RUN_PROMPT_BYTES: usize = 64 * 1024;
const MAX_RUN_IDENTITY_BYTES: usize = 512;
const DEFAULT_EVENT_PAGE_SIZE: usize = 200;
const MAX_EVENT_PAGE_SIZE: usize = 200;
const DEFAULT_RUN_PAGE_SIZE: usize = 50;
const MAX_RUN_PAGE_SIZE: usize = 100;

const ACTIVE_STATUSES_SQL: &str = "'preparing', 'running', 'waiting_for_input', 'verifying'";
const TERMINAL_STATUSES_SQL: &str = "'completed', 'failed', 'cancelled', 'interrupted'";

pub(crate) struct CorrelatedRunEvent<'a> {
    pub generation: u64,
    pub thread_id: &'a str,
    pub turn_id: Option<&'a str>,
    pub event_type: &'a str,
    pub event_key: Option<&'a str>,
    pub payload: &'a Value,
}

const RUN_SELECT: &str = r#"
SELECT
    r.id, r.workspace_id, w.workspace_path, r.task_id, r.idempotency_key,
    r.parent_run_id, r.candidate_group_id, r.status, r.agent_outcome,
    r.verification_outcome, r.execution_environment_id, r.execution_root,
    r.managed_worktree_id, r.prompt, r.input_json, r.history_json, r.model,
    r.reasoning_effort, r.service_tier, r.mode, r.approval_policy,
    r.sandbox_mode, r.goal_json, r.thread_id, r.thread_source, r.cli_version,
    r.runtime_generation, r.turn_id, r.cancel_requested, r.queued_at,
    r.started_at, r.finished_at, r.version, r.routine_occurrence_id
FROM runs r
JOIN workspaces w ON w.id = r.workspace_id
"#;

#[derive(Debug, Clone)]
pub(crate) struct RunMutation {
    pub run: RunRecord,
    pub event: Option<RunEventRecord>,
}

#[derive(Debug, Clone)]
pub(crate) enum CancelDisposition {
    Settled(RunMutation),
    Interrupt {
        run: RunRecord,
        event: Option<RunEventRecord>,
    },
}

impl XiaoRepository {
    pub(crate) fn allocate_runtime_generation(&self, environment_id: &str) -> Result<u64, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not start runtime generation allocation: {error}")
                })?;
            transaction
                .execute(
                    r#"INSERT INTO runtime_generations(execution_environment_id, generation)
                     VALUES (?1, 0) ON CONFLICT(execution_environment_id) DO NOTHING"#,
                    [environment_id],
                )
                .map_err(|error| format!("Could not initialize runtime generation: {error}"))?;
            let generation: i64 = transaction
                .query_row(
                    r#"UPDATE runtime_generations SET generation = generation + 1
                     WHERE execution_environment_id = ?1 RETURNING generation"#,
                    [environment_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not allocate runtime generation: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit runtime generation: {error}"))?;
            u64::try_from(generation)
                .map_err(|_| "The allocated runtime generation is invalid.".to_owned())
        })
    }

    pub(crate) fn task_has_active_runs(
        &self,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<bool, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let count: i64 = connection
                .query_row(
                    &format!(
                        r#"SELECT COUNT(*) FROM runs r
                           JOIN workspaces w ON w.id = r.workspace_id
                           WHERE w.workspace_path = ?1 AND r.task_id = ?2
                             AND r.status IN ({ACTIVE_STATUSES_SQL})"#
                    ),
                    params![workspace_path, task_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not inspect active Xiao runs: {error}"))?;
            Ok(count != 0)
        })
    }

    pub(crate) fn run_task_defaults(
        &self,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<RunTaskDefaults, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            connection
                .query_row(
                    r#"SELECT w.id, t.model, t.reasoning_effort, t.mode,
                        t.approval_policy, t.sandbox_mode, t.goal_json,
                        t.thread_binding_json
                     FROM workspaces w
                     JOIN tasks t ON t.workspace_id = w.id
                     WHERE w.workspace_path = ?1 AND t.task_id = ?2"#,
                    params![workspace_path, task_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<String>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("Could not load Xiao run defaults: {error}"))?
                .ok_or_else(|| format!("Xiao task `{task_id}` was not found."))
                .and_then(
                    |(
                        workspace_id,
                        model,
                        reasoning_effort,
                        mode,
                        approval_policy,
                        sandbox_mode,
                        goal_json,
                        thread_binding_json,
                    )| {
                        Ok(RunTaskDefaults {
                            workspace_id,
                            model,
                            reasoning_effort,
                            mode,
                            approval_policy,
                            sandbox_mode,
                            goal: parse_optional_json(goal_json.as_deref(), "task goal")?,
                            thread_binding: parse_optional_json(
                                thread_binding_json.as_deref(),
                                "thread binding",
                            )?,
                        })
                    },
                )
        })
    }

    pub(crate) fn enqueue_run(&self, run: NewRun) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run enqueue: {error}"))?;
            let mutation = Self::enqueue_run_in_transaction(&transaction, &run)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run enqueue: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn enqueue_run_in_transaction(
        transaction: &Transaction<'_>,
        run: &NewRun,
    ) -> Result<RunMutation, String> {
        validate_new_run(run)?;
        if let Some(existing) = load_run_by_idempotency(transaction, &run.idempotency_key)? {
            if existing.workspace_id != run.workspace_id || existing.task_id != run.task_id {
                return Err("The Xiao run idempotency key belongs to another task.".to_owned());
            }
            return Ok(RunMutation {
                run: existing,
                event: None,
            });
        }

        let binding = transaction
            .query_row(
                r#"SELECT t.execution_environment_id, t.managed_worktree_id
                 FROM tasks t WHERE t.workspace_id = ?1 AND t.task_id = ?2"#,
                params![run.workspace_id, run.task_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Could not validate Xiao run task: {error}"))?
            .ok_or("The Xiao run task no longer exists.")?;
        if binding.0.as_deref() != Some(run.execution_environment_id.as_str())
            || binding.1 != run.managed_worktree_id
        {
            return Err("The Xiao run execution binding changed before enqueue.".to_owned());
        }

        let input_json = json_string(&run.input, "run input")?;
        let history_json = json_string(&run.history, "run history")?;
        let goal_json = optional_json_string(run.goal.as_ref(), "run goal")?;
        transaction
            .execute(
                r#"INSERT INTO runs(
                    id, workspace_id, task_id, idempotency_key, parent_run_id,
                    candidate_group_id, status, agent_outcome, verification_outcome,
                    execution_root, queued_at, started_at, finished_at, version,
                    execution_environment_id, managed_worktree_id, input_json,
                    history_json, prompt, model, reasoning_effort, service_tier,
                    mode, approval_policy, sandbox_mode, goal_json, thread_id,
                    thread_source, cli_version, runtime_generation, turn_id,
                    cancel_requested, routine_occurrence_id
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, 'queued', 'pending',
                    'not_requested', ?7, ?8, NULL, NULL, 0, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                    NULL, NULL, NULL, NULL, NULL, 0, ?21
                 )"#,
                params![
                    run.id,
                    run.workspace_id,
                    run.task_id,
                    run.idempotency_key,
                    run.parent_run_id,
                    run.candidate_group_id,
                    run.execution_root,
                    run.queued_at,
                    run.execution_environment_id,
                    run.managed_worktree_id,
                    input_json,
                    history_json,
                    run.prompt,
                    run.model,
                    run.reasoning_effort,
                    run.service_tier,
                    run.mode,
                    run.approval_policy,
                    run.sandbox_mode,
                    goal_json,
                    run.routine_occurrence_id,
                ],
            )
            .map_err(|error| format!("Could not enqueue Xiao run: {error}"))?;
        let event = append_event(
            transaction,
            &run.id,
            "run.queued",
            Some("lifecycle:queued"),
            &json!({
                "idempotencyKey": run.idempotency_key,
                "routineOccurrenceId": run.routine_occurrence_id,
            }),
        )?;
        let record = load_run(transaction, &run.id)?;
        Ok(RunMutation {
            run: record,
            event: Some(event),
        })
    }

    pub(crate) fn get_run(&self, run_id: &str) -> Result<RunRecord, String> {
        self.with_connection(|connection| load_run(connection, run_id))
    }

    pub(crate) fn list_runs(
        &self,
        workspace_path: &str,
        task_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<RunRecord>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        let limit = limit
            .unwrap_or(DEFAULT_RUN_PAGE_SIZE)
            .clamp(1, MAX_RUN_PAGE_SIZE) as i64;
        self.with_connection(|connection| {
            let sql = if task_id.is_some() {
                format!(
                    r#"{RUN_SELECT}
                       WHERE w.workspace_path = ?1 AND r.task_id = ?2
                         AND (
                           r.status NOT IN ({TERMINAL_STATUSES_SQL})
                           OR r.id IN (
                             SELECT recent.id FROM runs recent
                             WHERE recent.workspace_id = r.workspace_id
                               AND recent.task_id = r.task_id
                               AND recent.status IN ({TERMINAL_STATUSES_SQL})
                             ORDER BY recent.queued_at DESC, recent.id DESC LIMIT ?3
                           )
                         )
                       ORDER BY r.queued_at DESC, r.id DESC"#
                )
            } else {
                format!(
                    r#"{RUN_SELECT}
                       WHERE w.workspace_path = ?1
                         AND (
                           r.status NOT IN ({TERMINAL_STATUSES_SQL})
                           OR r.id IN (
                             SELECT recent.id FROM runs recent
                             WHERE recent.workspace_id = r.workspace_id
                               AND recent.status IN ({TERMINAL_STATUSES_SQL})
                             ORDER BY recent.queued_at DESC, recent.id DESC LIMIT ?2
                           )
                         )
                       ORDER BY r.queued_at DESC, r.id DESC"#
                )
            };
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Xiao run list: {error}"))?;
            let rows = match task_id {
                Some(task_id) => statement
                    .query_map(params![workspace_path, task_id, limit], run_from_row)
                    .map_err(|error| format!("Could not query Xiao runs: {error}"))?,
                None => statement
                    .query_map(params![workspace_path, limit], run_from_row)
                    .map_err(|error| format!("Could not query Xiao runs: {error}"))?,
            };
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao run: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn list_run_events(
        &self,
        run_id: &str,
        after_sequence: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<RunEventRecord>, String> {
        let limit = limit
            .unwrap_or(DEFAULT_EVENT_PAGE_SIZE)
            .clamp(1, MAX_EVENT_PAGE_SIZE) as i64;
        self.with_connection(|connection| {
            let exists = connection
                .query_row("SELECT 1 FROM runs WHERE id = ?1", [run_id], |_| Ok(()))
                .optional()
                .map_err(|error| format!("Could not find Xiao run events: {error}"))?
                .is_some();
            if !exists {
                return Err("The Xiao run was not found.".to_owned());
            }
            let (sql, after) = match after_sequence {
                Some(after) => (
                    r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                        safe_payload_json FROM run_events
                     WHERE run_id = ?1 AND sequence > ?2
                     ORDER BY sequence ASC LIMIT ?3"#,
                    after,
                ),
                None => (
                    r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                        safe_payload_json FROM (
                          SELECT run_id, sequence, timestamp, event_type, event_key,
                              safe_payload_json FROM run_events
                          WHERE run_id = ?1 AND sequence > ?2
                          ORDER BY sequence DESC LIMIT ?3
                     ) ORDER BY sequence ASC"#,
                    -1,
                ),
            };
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("Could not prepare Xiao run events: {error}"))?;
            let rows = statement
                .query_map(params![run_id, after, limit], event_from_row)
                .map_err(|error| format!("Could not query Xiao run events: {error}"))?;
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao run event: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn claim_next_eligible_run(
        &self,
        concurrency_limit: usize,
    ) -> Result<Option<RunMutation>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao queue claim: {error}"))?;
            let active: i64 = transaction
                .query_row(
                    &format!("SELECT COUNT(*) FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL})"),
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not count active Xiao runs: {error}"))?;
            if active >= i64::try_from(concurrency_limit).unwrap_or(i64::MAX) {
                transaction.commit().map_err(|error| {
                    format!("Could not finish Xiao queue capacity check: {error}")
                })?;
                return Ok(None);
            }
            let run_id = transaction
                .query_row(
                    &format!(
                        r#"SELECT queued.id FROM runs queued
                         WHERE queued.status = 'queued'
                           AND NOT EXISTS (
                             SELECT 1 FROM runs active
                             WHERE active.workspace_id = queued.workspace_id
                               AND active.task_id = queued.task_id
                               AND active.status IN ({ACTIVE_STATUSES_SQL})
                           )
                         ORDER BY queued.queued_at ASC, queued.id ASC LIMIT 1"#
                    ),
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("Could not select the next Xiao run: {error}"))?;
            let Some(run_id) = run_id else {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish empty Xiao queue claim: {error}"))?;
                return Ok(None);
            };
            let mutation = transition(
                &transaction,
                &run_id,
                None,
                RunStatus::Preparing,
                "run.preparing",
                Some("lifecycle:preparing"),
                &json!({}),
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao queue claim: {error}"))?;
            Ok(Some(mutation))
        })
    }

    pub(crate) fn attach_run_runtime(
        &self,
        run_id: &str,
        attachment: &RuntimeAttachment,
    ) -> Result<RunMutation, String> {
        let generation = generation_to_i64(attachment.generation)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao runtime attachment: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status != RunStatus::Preparing {
                return Err("Only a preparing Xiao run can attach a runtime.".to_owned());
            }
            if current.cancel_requested {
                return Err("The Xiao run was cancelled during preparation.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET runtime_generation = ?1, thread_id = ?2,
                        thread_source = ?3, cli_version = ?4, version = version + 1
                     WHERE id = ?5 AND version = ?6 AND status = 'preparing'"#,
                    params![
                        generation,
                        attachment.thread_id,
                        attachment.thread_source,
                        attachment.cli_version,
                        run_id,
                        current.version
                    ],
                )
                .map_err(|error| format!("Could not attach Xiao run runtime: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed during runtime attachment.".to_owned());
            }
            let binding = XiaoThreadBinding {
                thread_id: attachment.thread_id.clone(),
                persistence: XiaoThreadPersistence::Persistent,
                materialized: attachment.materialized,
                thread_source: Some(attachment.thread_source.clone()),
                cli_version: Some(attachment.cli_version.clone()),
            };
            transaction
                .execute(
                    r#"UPDATE tasks SET thread_binding_json = ?1
                     WHERE workspace_id = ?2 AND task_id = ?3"#,
                    params![
                        json_string(&binding, "persistent thread binding")?,
                        current.workspace_id,
                        current.task_id
                    ],
                )
                .map_err(|error| format!("Could not persist Xiao thread binding: {error}"))?;
            let key = format!("runtime:{generation}:{}", attachment.thread_id);
            let event = append_event(
                &transaction,
                run_id,
                "run.runtime_attached",
                Some(&key),
                &json!({
                    "runtimeGeneration": attachment.generation,
                    "threadId": attachment.thread_id,
                    "threadSource": attachment.thread_source,
                    "cliVersion": attachment.cli_version,
                }),
            )?;
            let run = load_run(&transaction, run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao runtime attachment: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn mark_run_running(
        &self,
        run_id: &str,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao running transition: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            require_runtime_route(&current, generation, thread_id, None)?;
            if current.status != RunStatus::Preparing {
                if current.status == RunStatus::Running
                    && current.turn_id.as_deref() == Some(turn_id)
                {
                    transaction.commit().map_err(|error| {
                        format!("Could not finish duplicate Xiao running event: {error}")
                    })?;
                    return Ok(RunMutation {
                        run: current,
                        event: None,
                    });
                }
                return Err("Only a preparing Xiao run can start a turn.".to_owned());
            }
            if current.cancel_requested {
                return Err("The Xiao run was cancelled before turn start.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE runs SET turn_id = ?1 WHERE id = ?2 AND version = ?3
                       AND status = 'preparing'"#,
                    params![turn_id, run_id, current.version],
                )
                .map_err(|error| format!("Could not bind Xiao run turn: {error}"))?;
            if changed != 1 {
                return Err("The Xiao run changed before turn start.".to_owned());
            }
            let key = format!("{generation}/{thread_id}/{turn_id}/started");
            let mutation = transition(
                &transaction,
                run_id,
                Some(current.version),
                RunStatus::Running,
                "run.running",
                Some(&key),
                &json!({
                    "runtimeGeneration": generation,
                    "threadId": thread_id,
                    "turnId": turn_id,
                }),
            )?;
            mark_task_thread_materialized(&transaction, &mutation.run)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao running transition: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn transition_run(
        &self,
        run_id: &str,
        target: RunStatus,
        event_type: &str,
        event_key: Option<&str>,
        payload: &Value,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run transition: {error}"))?;
            let mutation = transition(
                &transaction,
                run_id,
                None,
                target,
                event_type,
                event_key,
                payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run transition: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn settle_runtime_turn(
        &self,
        run_id: &str,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
        runtime_status: RunStatus,
        payload: &Value,
    ) -> Result<RunMutation, String> {
        if !matches!(
            runtime_status,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Interrupted
        ) {
            return Err("The runtime reported an invalid terminal Xiao status.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao terminal settlement: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            require_runtime_route(&current, generation, thread_id, Some(turn_id))?;
            if current.status.is_terminal() {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao terminal settlement: {error}")
                })?;
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
            let target = if current.cancel_requested {
                RunStatus::Cancelled
            } else {
                runtime_status
            };
            let event_type = match target {
                RunStatus::Completed => "run.completed",
                RunStatus::Cancelled => "run.cancelled",
                RunStatus::Interrupted => "run.interrupted",
                _ => "run.failed",
            };
            let key = format!(
                "{generation}/{thread_id}/{turn_id}/{}",
                target.as_database()
            );
            let mutation = transition(
                &transaction,
                run_id,
                Some(current.version),
                target,
                event_type,
                Some(&key),
                payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao terminal settlement: {error}"))?;
            Ok(mutation)
        })
    }

    pub(crate) fn record_run_event(
        &self,
        run_id: &str,
        correlated: CorrelatedRunEvent<'_>,
    ) -> Result<RunMutation, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run event: {error}"))?;
            let run = load_run(&transaction, run_id)?;
            require_runtime_route(
                &run,
                correlated.generation,
                correlated.thread_id,
                correlated.turn_id,
            )?;
            if run.status.is_terminal() {
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish late Xiao run event: {error}"))?;
                return Ok(RunMutation { run, event: None });
            }
            if let Some(key) = correlated.event_key {
                if existing_event_by_key(&transaction, run_id, key)?.is_some() {
                    transaction.commit().map_err(|error| {
                        format!("Could not finish duplicate Xiao run event: {error}")
                    })?;
                    return Ok(RunMutation { run, event: None });
                }
            }
            let event = append_event(
                &transaction,
                run_id,
                correlated.event_type,
                correlated.event_key,
                correlated.payload,
            )?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run event: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn find_active_run_route(
        &self,
        environment_id: &str,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<RunRecord>, String> {
        let generation = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            let sql = format!(
                "{RUN_SELECT} WHERE r.execution_environment_id = ?1 AND r.runtime_generation = ?2 AND r.thread_id = ?3 AND r.status IN ({ACTIVE_STATUSES_SQL}) ORDER BY r.queued_at ASC"
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare Xiao runtime route: {error}"))?;
            let rows = statement
                .query_map(params![environment_id, generation, thread_id], run_from_row)
                .map_err(|error| format!("Could not query Xiao runtime route: {error}"))?;
            let records = rows
                .map(|row| {
                    row.map_err(|error| format!("Could not decode Xiao runtime route: {error}"))?
                        .decode()
                })
                .collect::<Result<Vec<_>, String>>()?;
            match records.as_slice() {
                [] => Ok(None),
                [record] => Ok(Some(record.clone())),
                _ => Err("Multiple active Xiao runs share one runtime thread.".to_owned()),
            }
        })
    }

    pub(crate) fn open_pending_input(
        &self,
        input: NewPendingInput,
    ) -> Result<(RunMutation, PendingInputSnapshot), String> {
        validate_safe_payload(&input.safe_summary)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao pending input: {error}"))?;
            let run = load_run(&transaction, &input.run_id)?;
            require_runtime_route(
                &run,
                input.runtime_generation,
                &input.thread_id,
                Some(&input.turn_id),
            )?;
            if !matches!(run.status, RunStatus::Running | RunStatus::WaitingForInput) {
                return Err("The Xiao run cannot accept input in its current state.".to_owned());
            }
            if run.cancel_requested {
                return Err("The Xiao run cannot open input after cancellation.".to_owned());
            }
            if let Some(existing) = find_pending_input(
                &transaction,
                &input.run_id,
                input.runtime_generation,
                &input.request_id,
                &input.thread_id,
                &input.turn_id,
                &input.item_id,
            )? {
                transaction.commit().map_err(|error| {
                    format!("Could not finish duplicate Xiao pending input: {error}")
                })?;
                return Ok((RunMutation { run, event: None }, existing));
            }
            let pending = PendingInputSnapshot {
                id: new_uuid_v7(),
                run_id: input.run_id.clone(),
                runtime_generation: input.runtime_generation,
                request_id: input.request_id.clone(),
                thread_id: input.thread_id.clone(),
                turn_id: input.turn_id.clone(),
                item_id: input.item_id.clone(),
                kind: input.kind,
                safe_summary: input.safe_summary.clone(),
                opened_at: now_millis()?,
                resolved_at: None,
                invalidated_at: None,
            };
            transaction
                .execute(
                    r#"INSERT INTO pending_inputs(
                        id, run_id, runtime_generation, request_id, thread_id,
                        turn_id, item_id, kind, safe_summary_json, opened_at,
                        resolved_at, invalidated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)"#,
                    params![
                        pending.id,
                        pending.run_id,
                        generation_to_i64(pending.runtime_generation)?,
                        pending.request_id,
                        pending.thread_id,
                        pending.turn_id,
                        pending.item_id,
                        pending.kind.as_database(),
                        json_string(&pending.safe_summary, "pending input summary")?,
                        pending.opened_at,
                    ],
                )
                .map_err(|error| format!("Could not persist Xiao pending input: {error}"))?;
            let key = format!(
                "{}/{}/{}/{}/input-opened",
                input.runtime_generation, input.thread_id, input.turn_id, input.item_id
            );
            let mutation = if run.status == RunStatus::Running {
                transition(
                    &transaction,
                    &input.run_id,
                    Some(run.version),
                    RunStatus::WaitingForInput,
                    "run.waiting_for_input",
                    Some(&key),
                    &json!({
                        "pendingInputId": pending.id,
                        "kind": pending.kind,
                        "threadId": pending.thread_id,
                        "turnId": pending.turn_id,
                        "itemId": pending.item_id,
                    }),
                )?
            } else {
                let event = append_event(
                    &transaction,
                    &input.run_id,
                    "run.input_opened",
                    Some(&key),
                    &json!({
                        "pendingInputId": pending.id,
                        "kind": pending.kind,
                        "threadId": pending.thread_id,
                        "turnId": pending.turn_id,
                        "itemId": pending.item_id,
                    }),
                )?;
                RunMutation {
                    run,
                    event: Some(event),
                }
            };
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao pending input: {error}"))?;
            Ok((mutation, pending))
        })
    }

    pub(crate) fn list_pending_inputs(
        &self,
        workspace_path: &str,
        task_id: Option<&str>,
    ) -> Result<Vec<PendingInputSnapshot>, String> {
        let workspace_path = normalize_workspace_path(workspace_path);
        self.with_connection(|connection| {
            let sql = if task_id.is_some() {
                r#"SELECT p.id, p.run_id, p.runtime_generation, p.request_id,
                    p.thread_id, p.turn_id, p.item_id, p.kind,
                    p.safe_summary_json, p.opened_at, p.resolved_at, p.invalidated_at
                 FROM pending_inputs p
                 JOIN runs r ON r.id = p.run_id
                 JOIN workspaces w ON w.id = r.workspace_id
                 WHERE w.workspace_path = ?1 AND r.task_id = ?2
                   AND p.resolved_at IS NULL AND p.invalidated_at IS NULL
                 ORDER BY p.opened_at ASC"#
            } else {
                r#"SELECT p.id, p.run_id, p.runtime_generation, p.request_id,
                    p.thread_id, p.turn_id, p.item_id, p.kind,
                    p.safe_summary_json, p.opened_at, p.resolved_at, p.invalidated_at
                 FROM pending_inputs p
                 JOIN runs r ON r.id = p.run_id
                 JOIN workspaces w ON w.id = r.workspace_id
                 WHERE w.workspace_path = ?1
                   AND p.resolved_at IS NULL AND p.invalidated_at IS NULL
                 ORDER BY p.opened_at ASC"#
            };
            let mut statement = connection
                .prepare(sql)
                .map_err(|error| format!("Could not prepare Xiao pending-input list: {error}"))?;
            let rows = match task_id {
                Some(task_id) => statement
                    .query_map(params![workspace_path, task_id], pending_input_from_row)
                    .map_err(|error| format!("Could not query Xiao pending inputs: {error}"))?,
                None => statement
                    .query_map([workspace_path], pending_input_from_row)
                    .map_err(|error| format!("Could not query Xiao pending inputs: {error}"))?,
            };
            rows.map(|row| {
                row.map_err(|error| format!("Could not decode Xiao pending input: {error}"))?
                    .decode()
            })
            .collect()
        })
    }

    pub(crate) fn get_pending_input(
        &self,
        pending_input_id: &str,
    ) -> Result<PendingInputSnapshot, String> {
        self.with_connection(|connection| load_pending_input(connection, pending_input_id))
    }

    pub(crate) fn resolve_pending_input(
        &self,
        pending_input_id: &str,
    ) -> Result<(RunMutation, PendingInputSnapshot), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao input resolution: {error}"))?;
            let mut pending = load_pending_input(&transaction, pending_input_id)?;
            if pending.invalidated_at.is_some() {
                return Err(
                    "This Xiao input request is no longer attached to a live runtime.".to_owned(),
                );
            }
            if pending.resolved_at.is_some() {
                let run = load_run(&transaction, &pending.run_id)?;
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao input resolution: {error}")
                })?;
                return Ok((RunMutation { run, event: None }, pending));
            }
            let run = load_run(&transaction, &pending.run_id)?;
            require_runtime_route(
                &run,
                pending.runtime_generation,
                &pending.thread_id,
                Some(&pending.turn_id),
            )?;
            if run.cancel_requested {
                return Err("The Xiao input request was cancelled before resolution.".to_owned());
            }
            let resolved_at = now_millis()?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET resolved_at = ?1
                     WHERE id = ?2 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                    params![resolved_at, pending_input_id],
                )
                .map_err(|error| format!("Could not resolve Xiao pending input: {error}"))?;
            pending.resolved_at = Some(resolved_at);
            let remaining: i64 = transaction
                .query_row(
                    r#"SELECT COUNT(*) FROM pending_inputs
                     WHERE run_id = ?1 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                    [&pending.run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not count Xiao pending inputs: {error}"))?;
            let key = format!("pending-input:{pending_input_id}:resolved");
            let mutation = if run.status == RunStatus::WaitingForInput && remaining == 0 {
                transition(
                    &transaction,
                    &pending.run_id,
                    Some(run.version),
                    RunStatus::Running,
                    "run.input_resolved",
                    Some(&key),
                    &json!({ "pendingInputId": pending_input_id }),
                )?
            } else {
                let event = append_event(
                    &transaction,
                    &pending.run_id,
                    "run.input_resolved",
                    Some(&key),
                    &json!({ "pendingInputId": pending_input_id }),
                )?;
                RunMutation {
                    run,
                    event: Some(event),
                }
            };
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao input resolution: {error}"))?;
            Ok((mutation, pending))
        })
    }

    pub(crate) fn request_run_cancel(&self, run_id: &str) -> Result<CancelDisposition, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run cancellation: {error}"))?;
            let current = load_run(&transaction, run_id)?;
            if current.status.is_terminal() {
                transaction.commit().map_err(|error| {
                    format!("Could not finish idempotent Xiao cancellation: {error}")
                })?;
                return Ok(CancelDisposition::Settled(RunMutation {
                    run: current,
                    event: None,
                }));
            }
            if matches!(current.status, RunStatus::Queued | RunStatus::Preparing) {
                let mutation = transition(
                    &transaction,
                    run_id,
                    Some(current.version),
                    RunStatus::Cancelled,
                    "run.cancelled",
                    Some("lifecycle:cancelled"),
                    &json!({ "beforeTurnStart": true }),
                )?;
                transaction.commit().map_err(|error| {
                    format!("Could not commit queued Xiao cancellation: {error}")
                })?;
                return Ok(CancelDisposition::Settled(mutation));
            }
            let event = if current.cancel_requested {
                None
            } else {
                let changed = transaction
                    .execute(
                        r#"UPDATE runs SET cancel_requested = 1, version = version + 1
                         WHERE id = ?1 AND version = ?2"#,
                        params![run_id, current.version],
                    )
                    .map_err(|error| {
                        format!("Could not record Xiao cancellation intent: {error}")
                    })?;
                if changed != 1 {
                    return Err("The Xiao run changed during cancellation.".to_owned());
                }
                Some(append_event(
                    &transaction,
                    run_id,
                    "run.cancel_requested",
                    Some("lifecycle:cancel-requested"),
                    &json!({}),
                )?)
            };
            let run = load_run(&transaction, run_id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao cancellation intent: {error}"))?;
            Ok(CancelDisposition::Interrupt { run, event })
        })
    }

    pub(crate) fn finish_run_cancel(&self, run_id: &str) -> Result<RunMutation, String> {
        let current = self.get_run(run_id)?;
        if current.status == RunStatus::Cancelled || current.status.is_terminal() {
            return Ok(RunMutation {
                run: current,
                event: None,
            });
        }
        if !current.cancel_requested {
            return Err("The Xiao run has no cancellation intent.".to_owned());
        }
        self.transition_run(
            run_id,
            RunStatus::Cancelled,
            "run.cancelled",
            Some("lifecycle:cancelled"),
            &json!({ "interruptedRuntime": true }),
        )
    }

    pub(crate) fn retry_run(
        &self,
        source_run_id: &str,
        idempotency_key: &str,
    ) -> Result<RunMutation, String> {
        if idempotency_key.trim().is_empty() || idempotency_key.len() > MAX_RUN_IDENTITY_BYTES {
            return Err("A valid retry idempotency key is required.".to_owned());
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run retry: {error}"))?;
            if let Some(existing) = load_run_by_idempotency(&transaction, idempotency_key)? {
                if existing.parent_run_id.as_deref() != Some(source_run_id) {
                    return Err("The Xiao retry idempotency key belongs to another run.".to_owned());
                }
                transaction
                    .commit()
                    .map_err(|error| format!("Could not finish idempotent Xiao retry: {error}"))?;
                return Ok(RunMutation {
                    run: existing,
                    event: None,
                });
            }
            let source = load_run(&transaction, source_run_id)?;
            if !matches!(source.status, RunStatus::Failed | RunStatus::Interrupted) {
                return Err("Only failed or interrupted Xiao runs can be retried.".to_owned());
            }
            let id = new_uuid_v7();
            transaction
                .execute(
                    r#"INSERT INTO runs(
                        id, workspace_id, task_id, idempotency_key, parent_run_id,
                        candidate_group_id, status, agent_outcome, verification_outcome,
                        execution_root, queued_at, started_at, finished_at, version,
                        execution_environment_id, managed_worktree_id, input_json,
                        history_json, prompt, model, reasoning_effort, service_tier,
                        mode, approval_policy, sandbox_mode, goal_json, thread_id,
                        thread_source, cli_version, runtime_generation, turn_id,
                        cancel_requested, routine_occurrence_id
                     ) SELECT
                        ?1, workspace_id, task_id, ?2, id, candidate_group_id,
                        'queued', 'pending', 'not_requested', execution_root, ?3,
                        NULL, NULL, 0, execution_environment_id, managed_worktree_id,
                        input_json, history_json, prompt, model, reasoning_effort,
                        service_tier, mode, approval_policy, sandbox_mode, goal_json,
                        NULL, NULL, NULL, NULL, NULL, 0, NULL
                     FROM runs WHERE id = ?4"#,
                    params![id, idempotency_key, now_millis()?, source_run_id],
                )
                .map_err(|error| format!("Could not create Xiao retry run: {error}"))?;
            let event = append_event(
                &transaction,
                &id,
                "run.queued",
                Some("lifecycle:queued"),
                &json!({ "parentRunId": source_run_id, "retry": true }),
            )?;
            let run = load_run(&transaction, &id)?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run retry: {error}"))?;
            Ok(RunMutation {
                run,
                event: Some(event),
            })
        })
    }

    pub(crate) fn reconcile_in_flight_runs(&self) -> Result<Vec<RunMutation>, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao run reconciliation: {error}"))?;
            let run_ids = {
                let mut statement = transaction
                    .prepare(&format!(
                        "SELECT id FROM runs WHERE status IN ({ACTIVE_STATUSES_SQL}) ORDER BY queued_at, id"
                    ))
                    .map_err(|error| format!("Could not prepare Xiao reconciliation: {error}"))?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("Could not query Xiao reconciliation: {error}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Could not decode Xiao reconciliation: {error}"))?
            };
            let timestamp = now_millis()?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET invalidated_at = ?1
                     WHERE resolved_at IS NULL AND invalidated_at IS NULL"#,
                    [timestamp],
                )
                .map_err(|error| format!("Could not invalidate stale Xiao inputs: {error}"))?;
            let mut mutations = Vec::with_capacity(run_ids.len());
            for run_id in run_ids {
                mutations.push(transition(
                    &transaction,
                    &run_id,
                    None,
                    RunStatus::Interrupted,
                    "run.interrupted",
                    Some("reconciliation:interrupted"),
                    &json!({ "reason": "process_restart" }),
                )?);
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Xiao run reconciliation: {error}"))?;
            Ok(mutations)
        })
    }

    pub(crate) fn interrupt_runtime_generation(
        &self,
        environment_id: &str,
        generation: u64,
        reason: &str,
    ) -> Result<Vec<RunMutation>, String> {
        let generation_i64 = generation_to_i64(generation)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start Xiao runtime interruption: {error}"))?;
            let run_ids = {
                let mut statement = transaction
                    .prepare(&format!(
                        "SELECT id FROM runs WHERE execution_environment_id = ?1 AND runtime_generation = ?2 AND status IN ({ACTIVE_STATUSES_SQL}) ORDER BY queued_at, id"
                    ))
                    .map_err(|error| format!("Could not prepare runtime interruption: {error}"))?;
                let rows = statement
                    .query_map(params![environment_id, generation_i64], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|error| format!("Could not query runtime interruption: {error}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Could not decode runtime interruption: {error}"))?
            };
            let timestamp = now_millis()?;
            transaction
                .execute(
                    r#"UPDATE pending_inputs SET invalidated_at = ?1
                     WHERE runtime_generation = ?2 AND resolved_at IS NULL
                       AND invalidated_at IS NULL AND run_id IN (
                         SELECT id FROM runs WHERE execution_environment_id = ?3
                       )"#,
                    params![timestamp, generation_i64, environment_id],
                )
                .map_err(|error| format!("Could not invalidate runtime inputs: {error}"))?;
            let mut mutations = Vec::with_capacity(run_ids.len());
            for run_id in run_ids {
                let current = load_run(&transaction, &run_id)?;
                let target = if current.cancel_requested {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Interrupted
                };
                let event_type = if target == RunStatus::Cancelled {
                    "run.cancelled"
                } else {
                    "run.interrupted"
                };
                let event_key = format!("runtime:{generation}:stopped");
                mutations.push(transition(
                    &transaction,
                    &run_id,
                    Some(current.version),
                    target,
                    event_type,
                    Some(&event_key),
                    &json!({ "reason": bounded_diagnostic(reason) }),
                )?);
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit runtime interruption: {error}"))?;
            Ok(mutations)
        })
    }
}

fn validate_new_run(run: &NewRun) -> Result<(), String> {
    if run.id.trim().is_empty()
        || run.task_id.trim().is_empty()
        || run.idempotency_key.trim().is_empty()
        || run.execution_environment_id.trim().is_empty()
        || run.execution_root.trim().is_empty()
        || run.prompt.trim().is_empty()
        || run.input.is_empty()
    {
        return Err("A Xiao run requires identity, task, execution context and input.".to_owned());
    }
    if run.id.len() > MAX_RUN_IDENTITY_BYTES
        || run.task_id.len() > MAX_RUN_IDENTITY_BYTES
        || run.idempotency_key.len() > MAX_RUN_IDENTITY_BYTES
        || run
            .routine_occurrence_id
            .as_ref()
            .is_some_and(|id| id.len() > MAX_RUN_IDENTITY_BYTES)
        || run.execution_environment_id.len() > MAX_RUN_IDENTITY_BYTES
    {
        return Err("Xiao run identity exceeds the 512-byte limit.".to_owned());
    }
    if run.prompt.len() > MAX_RUN_PROMPT_BYTES {
        return Err("Xiao run prompt exceeds the 64 KiB limit.".to_owned());
    }
    let input = serde_json::to_vec(&run.input)
        .map_err(|error| format!("Could not serialize Xiao run input: {error}"))?;
    if input.len() > MAX_RUN_INPUT_BYTES {
        return Err("Xiao run input exceeds the 16 MiB durability limit.".to_owned());
    }
    let history = serde_json::to_vec(&run.history)
        .map_err(|error| format!("Could not serialize Xiao run history: {error}"))?;
    if history.len() > MAX_RUN_HISTORY_BYTES {
        return Err("Xiao run history exceeds the 8 MiB durability limit.".to_owned());
    }
    Ok(())
}

fn transition(
    transaction: &Transaction<'_>,
    run_id: &str,
    expected_version: Option<i64>,
    target: RunStatus,
    event_type: &str,
    event_key: Option<&str>,
    payload: &Value,
) -> Result<RunMutation, String> {
    let current = load_run(transaction, run_id)?;
    if let Some(expected_version) = expected_version {
        if current.version != expected_version {
            return Err("The Xiao run changed before its state transition.".to_owned());
        }
    }
    if current.status == target {
        if let Some(key) = event_key {
            if existing_event_by_key(transaction, run_id, key)?.is_some() {
                return Ok(RunMutation {
                    run: current,
                    event: None,
                });
            }
        }
        return Err(format!(
            "Xiao run is already in state `{}` without a matching idempotent event.",
            target.as_database()
        ));
    }
    if !can_transition(current.status, target) {
        return Err(format!(
            "Invalid Xiao run transition from `{}` to `{}`.",
            current.status.as_database(),
            target.as_database()
        ));
    }
    validate_safe_payload(payload)?;
    let timestamp = now_millis()?;
    let started_at = if current.started_at.is_none() && target == RunStatus::Preparing {
        Some(timestamp)
    } else {
        current.started_at
    };
    let finished_at = if target.is_terminal() {
        Some(timestamp)
    } else {
        None
    };
    let (agent_outcome, verification_outcome) =
        outcomes_for_transition(target, current.agent_outcome, current.verification_outcome);
    if target.is_terminal() {
        transaction
            .execute(
                r#"UPDATE pending_inputs SET invalidated_at = ?1
                 WHERE run_id = ?2 AND resolved_at IS NULL AND invalidated_at IS NULL"#,
                params![timestamp, run_id],
            )
            .map_err(|error| format!("Could not invalidate terminal Xiao inputs: {error}"))?;
    }
    let changed = transaction
        .execute(
            r#"UPDATE runs SET status = ?1, agent_outcome = ?2,
                verification_outcome = ?3, started_at = ?4, finished_at = ?5,
                version = version + 1
             WHERE id = ?6 AND version = ?7"#,
            params![
                target.as_database(),
                agent_outcome.as_database(),
                verification_outcome.as_database(),
                started_at,
                finished_at,
                run_id,
                current.version,
            ],
        )
        .map_err(|error| format!("Could not transition Xiao run: {error}"))?;
    if changed != 1 {
        return Err("The Xiao run changed during its state transition.".to_owned());
    }
    let event = append_event(transaction, run_id, event_type, event_key, payload)?;
    Ok(RunMutation {
        run: load_run(transaction, run_id)?,
        event: Some(event),
    })
}

fn can_transition(from: RunStatus, to: RunStatus) -> bool {
    match from {
        RunStatus::Queued => matches!(to, RunStatus::Preparing | RunStatus::Cancelled),
        RunStatus::Preparing => matches!(
            to,
            RunStatus::Running | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Interrupted
        ),
        RunStatus::Running => matches!(
            to,
            RunStatus::WaitingForInput
                | RunStatus::Verifying
                | RunStatus::Completed
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::Interrupted
        ),
        RunStatus::WaitingForInput => matches!(
            to,
            RunStatus::Running | RunStatus::Failed | RunStatus::Cancelled | RunStatus::Interrupted
        ),
        RunStatus::Verifying => matches!(
            to,
            RunStatus::Completed
                | RunStatus::NeedsAttention
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::Interrupted
        ),
        RunStatus::NeedsAttention => to == RunStatus::Verifying,
        RunStatus::Completed
        | RunStatus::Failed
        | RunStatus::Cancelled
        | RunStatus::Interrupted => false,
    }
}

fn outcomes_for_transition(
    target: RunStatus,
    current_agent: AgentOutcome,
    current_verification: VerificationOutcome,
) -> (AgentOutcome, VerificationOutcome) {
    match target {
        RunStatus::Completed => (AgentOutcome::Completed, current_verification),
        RunStatus::Failed => (AgentOutcome::Failed, current_verification),
        RunStatus::Cancelled => (AgentOutcome::Cancelled, current_verification),
        RunStatus::Interrupted => (AgentOutcome::Interrupted, current_verification),
        RunStatus::Verifying => (AgentOutcome::Completed, VerificationOutcome::Pending),
        _ => (current_agent, current_verification),
    }
}

fn append_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    event_type: &str,
    event_key: Option<&str>,
    payload: &Value,
) -> Result<RunEventRecord, String> {
    if event_type.trim().is_empty() || event_type.len() > 128 {
        return Err("Xiao run event type is invalid.".to_owned());
    }
    if event_key.is_some_and(|key| key.is_empty() || key.len() > 512) {
        return Err("Xiao run event idempotency key is invalid.".to_owned());
    }
    validate_safe_payload(payload)?;
    if let Some(key) = event_key {
        if let Some(existing) = existing_event_by_key(transaction, run_id, key)? {
            return Ok(existing);
        }
    }
    let sequence: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_events WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not allocate Xiao run event sequence: {error}"))?;
    let timestamp = now_millis()?;
    transaction
        .execute(
            r#"INSERT INTO run_events(
                run_id, sequence, timestamp, event_type, safe_payload_json, event_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            params![
                run_id,
                sequence,
                timestamp,
                event_type,
                json_string(payload, "safe run event")?,
                event_key,
            ],
        )
        .map_err(|error| format!("Could not append Xiao run event: {error}"))?;
    Ok(RunEventRecord {
        run_id: run_id.to_owned(),
        sequence,
        timestamp,
        event_type: event_type.to_owned(),
        event_key: event_key.map(str::to_owned),
        safe_payload: payload.clone(),
    })
}

fn existing_event_by_key(
    connection: &Connection,
    run_id: &str,
    event_key: &str,
) -> Result<Option<RunEventRecord>, String> {
    connection
        .query_row(
            r#"SELECT run_id, sequence, timestamp, event_type, event_key,
                safe_payload_json FROM run_events
             WHERE run_id = ?1 AND event_key = ?2"#,
            params![run_id, event_key],
            event_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao run event idempotency: {error}"))?
        .map(StoredEventRow::decode)
        .transpose()
}

fn validate_safe_payload(payload: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("Could not serialize safe Xiao run event: {error}"))?;
    if bytes.len() > MAX_SAFE_EVENT_BYTES {
        return Err("Xiao run event exceeds the 64 KiB safe payload limit.".to_owned());
    }
    Ok(())
}

pub(crate) fn bounded_diagnostic(value: &str) -> String {
    if value.len() <= MAX_DIAGNOSTIC_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_DIAGNOSTIC_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn require_runtime_route(
    run: &RunRecord,
    generation: u64,
    thread_id: &str,
    turn_id: Option<&str>,
) -> Result<(), String> {
    if run.runtime_generation != Some(generation) || run.thread_id.as_deref() != Some(thread_id) {
        return Err(
            "The runtime event belongs to a stale Xiao run generation or thread.".to_owned(),
        );
    }
    if let (Some(expected), Some(actual)) = (run.turn_id.as_deref(), turn_id) {
        if expected != actual {
            return Err("The runtime event belongs to another Xiao turn.".to_owned());
        }
    }
    Ok(())
}

fn mark_task_thread_materialized(
    transaction: &Transaction<'_>,
    run: &RunRecord,
) -> Result<(), String> {
    let Some(thread_id) = run.thread_id.as_ref() else {
        return Err("A running Xiao run has no thread binding.".to_owned());
    };
    let binding = XiaoThreadBinding {
        thread_id: thread_id.clone(),
        persistence: XiaoThreadPersistence::Persistent,
        materialized: true,
        thread_source: run.thread_source.clone(),
        cli_version: run.cli_version.clone(),
    };
    transaction
        .execute(
            r#"UPDATE tasks SET thread_binding_json = ?1
             WHERE workspace_id = ?2 AND task_id = ?3"#,
            params![
                json_string(&binding, "materialized thread binding")?,
                run.workspace_id,
                run.task_id
            ],
        )
        .map_err(|error| format!("Could not materialize Xiao thread binding: {error}"))?;
    Ok(())
}

fn load_run(connection: &Connection, run_id: &str) -> Result<RunRecord, String> {
    let sql = format!("{RUN_SELECT} WHERE r.id = ?1");
    connection
        .query_row(&sql, [run_id], run_from_row)
        .optional()
        .map_err(|error| format!("Could not load Xiao run: {error}"))?
        .ok_or_else(|| format!("Xiao run `{run_id}` was not found."))?
        .decode()
}

fn load_run_by_idempotency(
    connection: &Connection,
    idempotency_key: &str,
) -> Result<Option<RunRecord>, String> {
    let sql = format!("{RUN_SELECT} WHERE r.idempotency_key = ?1");
    connection
        .query_row(&sql, [idempotency_key], run_from_row)
        .optional()
        .map_err(|error| format!("Could not inspect Xiao run idempotency: {error}"))?
        .map(StoredRunRow::decode)
        .transpose()
}

struct StoredRunRow {
    id: String,
    workspace_id: i64,
    workspace_path: String,
    task_id: String,
    idempotency_key: String,
    parent_run_id: Option<String>,
    candidate_group_id: Option<String>,
    status: String,
    agent_outcome: String,
    verification_outcome: String,
    execution_environment_id: Option<String>,
    execution_root: String,
    managed_worktree_id: Option<String>,
    prompt: String,
    input_json: String,
    history_json: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    mode: String,
    approval_policy: String,
    sandbox_mode: String,
    goal_json: Option<String>,
    thread_id: Option<String>,
    thread_source: Option<String>,
    cli_version: Option<String>,
    runtime_generation: Option<i64>,
    turn_id: Option<String>,
    cancel_requested: bool,
    queued_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    version: i64,
    routine_occurrence_id: Option<String>,
}

impl StoredRunRow {
    fn decode(self) -> Result<RunRecord, String> {
        Ok(RunRecord {
            id: self.id,
            workspace_id: self.workspace_id,
            workspace_path: self.workspace_path,
            task_id: self.task_id,
            idempotency_key: self.idempotency_key,
            parent_run_id: self.parent_run_id,
            candidate_group_id: self.candidate_group_id,
            status: RunStatus::from_database(&self.status)?,
            agent_outcome: AgentOutcome::from_database(&self.agent_outcome)?,
            verification_outcome: VerificationOutcome::from_database(&self.verification_outcome)?,
            execution_environment_id: self
                .execution_environment_id
                .ok_or("The Xiao run has no execution environment. Upgrade/retry this run.")?,
            execution_root: self.execution_root,
            managed_worktree_id: self.managed_worktree_id,
            prompt: self.prompt,
            input: parse_json(&self.input_json, "run input")?,
            history: parse_json(&self.history_json, "run history")?,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            service_tier: self.service_tier,
            mode: self.mode,
            approval_policy: self.approval_policy,
            sandbox_mode: self.sandbox_mode,
            goal: parse_optional_json(self.goal_json.as_deref(), "run goal")?,
            thread_id: self.thread_id,
            thread_source: self.thread_source,
            cli_version: self.cli_version,
            runtime_generation: self
                .runtime_generation
                .map(|value| {
                    u64::try_from(value)
                        .map_err(|_| "The Xiao runtime generation is invalid.".to_owned())
                })
                .transpose()?,
            turn_id: self.turn_id,
            cancel_requested: self.cancel_requested,
            queued_at: self.queued_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            version: self.version,
            routine_occurrence_id: self.routine_occurrence_id,
        })
    }
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<StoredRunRow> {
    Ok(StoredRunRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        workspace_path: row.get(2)?,
        task_id: row.get(3)?,
        idempotency_key: row.get(4)?,
        parent_run_id: row.get(5)?,
        candidate_group_id: row.get(6)?,
        status: row.get(7)?,
        agent_outcome: row.get(8)?,
        verification_outcome: row.get(9)?,
        execution_environment_id: row.get(10)?,
        execution_root: row.get(11)?,
        managed_worktree_id: row.get(12)?,
        prompt: row.get(13)?,
        input_json: row.get(14)?,
        history_json: row.get(15)?,
        model: row.get(16)?,
        reasoning_effort: row.get(17)?,
        service_tier: row.get(18)?,
        mode: row.get(19)?,
        approval_policy: row.get(20)?,
        sandbox_mode: row.get(21)?,
        goal_json: row.get(22)?,
        thread_id: row.get(23)?,
        thread_source: row.get(24)?,
        cli_version: row.get(25)?,
        runtime_generation: row.get(26)?,
        turn_id: row.get(27)?,
        cancel_requested: row.get::<_, i64>(28)? != 0,
        queued_at: row.get(29)?,
        started_at: row.get(30)?,
        finished_at: row.get(31)?,
        version: row.get(32)?,
        routine_occurrence_id: row.get(33)?,
    })
}

struct StoredEventRow {
    run_id: String,
    sequence: i64,
    timestamp: i64,
    event_type: String,
    event_key: Option<String>,
    safe_payload_json: String,
}

impl StoredEventRow {
    fn decode(self) -> Result<RunEventRecord, String> {
        Ok(RunEventRecord {
            run_id: self.run_id,
            sequence: self.sequence,
            timestamp: self.timestamp,
            event_type: self.event_type,
            event_key: self.event_key,
            safe_payload: parse_json(&self.safe_payload_json, "safe run event")?,
        })
    }
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredEventRow> {
    Ok(StoredEventRow {
        run_id: row.get(0)?,
        sequence: row.get(1)?,
        timestamp: row.get(2)?,
        event_type: row.get(3)?,
        event_key: row.get(4)?,
        safe_payload_json: row.get(5)?,
    })
}

fn find_pending_input(
    connection: &Connection,
    run_id: &str,
    generation: u64,
    request_id: &str,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
) -> Result<Option<PendingInputSnapshot>, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, runtime_generation, request_id, thread_id,
                turn_id, item_id, kind, safe_summary_json, opened_at,
                resolved_at, invalidated_at
             FROM pending_inputs
             WHERE run_id = ?1 AND runtime_generation = ?2 AND request_id = ?3
               AND thread_id = ?4 AND turn_id = ?5 AND item_id = ?6"#,
            params![
                run_id,
                generation_to_i64(generation)?,
                request_id,
                thread_id,
                turn_id,
                item_id
            ],
            pending_input_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao pending input: {error}"))?
        .map(StoredPendingInputRow::decode)
        .transpose()
}

fn load_pending_input(
    connection: &Connection,
    pending_input_id: &str,
) -> Result<PendingInputSnapshot, String> {
    connection
        .query_row(
            r#"SELECT id, run_id, runtime_generation, request_id, thread_id,
                turn_id, item_id, kind, safe_summary_json, opened_at,
                resolved_at, invalidated_at
             FROM pending_inputs WHERE id = ?1"#,
            [pending_input_id],
            pending_input_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao pending input: {error}"))?
        .ok_or("The Xiao pending input was not found.".to_owned())?
        .decode()
}

struct StoredPendingInputRow {
    id: String,
    run_id: String,
    runtime_generation: i64,
    request_id: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    kind: String,
    safe_summary_json: String,
    opened_at: i64,
    resolved_at: Option<i64>,
    invalidated_at: Option<i64>,
}

impl StoredPendingInputRow {
    fn decode(self) -> Result<PendingInputSnapshot, String> {
        Ok(PendingInputSnapshot {
            id: self.id,
            run_id: self.run_id,
            runtime_generation: u64::try_from(self.runtime_generation)
                .map_err(|_| "The pending input runtime generation is invalid.".to_owned())?,
            request_id: self.request_id,
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            item_id: self.item_id,
            kind: PendingInputKind::from_database(&self.kind)?,
            safe_summary: parse_json(&self.safe_summary_json, "pending input summary")?,
            opened_at: self.opened_at,
            resolved_at: self.resolved_at,
            invalidated_at: self.invalidated_at,
        })
    }
}

fn pending_input_from_row(row: &Row<'_>) -> rusqlite::Result<StoredPendingInputRow> {
    Ok(StoredPendingInputRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        runtime_generation: row.get(2)?,
        request_id: row.get(3)?,
        thread_id: row.get(4)?,
        turn_id: row.get(5)?,
        item_id: row.get(6)?,
        kind: row.get(7)?,
        safe_summary_json: row.get(8)?,
        opened_at: row.get(9)?,
        resolved_at: row.get(10)?,
        invalidated_at: row.get(11)?,
    })
}

fn generation_to_i64(generation: u64) -> Result<i64, String> {
    i64::try_from(generation).map_err(|_| "The runtime generation is too large.".to_owned())
}

fn json_string<T: serde::Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not serialize {label}: {error}"))
}

fn optional_json_string<T: serde::Serialize>(
    value: Option<&T>,
    label: &str,
) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, label)).transpose()
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not deserialize {label}: {error}"))
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<T>, String> {
    value.map(|value| parse_json(value, label)).transpose()
}

pub(crate) fn new_uuid_v7() -> String {
    Uuid::now_v7().to_string()
}

pub(crate) fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp is too large.".to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::agent::models::XiaoHistoryItem;
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate,
        XIAO_SCHEMA_VERSION,
    };

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-m3-{label}-{}-{}",
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

    fn repository_with_tasks(directory: &Path, task_ids: &[&str]) -> XiaoRepository {
        let repository = XiaoRepository::open(directory).unwrap();
        let workspace = directory.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let tasks = task_ids.iter().map(|id| task(id)).collect::<Vec<_>>();
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: task_ids.first().map(|id| (*id).to_owned()),
                show_archived: false,
                task_ids: task_ids.iter().map(|id| (*id).to_owned()).collect(),
                tasks,
            })
            .unwrap();
        repository
    }

    fn workspace_path(directory: &Path) -> String {
        normalize_workspace_path(&directory.join("workspace").to_string_lossy())
    }

    fn new_run(repository: &XiaoRepository, workspace: &str, task_id: &str, key: &str) -> NewRun {
        let defaults = repository.run_task_defaults(workspace, task_id).unwrap();
        let binding = repository
            .task_execution_binding(workspace, task_id)
            .unwrap();
        NewRun {
            id: new_uuid_v7(),
            workspace_id: defaults.workspace_id,
            task_id: task_id.to_owned(),
            idempotency_key: key.to_owned(),
            parent_run_id: None,
            candidate_group_id: None,
            routine_occurrence_id: None,
            execution_environment_id: binding.environment.id,
            execution_root: workspace.to_owned(),
            managed_worktree_id: None,
            prompt: format!("prompt {task_id}"),
            input: vec![json!({ "type": "text", "text": task_id })],
            history: vec![XiaoHistoryItem {
                role: "user".to_owned(),
                text: "history".to_owned(),
            }],
            model: defaults.model,
            reasoning_effort: defaults.reasoning_effort,
            service_tier: None,
            mode: defaults.mode,
            approval_policy: defaults.approval_policy,
            sandbox_mode: defaults.sandbox_mode,
            goal: defaults.goal,
            queued_at: now_millis().unwrap(),
        }
    }

    #[test]
    fn runtime_generation_is_durable_and_monotonic_per_environment() {
        let directory = TestDirectory::new("runtime-generation");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let environment_id = repository
            .task_execution_binding(&workspace, "task-a")
            .unwrap()
            .environment
            .id;
        assert_eq!(
            repository
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            1
        );
        assert_eq!(
            repository
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            2
        );
        drop(repository);

        let reopened = XiaoRepository::open(&directory.0).unwrap();
        assert_eq!(
            reopened
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            3
        );
    }

    #[test]
    fn duplicate_enqueue_returns_one_run_and_event() {
        let directory = TestDirectory::new("idempotency");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let run = new_run(&repository, &workspace, "task-a", "same-key");
        let first = repository.enqueue_run(run.clone()).unwrap();
        let second = repository.enqueue_run(run).unwrap();
        assert!(repository
            .enqueue_run(new_run(&repository, &workspace, "task-b", "same-key"))
            .is_err());

        assert_eq!(first.run.id, second.run.id);
        assert!(first.event.is_some());
        assert!(second.event.is_none());
        assert_eq!(
            repository
                .list_run_events(&first.run.id, None, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn run_listing_keeps_all_nonterminal_runs_beyond_the_history_limit() {
        let directory = TestDirectory::new("run-list-active");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let enqueue = |key: &str, queued_at: i64| {
            let mut run = new_run(&repository, &workspace, "task-a", key);
            run.queued_at = queued_at;
            repository.enqueue_run(run).unwrap().run
        };
        let first = enqueue("active-a", 1);
        let second = enqueue("active-b", 2);
        let older_terminal = enqueue("terminal-old", 3);
        let newest_terminal = enqueue("terminal-new", 4);
        repository.request_run_cancel(&older_terminal.id).unwrap();
        repository.request_run_cancel(&newest_terminal.id).unwrap();

        for task_id in [None, Some("task-a")] {
            let listed = repository.list_runs(&workspace, task_id, Some(1)).unwrap();
            let ids = listed.iter().map(|run| run.id.as_str()).collect::<Vec<_>>();
            assert_eq!(listed.len(), 3);
            assert!(ids.contains(&first.id.as_str()));
            assert!(ids.contains(&second.id.as_str()));
            assert!(ids.contains(&newest_terminal.id.as_str()));
            assert!(!ids.contains(&older_terminal.id.as_str()));
        }
    }

    #[test]
    fn lifecycle_and_pending_input_are_atomic() {
        let directory = TestDirectory::new("lifecycle");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let queued = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "lifecycle"))
            .unwrap()
            .run;
        let preparing = repository.claim_next_eligible_run(2).unwrap().unwrap().run;
        assert_eq!(preparing.status, RunStatus::Preparing);
        let attachment = RuntimeAttachment {
            generation: 1,
            thread_id: "thread-a".to_owned(),
            thread_source: "xiao-workbench".to_owned(),
            cli_version: "codex-test".to_owned(),
            materialized: false,
        };
        repository
            .attach_run_runtime(&queued.id, &attachment)
            .unwrap();
        let running = repository
            .mark_run_running(&queued.id, 1, "thread-a", "turn-a")
            .unwrap()
            .run;
        assert_eq!(running.status, RunStatus::Running);
        assert!(repository
            .task_has_active_runs(&workspace, "task-a")
            .unwrap());

        let (waiting, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: queued.id.clone(),
                runtime_generation: 1,
                request_id: "7".to_owned(),
                thread_id: "thread-a".to_owned(),
                turn_id: "turn-a".to_owned(),
                item_id: "item-a".to_owned(),
                kind: PendingInputKind::Question,
                safe_summary: json!({ "question": "Continue?" }),
            })
            .unwrap();
        assert_eq!(waiting.run.status, RunStatus::WaitingForInput);
        let (resumed, resolved) = repository.resolve_pending_input(&pending.id).unwrap();
        assert_eq!(resumed.run.status, RunStatus::Running);
        assert!(resolved.resolved_at.is_some());

        let completed = repository
            .transition_run(
                &queued.id,
                RunStatus::Completed,
                "run.completed",
                Some("1/thread-a/turn-a/completed"),
                &json!({}),
            )
            .unwrap();
        assert_eq!(completed.run.status, RunStatus::Completed);
        assert_eq!(completed.run.agent_outcome, AgentOutcome::Completed);
        assert!(!repository
            .task_has_active_runs(&workspace, "task-a")
            .unwrap());
        assert!(repository
            .transition_run(&queued.id, RunStatus::Running, "invalid", None, &json!({}))
            .is_err());
    }

    #[test]
    fn late_started_event_cannot_bind_a_reused_thread_to_a_new_run() {
        let directory = TestDirectory::new("late-turn-started");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let first = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "first"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let first_attachment = RuntimeAttachment {
            generation: 1,
            thread_id: "thread-a".to_owned(),
            thread_source: "xiao-workbench".to_owned(),
            cli_version: "codex-test".to_owned(),
            materialized: false,
        };
        repository
            .attach_run_runtime(&first.id, &first_attachment)
            .unwrap();
        repository
            .mark_run_running(&first.id, 1, "thread-a", "turn-old")
            .unwrap();
        repository
            .transition_run(
                &first.id,
                RunStatus::Completed,
                "run.completed",
                Some("1/thread-a/turn-old/completed"),
                &json!({}),
            )
            .unwrap();

        let second = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "second"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &second.id,
                &RuntimeAttachment {
                    materialized: true,
                    ..first_attachment
                },
            )
            .unwrap();

        assert!(repository
            .mark_run_running(&second.id, 1, "thread-a", "turn-old")
            .is_err());
        let unchanged = repository.get_run(&second.id).unwrap();
        assert_eq!(unchanged.status, RunStatus::Preparing);
        assert!(unchanged.turn_id.is_none());
    }

    #[test]
    fn queue_is_bounded_fifo_and_serial_per_task() {
        let directory = TestDirectory::new("queue");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
        let workspace = workspace_path(&directory.0);
        let first = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "a-1"))
            .unwrap()
            .run;
        let mut second_a = new_run(&repository, &workspace, "task-a", "a-2");
        second_a.queued_at += 1;
        repository.enqueue_run(second_a).unwrap();
        let mut second = new_run(&repository, &workspace, "task-b", "b-1");
        second.queued_at += 2;
        let second = repository.enqueue_run(second).unwrap().run;
        let mut third = new_run(&repository, &workspace, "task-c", "c-1");
        third.queued_at += 3;
        repository.enqueue_run(third).unwrap();

        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            first.id
        );
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            second.id
        );
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
    }

    #[test]
    fn fake_runtime_interleaving_respects_slots_waiting_input_and_routes() {
        let directory = TestDirectory::new("fake-runtime");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b", "task-c"]);
        let workspace = workspace_path(&directory.0);
        let run_a = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "fake-a"))
            .unwrap()
            .run;
        let mut run_b_input = new_run(&repository, &workspace, "task-b", "fake-b");
        run_b_input.queued_at += 1;
        let run_b = repository.enqueue_run(run_b_input).unwrap().run;
        let mut run_c_input = new_run(&repository, &workspace, "task-c", "fake-c");
        run_c_input.queued_at += 2;
        let run_c = repository.enqueue_run(run_c_input).unwrap().run;

        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_a.id
        );
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_b.id
        );
        for (run, thread, turn) in [
            (&run_a, "thread-a", "turn-a"),
            (&run_b, "thread-b", "turn-b"),
        ] {
            repository
                .attach_run_runtime(
                    &run.id,
                    &RuntimeAttachment {
                        generation: 7,
                        thread_id: thread.to_owned(),
                        thread_source: "xiao-workbench".to_owned(),
                        cli_version: "fake-codex".to_owned(),
                        materialized: true,
                    },
                )
                .unwrap();
            repository
                .mark_run_running(&run.id, 7, thread, turn)
                .unwrap();
        }

        let (waiting, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run_a.id.clone(),
                runtime_generation: 7,
                request_id: "41".to_owned(),
                thread_id: "thread-a".to_owned(),
                turn_id: "turn-a".to_owned(),
                item_id: "approval-a".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "fake approval" }),
            })
            .unwrap();
        assert_eq!(waiting.run.status, RunStatus::WaitingForInput);
        assert!(repository.claim_next_eligible_run(2).unwrap().is_none());
        assert_eq!(
            repository
                .find_active_run_route(&run_a.execution_environment_id, 7, "thread-a")
                .unwrap()
                .unwrap()
                .id,
            run_a.id
        );
        assert!(repository
            .record_run_event(
                &run_a.id,
                CorrelatedRunEvent {
                    generation: 6,
                    thread_id: "thread-a",
                    turn_id: Some("turn-a"),
                    event_type: "agent.fake",
                    event_key: Some("stale"),
                    payload: &json!({}),
                },
            )
            .is_err());

        repository
            .transition_run(
                &run_b.id,
                RunStatus::Completed,
                "run.completed",
                Some("7/thread-b/turn-b/completed"),
                &json!({}),
            )
            .unwrap();
        assert_eq!(
            repository
                .claim_next_eligible_run(2)
                .unwrap()
                .unwrap()
                .run
                .id,
            run_c.id
        );
        repository.resolve_pending_input(&pending.id).unwrap();
        assert_eq!(
            repository.get_run(&run_a.id).unwrap().status,
            RunStatus::Running
        );
    }

    #[test]
    fn verifying_transition_is_reserved_but_valid() {
        let directory = TestDirectory::new("verifying");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "verify"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        let verifying = repository
            .transition_run(
                &run.id,
                RunStatus::Verifying,
                "run.verifying",
                Some("verifying"),
                &json!({}),
            )
            .unwrap()
            .run;
        assert_eq!(verifying.status, RunStatus::Verifying);
        assert_eq!(verifying.verification_outcome, VerificationOutcome::Pending);
        assert_eq!(verifying.agent_outcome, AgentOutcome::Completed);
    }

    #[test]
    fn initial_event_page_returns_the_latest_bounded_window() {
        let directory = TestDirectory::new("event-page");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "events"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        for index in 0..250 {
            repository
                .record_run_event(
                    &run.id,
                    CorrelatedRunEvent {
                        generation: 1,
                        thread_id: "thread",
                        turn_id: Some("turn"),
                        event_type: "agent.fake",
                        event_key: Some(&format!("fake-{index}")),
                        payload: &json!({ "index": index }),
                    },
                )
                .unwrap();
        }
        let page = repository
            .list_run_events(&run.id, None, Some(200))
            .unwrap();
        assert_eq!(page.len(), 200);
        assert_eq!(page.last().unwrap().safe_payload["index"], 249);
        assert!(page.first().unwrap().sequence > 0);
    }

    #[test]
    fn reconciled_pending_input_is_invalidated_and_cannot_resolve() {
        let directory = TestDirectory::new("stale-input");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "stale-input"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 1, "thread", "turn")
            .unwrap();
        let (_, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 1,
                request_id: "1".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "item".to_owned(),
                kind: PendingInputKind::Question,
                safe_summary: json!({ "questions": [] }),
            })
            .unwrap();
        repository.reconcile_in_flight_runs().unwrap();
        assert!(repository
            .get_pending_input(&pending.id)
            .unwrap()
            .invalidated_at
            .is_some());
        assert!(repository.resolve_pending_input(&pending.id).is_err());
    }

    #[test]
    fn startup_reconciliation_interrupts_once_without_touching_queue() {
        let directory = TestDirectory::new("reconcile");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let active = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "active"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        let queued = repository
            .enqueue_run(new_run(&repository, &workspace, "task-b", "queued"))
            .unwrap()
            .run;

        let first = repository.reconcile_in_flight_runs().unwrap();
        let second = repository.reconcile_in_flight_runs().unwrap();

        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert_eq!(
            repository.get_run(&active.id).unwrap().status,
            RunStatus::Interrupted
        );
        assert_eq!(
            repository.get_run(&queued.id).unwrap().status,
            RunStatus::Queued
        );
    }

    #[test]
    fn stale_generation_and_oversized_event_cannot_mutate_run() {
        let directory = TestDirectory::new("stale");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "stale"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 2,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 2, "thread", "turn")
            .unwrap();

        assert!(repository
            .record_run_event(
                &run.id,
                CorrelatedRunEvent {
                    generation: 1,
                    thread_id: "thread",
                    turn_id: Some("turn"),
                    event_type: "agent.item",
                    event_key: None,
                    payload: &json!({}),
                },
            )
            .is_err());
        assert!(repository
            .record_run_event(
                &run.id,
                CorrelatedRunEvent {
                    generation: 2,
                    thread_id: "thread",
                    turn_id: Some("turn"),
                    event_type: "agent.item",
                    event_key: None,
                    payload: &json!({ "text": "x".repeat(MAX_SAFE_EVENT_BYTES) }),
                },
            )
            .is_err());
    }

    #[test]
    fn running_cancel_targets_only_the_exact_run_and_is_idempotent() {
        let directory = TestDirectory::new("running-cancel");
        let repository = repository_with_tasks(&directory.0, &["task-a", "task-b"]);
        let workspace = workspace_path(&directory.0);
        let run_a = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "cancel-a"))
            .unwrap()
            .run;
        let mut run_b_input = new_run(&repository, &workspace, "task-b", "cancel-b");
        run_b_input.queued_at += 1;
        let run_b = repository.enqueue_run(run_b_input).unwrap().run;
        for (run, thread, turn) in [
            (&run_a, "thread-a", "turn-a"),
            (&run_b, "thread-b", "turn-b"),
        ] {
            repository.claim_next_eligible_run(2).unwrap().unwrap();
            repository
                .attach_run_runtime(
                    &run.id,
                    &RuntimeAttachment {
                        generation: 3,
                        thread_id: thread.to_owned(),
                        thread_source: "xiao-workbench".to_owned(),
                        cli_version: "fake".to_owned(),
                        materialized: true,
                    },
                )
                .unwrap();
            repository
                .mark_run_running(&run.id, 3, thread, turn)
                .unwrap();
        }

        let requested = repository.request_run_cancel(&run_a.id).unwrap();
        assert!(matches!(requested, CancelDisposition::Interrupt { .. }));
        repository.finish_run_cancel(&run_a.id).unwrap();
        let repeated = repository.request_run_cancel(&run_a.id).unwrap();
        assert!(matches!(repeated, CancelDisposition::Settled(_)));
        assert_eq!(
            repository.get_run(&run_a.id).unwrap().status,
            RunStatus::Cancelled
        );
        assert_eq!(
            repository.get_run(&run_b.id).unwrap().status,
            RunStatus::Running
        );
    }

    #[test]
    fn committed_cancel_intent_wins_over_runtime_completion() {
        let directory = TestDirectory::new("cancel-completion-race");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "race"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 4,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 4, "thread", "turn")
            .unwrap();
        repository.request_run_cancel(&run.id).unwrap();

        let settled = repository
            .settle_runtime_turn(
                &run.id,
                4,
                "thread",
                "turn",
                RunStatus::Completed,
                &json!({ "protocol": { "method": "turn/completed" } }),
            )
            .unwrap();

        assert_eq!(settled.run.status, RunStatus::Cancelled);
        assert_eq!(settled.event.unwrap().event_type, "run.cancelled");
    }

    #[test]
    fn pending_input_cannot_resolve_after_cancel_intent_commits() {
        let directory = TestDirectory::new("cancel-input-race");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "input-race"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 5,
                    thread_id: "thread".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "fake".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();
        repository
            .mark_run_running(&run.id, 5, "thread", "turn")
            .unwrap();
        let (_, pending) = repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 5,
                request_id: "9".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "item".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "test" }),
            })
            .unwrap();
        repository.request_run_cancel(&run.id).unwrap();

        assert!(repository
            .open_pending_input(NewPendingInput {
                run_id: run.id.clone(),
                runtime_generation: 5,
                request_id: "10".to_owned(),
                thread_id: "thread".to_owned(),
                turn_id: "turn".to_owned(),
                item_id: "late-item".to_owned(),
                kind: PendingInputKind::CommandApproval,
                safe_summary: json!({ "reason": "late" }),
            })
            .is_err());
        assert!(repository.resolve_pending_input(&pending.id).is_err());
        assert!(repository
            .get_pending_input(&pending.id)
            .unwrap()
            .resolved_at
            .is_none());
    }

    #[test]
    fn queued_cancel_and_retry_are_idempotent() {
        let directory = TestDirectory::new("cancel-retry");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "cancel"))
            .unwrap()
            .run;
        let first = repository.request_run_cancel(&run.id).unwrap();
        let second = repository.request_run_cancel(&run.id).unwrap();
        assert!(matches!(first, CancelDisposition::Settled(_)));
        assert!(matches!(second, CancelDisposition::Settled(_)));
        assert_eq!(
            repository.get_run(&run.id).unwrap().status,
            RunStatus::Cancelled
        );

        let failed = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "failed"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .transition_run(
                &failed.id,
                RunStatus::Failed,
                "run.failed",
                Some("failed"),
                &json!({}),
            )
            .unwrap();
        let retry = repository.retry_run(&failed.id, "retry-key").unwrap();
        let duplicate = repository.retry_run(&failed.id, "retry-key").unwrap();
        assert!(repository.retry_run(&run.id, "retry-key").is_err());
        assert_eq!(retry.run.id, duplicate.run.id);
        assert_eq!(retry.run.parent_run_id.as_deref(), Some(failed.id.as_str()));
    }

    #[test]
    fn persistent_native_binding_survives_stale_workspace_save() {
        let directory = TestDirectory::new("thread-authority");
        let repository = repository_with_tasks(&directory.0, &["task-a"]);
        let workspace = workspace_path(&directory.0);
        let run = repository
            .enqueue_run(new_run(&repository, &workspace, "task-a", "binding"))
            .unwrap()
            .run;
        repository.claim_next_eligible_run(2).unwrap().unwrap();
        repository
            .attach_run_runtime(
                &run.id,
                &RuntimeAttachment {
                    generation: 1,
                    thread_id: "persistent".to_owned(),
                    thread_source: "xiao-workbench".to_owned(),
                    cli_version: "test".to_owned(),
                    materialized: true,
                },
            )
            .unwrap();

        let mut document: XiaoWorkspaceDocument = repository
            .load_workspace(&workspace, true)
            .unwrap()
            .unwrap();
        document.tasks[0].thread_binding = Some(XiaoThreadBinding {
            thread_id: "stale-renderer".to_owned(),
            persistence: XiaoThreadPersistence::Ephemeral,
            materialized: false,
            thread_source: None,
            cli_version: None,
        });
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: document.schema_version,
                workspace_path: document.workspace_path.clone(),
                active_task_id: document.active_task_id.clone(),
                show_archived: document.show_archived,
                task_ids: document.tasks.iter().map(|task| task.id.clone()).collect(),
                tasks: document.tasks,
            })
            .unwrap();
        let defaults = repository.run_task_defaults(&workspace, "task-a").unwrap();
        assert_eq!(defaults.thread_binding.unwrap().thread_id, "persistent");
    }
}
