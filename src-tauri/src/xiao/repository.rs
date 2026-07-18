use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{
    params, Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::execution::models::{
    ExecutionEnvironmentRecord, ManagedWorktreeRecord, ManagedWorktreeStatus,
    NewManagedWorktreeRecord, TaskExecutionBinding,
};

use super::models::{
    XiaoLegacyStore, XiaoProjectSummary, XiaoTaskDocument, XiaoThreadBinding,
    XiaoThreadPersistence, XiaoTimelinePage, XiaoWorkspaceDocument, XiaoWorkspaceMode,
    XiaoWorkspaceUpdate, XIAO_DATABASE_SCHEMA_VERSION, XIAO_SCHEMA_VERSION,
};

const DATABASE_FILE_NAME: &str = "xiao-state.sqlite3";
const LEGACY_STORE_FILE_NAME: &str = "xiao-state-v1.json";
const INITIAL_TIMELINE_PAGE_SIZE: usize = 200;
const DEFAULT_TIMELINE_PAGE_SIZE: usize = 200;
const MAX_TIMELINE_PAGE_SIZE: usize = 200;

const MIGRATION_1_SQL: &str = r#"
CREATE TABLE legacy_imports (
    source_name TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    backup_name TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    workspace_count INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    timeline_entry_count INTEGER NOT NULL
);

CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    workspace_path TEXT NOT NULL UNIQUE,
    active_task_id TEXT,
    show_archived INTEGER NOT NULL CHECK (show_archived IN (0, 1)),
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    draft_text TEXT NOT NULL,
    follow_ups_json TEXT NOT NULL CHECK (json_valid(follow_ups_json)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
    model TEXT,
    reasoning_effort TEXT,
    thread_binding_json TEXT CHECK (
        thread_binding_json IS NULL OR json_valid(thread_binding_json)
    ),
    mode TEXT NOT NULL,
    approval_policy TEXT NOT NULL,
    sandbox_mode TEXT NOT NULL,
    goal_json TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
    plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
    timeline_sha256 TEXT,
    timeline_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (timeline_entry_count >= 0),
    PRIMARY KEY (workspace_id, task_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX tasks_by_workspace_position
    ON tasks(workspace_id, position);
CREATE INDEX tasks_by_updated_at
    ON tasks(updated_at DESC);

CREATE TABLE task_timeline_entries (
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
    PRIMARY KEY (workspace_id, task_id, position),
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    parent_run_id TEXT,
    candidate_group_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'preparing', 'running', 'waiting_for_input', 'verifying',
        'completed', 'needs_attention', 'failed', 'cancelled', 'interrupted'
    )),
    agent_outcome TEXT NOT NULL CHECK (agent_outcome IN (
        'pending', 'completed', 'failed', 'interrupted', 'cancelled'
    )),
    verification_outcome TEXT NOT NULL CHECK (verification_outcome IN (
        'not_requested', 'pending', 'passed', 'failed', 'blocked'
    )),
    execution_root TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_run_id) REFERENCES runs(id) ON DELETE SET NULL
);

CREATE INDEX runs_by_task_time
    ON runs(workspace_id, task_id, queued_at DESC);
CREATE INDEX runs_by_status_time
    ON runs(status, queued_at);

CREATE TABLE run_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    timestamp INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    safe_payload_json TEXT NOT NULL CHECK (json_valid(safe_payload_json)),
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
"#;

const MIGRATION_2_SQL: &str = r#"
ALTER TABLE workspaces ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX workspaces_by_public_id ON workspaces(public_id);

CREATE TABLE execution_environments (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('windows')),
    label TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE managed_worktrees (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT,
    repository_root TEXT NOT NULL,
    repository_common_dir_sha256 TEXT NOT NULL,
    checkout_path TEXT NOT NULL UNIQUE,
    execution_root TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    owner_marker_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
        'preparing', 'active', 'removing', 'failed', 'removed'
    )),
    failure_reason TEXT,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL,
    UNIQUE (repository_root, branch)
);

CREATE UNIQUE INDEX managed_worktrees_one_live_per_task
    ON managed_worktrees(workspace_id, task_id)
    WHERE status IN ('preparing', 'active', 'removing');
CREATE INDEX managed_worktrees_by_workspace_status
    ON managed_worktrees(workspace_id, status, created_at DESC);

ALTER TABLE tasks ADD COLUMN execution_environment_id TEXT
    REFERENCES execution_environments(id);
ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'local'
    CHECK (workspace_mode IN ('local', 'managed-worktree'));
ALTER TABLE tasks ADD COLUMN managed_worktree_id TEXT
    REFERENCES managed_worktrees(id);
"#;

const MIGRATION_3_SQL: &str = r#"
ALTER TABLE runs ADD COLUMN execution_environment_id TEXT
    REFERENCES execution_environments(id);
ALTER TABLE runs ADD COLUMN managed_worktree_id TEXT
    REFERENCES managed_worktrees(id);
ALTER TABLE runs ADD COLUMN input_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(input_json));
ALTER TABLE runs ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(history_json));
ALTER TABLE runs ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN reasoning_effort TEXT;
ALTER TABLE runs ADD COLUMN service_tier TEXT;
ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE runs ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'on-request';
ALTER TABLE runs ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write';
ALTER TABLE runs ADD COLUMN goal_json TEXT CHECK (goal_json IS NULL OR json_valid(goal_json));
ALTER TABLE runs ADD COLUMN thread_id TEXT;
ALTER TABLE runs ADD COLUMN thread_source TEXT;
ALTER TABLE runs ADD COLUMN cli_version TEXT;
ALTER TABLE runs ADD COLUMN runtime_generation INTEGER
    CHECK (runtime_generation IS NULL OR runtime_generation >= 0);
ALTER TABLE runs ADD COLUMN turn_id TEXT;
ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_requested IN (0, 1));

UPDATE runs
SET execution_environment_id = (
    SELECT execution_environment_id FROM tasks
    WHERE tasks.workspace_id = runs.workspace_id AND tasks.task_id = runs.task_id
), managed_worktree_id = (
    SELECT managed_worktree_id FROM tasks
    WHERE tasks.workspace_id = runs.workspace_id AND tasks.task_id = runs.task_id
);

ALTER TABLE run_events ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX run_events_by_idempotency
    ON run_events(run_id, event_key) WHERE event_key IS NOT NULL;
CREATE INDEX runs_fifo_eligibility
    ON runs(status, queued_at, id);
CREATE INDEX runs_by_environment_status
    ON runs(execution_environment_id, status, queued_at);
CREATE UNIQUE INDEX runs_by_runtime_turn
    ON runs(execution_environment_id, runtime_generation, thread_id, turn_id)
    WHERE runtime_generation IS NOT NULL AND thread_id IS NOT NULL AND turn_id IS NOT NULL;

CREATE TABLE runtime_generations (
    execution_environment_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    FOREIGN KEY (execution_environment_id)
        REFERENCES execution_environments(id) ON DELETE CASCADE
);
INSERT INTO runtime_generations(execution_environment_id, generation)
SELECT e.id, COALESCE(MAX(r.runtime_generation), 0)
FROM execution_environments e
LEFT JOIN runs r ON r.execution_environment_id = e.id
GROUP BY e.id;

CREATE TABLE pending_inputs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
    request_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'command_approval', 'file_approval', 'permissions', 'question', 'mcp_elicitation'
    )),
    safe_summary_json TEXT NOT NULL CHECK (json_valid(safe_summary_json)),
    opened_at INTEGER NOT NULL,
    resolved_at INTEGER,
    invalidated_at INTEGER,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, runtime_generation, request_id, thread_id, turn_id, item_id)
);
CREATE INDEX pending_inputs_by_run_open
    ON pending_inputs(run_id, resolved_at, invalidated_at);
CREATE INDEX pending_inputs_by_generation_open
    ON pending_inputs(runtime_generation, resolved_at, invalidated_at);
"#;

const MIGRATION_4_SQL: &str = r#"
CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('one_shot', 'daily')),
    timezone TEXT NOT NULL,
    schedule_payload_json TEXT NOT NULL CHECK (json_valid(schedule_payload_json)),
    missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('skip', 'run_once')),
    model TEXT,
    reasoning_effort TEXT,
    service_tier TEXT,
    mode TEXT NOT NULL,
    approval_policy TEXT NOT NULL,
    sandbox_mode TEXT NOT NULL,
    goal_json TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
    execution_environment_id TEXT NOT NULL,
    execution_root TEXT NOT NULL,
    managed_worktree_id TEXT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_error TEXT,
    isolation_warning TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (workspace_id, task_id)
        REFERENCES tasks(workspace_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (execution_environment_id)
        REFERENCES execution_environments(id),
    FOREIGN KEY (managed_worktree_id)
        REFERENCES managed_worktrees(id)
);
CREATE INDEX routines_by_workspace_updated
    ON routines(workspace_id, deleted_at, updated_at DESC);
CREATE INDEX routines_due
    ON routines(enabled, next_run_at, id)
    WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL;

CREATE TABLE routine_occurrences (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('automatic', 'manual')),
    status TEXT NOT NULL CHECK (status IN (
        'reserved', 'dispatched', 'skipped', 'cancelled'
    )),
    run_id TEXT UNIQUE,
    last_notification_key TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL,
    UNIQUE (routine_id, scheduled_for)
);
CREATE INDEX routine_occurrences_by_routine_time
    ON routine_occurrences(routine_id, scheduled_for DESC, id DESC);

ALTER TABLE runs ADD COLUMN routine_occurrence_id TEXT
    REFERENCES routine_occurrences(id);
CREATE UNIQUE INDEX runs_by_routine_occurrence
    ON runs(routine_occurrence_id) WHERE routine_occurrence_id IS NOT NULL;
"#;

pub struct XiaoRepository {
    app_data_dir: PathBuf,
    state: Mutex<RepositoryState>,
}

struct RepositoryState {
    connection: Option<Connection>,
    initialization_error: Option<String>,
}

#[derive(Clone, Copy, Default)]
struct RepositoryOpenOptions {
    fail_legacy_before_commit: bool,
}

impl XiaoRepository {
    pub fn initialize(app_data_dir: PathBuf) -> Self {
        match open_connection(&app_data_dir, RepositoryOpenOptions::default()) {
            Ok(connection) => Self {
                app_data_dir,
                state: Mutex::new(RepositoryState {
                    connection: Some(connection),
                    initialization_error: None,
                }),
            },
            Err(error) => Self {
                app_data_dir,
                state: Mutex::new(RepositoryState {
                    connection: None,
                    initialization_error: Some(error),
                }),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        Self::open_with_options(app_data_dir, RepositoryOpenOptions::default())
    }

    #[cfg(test)]
    fn open_with_options(
        app_data_dir: &Path,
        options: RepositoryOpenOptions,
    ) -> Result<Self, String> {
        let connection = open_connection(app_data_dir, options)?;
        Ok(Self {
            app_data_dir: app_data_dir.to_path_buf(),
            state: Mutex::new(RepositoryState {
                connection: Some(connection),
                initialization_error: None,
            }),
        })
    }

    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &state.initialization_error {
            return Err(error.clone());
        }
        let connection = state
            .connection
            .as_mut()
            .ok_or("Xiao state database is unavailable.")?;
        operation(connection)
    }

    pub fn load_workspace(
        &self,
        workspace_path: &str,
        include_active_timeline: bool,
    ) -> Result<Option<XiaoWorkspaceDocument>, String> {
        self.with_connection(|connection| {
            load_workspace_from_connection(
                connection,
                &normalize_workspace_path(workspace_path),
                include_active_timeline,
                false,
            )
        })
    }

    pub fn load_timeline_page(
        &self,
        workspace_path: &str,
        task_id: &str,
        before: Option<usize>,
        limit: Option<usize>,
    ) -> Result<XiaoTimelinePage, String> {
        self.with_connection(|connection| {
            load_timeline_page_from_connection(
                connection,
                &normalize_workspace_path(workspace_path),
                task_id,
                before,
                limit,
            )
        })
    }

    pub fn save_workspace(&self, update: XiaoWorkspaceUpdate) -> Result<(), String> {
        self.with_connection(|connection| save_workspace_update(connection, update, false))
    }

    #[cfg(test)]
    fn save_workspace_failing_before_commit(
        &self,
        update: XiaoWorkspaceUpdate,
    ) -> Result<(), String> {
        self.with_connection(|connection| save_workspace_update(connection, update, true))
    }

    pub fn list_projects(&self) -> Result<Vec<XiaoProjectSummary>, String> {
        self.with_connection(list_projects_from_connection)
    }

    pub(crate) fn app_data_dir(&self) -> PathBuf {
        self.app_data_dir.clone()
    }

    pub(crate) fn task_execution_binding(
        &self,
        workspace_path: &str,
        task_id: &str,
    ) -> Result<TaskExecutionBinding, String> {
        self.with_connection(|connection| {
            load_task_execution_binding(
                connection,
                &normalize_workspace_path(workspace_path),
                task_id,
            )
        })
    }

    pub(crate) fn begin_managed_worktree(
        &self,
        record: NewManagedWorktreeRecord,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start managed worktree setup: {error}"))?;
            let (workspace_mode, managed_worktree_id): (String, Option<String>) = transaction
                .query_row(
                    r#"SELECT workspace_mode, managed_worktree_id FROM tasks
                     WHERE workspace_id = ?1 AND task_id = ?2"#,
                    params![record.workspace_id, record.task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| format!("Could not load task worktree binding: {error}"))?;
            if workspace_mode != "local" || managed_worktree_id.is_some() {
                return Err("The Xiao task already has an execution worktree.".to_owned());
            }
            transaction
                .execute(
                    r#"INSERT INTO managed_worktrees(
                        id, workspace_id, task_id, run_id, repository_root,
                        repository_common_dir_sha256, checkout_path, execution_root,
                        branch, base_commit, owner_marker_path, status, failure_reason,
                        created_at, removed_at
                     ) VALUES (
                        ?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        'preparing', NULL, ?11, NULL
                     )"#,
                    params![
                        record.id,
                        record.workspace_id,
                        record.task_id,
                        record.repository_root,
                        record.repository_common_dir_sha256,
                        record.checkout_path,
                        record.execution_root,
                        record.branch,
                        record.base_commit,
                        record.owner_marker_path,
                        record.created_at
                    ],
                )
                .map_err(|error| {
                    format!("Could not reserve managed worktree ownership: {error}")
                })?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit managed worktree setup: {error}"))
        })
    }

    pub(crate) fn activate_managed_worktree(
        &self,
        worktree_id: &str,
        checkout_path: &str,
        execution_root: &str,
        owner_marker_path: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start worktree activation: {error}"))?;
            let (workspace_id, task_id, status): (i64, String, String) = transaction
                .query_row(
                    "SELECT workspace_id, task_id, status FROM managed_worktrees WHERE id = ?1",
                    [worktree_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|error| format!("Could not load prepared worktree: {error}"))?;
            if status != "preparing" {
                return Err("The managed worktree is not awaiting activation.".to_owned());
            }
            let changed = transaction
                .execute(
                    r#"UPDATE managed_worktrees SET
                        checkout_path = ?1, execution_root = ?2, owner_marker_path = ?3,
                        status = 'active', failure_reason = NULL
                     WHERE id = ?4 AND status = 'preparing'"#,
                    params![
                        checkout_path,
                        execution_root,
                        owner_marker_path,
                        worktree_id
                    ],
                )
                .map_err(|error| format!("Could not activate managed worktree record: {error}"))?;
            if changed != 1 {
                return Err(
                    "Managed worktree activation lost its ownership reservation.".to_owned(),
                );
            }
            let task_changed = transaction
                .execute(
                    r#"UPDATE tasks SET workspace_mode = 'managed-worktree',
                        managed_worktree_id = ?1
                     WHERE workspace_id = ?2 AND task_id = ?3
                       AND workspace_mode = 'local' AND managed_worktree_id IS NULL"#,
                    params![worktree_id, workspace_id, task_id],
                )
                .map_err(|error| format!("Could not bind task to managed worktree: {error}"))?;
            if task_changed != 1 {
                return Err("The Xiao task execution binding changed during setup.".to_owned());
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit worktree activation: {error}"))
        })
    }

    pub(crate) fn fail_managed_worktree(
        &self,
        worktree_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let reason = bounded_diagnostic(reason);
        self.with_connection(|connection| {
            connection
                .execute(
                    r#"UPDATE managed_worktrees SET status = 'failed', failure_reason = ?1
                     WHERE id = ?2 AND status = 'preparing'"#,
                    params![reason, worktree_id],
                )
                .map_err(|error| format!("Could not record managed worktree failure: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn begin_managed_worktree_removal(
        &self,
        workspace_path: &str,
        task_id: &str,
        worktree_id: &str,
    ) -> Result<ManagedWorktreeRecord, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not start managed worktree removal: {error}"))?;
            let binding = load_task_execution_binding(
                &transaction,
                &normalize_workspace_path(workspace_path),
                task_id,
            )?;
            let record = binding
                .managed_worktree
                .ok_or("The Xiao task has no managed worktree.")?;
            if record.id != worktree_id {
                return Err("The managed worktree does not belong to this task.".to_owned());
            }
            match record.status {
                ManagedWorktreeStatus::Active => {
                    let changed = transaction
                        .execute(
                            "UPDATE managed_worktrees SET status = 'removing' WHERE id = ?1 AND status = 'active'",
                            [worktree_id],
                        )
                        .map_err(|error| format!("Could not reserve worktree removal: {error}"))?;
                    if changed != 1 {
                        return Err("Managed worktree removal reservation was lost.".to_owned());
                    }
                }
                ManagedWorktreeStatus::Removing => {}
                _ => return Err("Only active managed worktrees can be removed.".to_owned()),
            }
            transaction
                .commit()
                .map_err(|error| format!("Could not commit worktree removal intent: {error}"))?;
            Ok(ManagedWorktreeRecord {
                status: ManagedWorktreeStatus::Removing,
                ..record
            })
        })
    }

    pub(crate) fn finish_managed_worktree_removal(&self, worktree_id: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Could not finish managed worktree removal: {error}"))?;
            let (workspace_id, task_id, status): (i64, String, String) = transaction
                .query_row(
                    "SELECT workspace_id, task_id, status FROM managed_worktrees WHERE id = ?1",
                    [worktree_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|error| format!("Could not load removing worktree: {error}"))?;
            if status != "removing" {
                return Err("The managed worktree is not reserved for removal.".to_owned());
            }
            let environment_id: String = transaction
                .query_row(
                    "SELECT id FROM execution_environments WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not restore local task environment: {error}"))?;
            let task_changed = transaction
                .execute(
                    r#"UPDATE tasks SET execution_environment_id = ?1,
                        workspace_mode = 'local', managed_worktree_id = NULL
                     WHERE workspace_id = ?2 AND task_id = ?3
                       AND managed_worktree_id = ?4"#,
                    params![environment_id, workspace_id, task_id, worktree_id],
                )
                .map_err(|error| format!("Could not restore task Local mode: {error}"))?;
            if task_changed != 1 {
                return Err("The task no longer matches the removing worktree.".to_owned());
            }
            transaction
                .execute(
                    r#"UPDATE managed_worktrees SET status = 'removed', removed_at = ?1,
                        failure_reason = NULL WHERE id = ?2 AND status = 'removing'"#,
                    params![now_millis()?, worktree_id],
                )
                .map_err(|error| format!("Could not mark managed worktree removed: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit managed worktree removal: {error}"))
        })
    }

    pub(crate) fn list_managed_worktree_records(
        &self,
        workspace_path: &str,
    ) -> Result<Vec<ManagedWorktreeRecord>, String> {
        self.with_connection(|connection| {
            let workspace_id = workspace_id(connection, &normalize_workspace_path(workspace_path))?;
            let mut statement = connection
                .prepare(
                    r#"SELECT id, workspace_id, task_id, run_id, repository_root,
                        repository_common_dir_sha256, checkout_path, execution_root,
                        branch, base_commit, owner_marker_path, status, failure_reason,
                        created_at, removed_at
                     FROM managed_worktrees
                     WHERE workspace_id = ?1 AND status != 'removed'
                     ORDER BY created_at DESC"#,
                )
                .map_err(|error| format!("Could not prepare managed worktree list: {error}"))?;
            let rows = statement
                .query_map([workspace_id], managed_worktree_from_row)
                .map_err(|error| format!("Could not query managed worktrees: {error}"))?;
            rows.map(|row| {
                let row =
                    row.map_err(|error| format!("Could not decode managed worktree: {error}"))?;
                decode_managed_worktree(row)
            })
            .collect()
        })
    }
}

fn open_connection(
    app_data_dir: &Path,
    options: RepositoryOpenOptions,
) -> Result<Connection, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "Could not create Xiao state directory {}: {error}",
            app_data_dir.display()
        )
    })?;
    let database_path = app_data_dir.join(DATABASE_FILE_NAME);
    let mut connection = Connection::open(&database_path).map_err(|error| {
        format!(
            "Could not open Xiao state database {}: {error}",
            database_path.display()
        )
    })?;
    configure_connection(&mut connection)?;
    apply_migrations(&mut connection)?;
    migrate_legacy_store(
        &mut connection,
        app_data_dir,
        options.fail_legacy_before_commit,
    )?;
    Ok(connection)
}

fn configure_connection(connection: &mut Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Could not configure Xiao database busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not enable Xiao database foreign keys: {error}"))?;
    let journal_mode = (0..20)
        .find_map(|attempt| {
            match connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
                row.get::<_, String>(0)
            }) {
                Ok(mode) => Some(Ok(mode)),
                Err(error)
                    if attempt < 19
                        && matches!(
                            error.sqlite_error_code(),
                            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                        ) =>
                {
                    std::thread::sleep(Duration::from_millis(25));
                    None
                }
                Err(error) => Some(Err(error)),
            }
        })
        .expect("WAL configuration retry loop must return on its final attempt")
        .map_err(|error| format!("Could not enable Xiao database WAL mode: {error}"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(format!(
            "Xiao database did not enter WAL mode (reported `{journal_mode}`)."
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Could not enable full Xiao database sync: {error}"))?;
    Ok(())
}

fn apply_migrations(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );"#,
        )
        .map_err(|error| format!("Could not initialize Xiao database migrations: {error}"))?;

    let newest: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not read Xiao database schema version: {error}"))?;
    if newest > XIAO_DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Xiao state database schema {newest} is newer than this app supports ({}).",
            XIAO_DATABASE_SCHEMA_VERSION
        ));
    }

    let migrations = [
        (1_i64, "durable_workspace_and_run_store", MIGRATION_1_SQL),
        (
            2_i64,
            "execution_environments_and_managed_worktrees",
            MIGRATION_2_SQL,
        ),
        (3_i64, "native_durable_run_queue", MIGRATION_3_SQL),
        (4_i64, "native_durable_routines", MIGRATION_4_SQL),
    ];
    for (version, name, sql) in migrations {
        let already_applied = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Could not inspect Xiao migration {version}: {error}"))?
            .is_some();
        if already_applied {
            continue;
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Xiao migration {version}: {error}"))?;
        let applied_while_waiting = transaction
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                [version],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Could not recheck Xiao migration {version}: {error}"))?
            .is_some();
        if applied_while_waiting {
            transaction.commit().map_err(|error| {
                format!("Could not finish Xiao migration {version} check: {error}")
            })?;
            continue;
        }
        transaction
            .execute_batch(sql)
            .map_err(|error| format!("Could not apply Xiao migration {version}: {error}"))?;
        if version == 2 {
            backfill_execution_environments(&transaction)?;
        }
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![version, name, now_millis()?],
            )
            .map_err(|error| format!("Could not record Xiao migration {version}: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Xiao migration {version}: {error}"))?;
    }
    Ok(())
}

fn backfill_execution_environments(transaction: &Transaction<'_>) -> Result<(), String> {
    let workspaces = {
        let mut statement = transaction
            .prepare("SELECT id, workspace_path, public_id FROM workspaces ORDER BY id")
            .map_err(|error| {
                format!("Could not prepare execution environment backfill: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| format!("Could not query execution environment backfill: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode execution environment backfill: {error}"))?
    };
    let timestamp = now_millis()?;
    for (workspace_id, workspace_path, existing_public_id) in workspaces {
        let public_id = existing_public_id.unwrap_or_else(new_uuid_v7);
        transaction
            .execute(
                "UPDATE workspaces SET public_id = ?1 WHERE id = ?2",
                params![public_id, workspace_id],
            )
            .map_err(|error| format!("Could not assign Xiao workspace identity: {error}"))?;
        let environment_id = new_uuid_v7();
        let availability = if Path::new(&workspace_path).is_dir() {
            "available"
        } else {
            "unavailable"
        };
        transaction
            .execute(
                r#"INSERT INTO execution_environments(
                    id, workspace_id, kind, label, workspace_root, availability,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'windows', 'Windows local', ?3, ?4, ?5, ?5)"#,
                params![
                    environment_id,
                    workspace_id,
                    workspace_path,
                    availability,
                    timestamp
                ],
            )
            .map_err(|error| format!("Could not backfill Xiao execution environment: {error}"))?;
        transaction
            .execute(
                r#"UPDATE tasks SET execution_environment_id = ?1,
                    workspace_mode = 'local', managed_worktree_id = NULL
                 WHERE workspace_id = ?2"#,
                params![environment_id, workspace_id],
            )
            .map_err(|error| format!("Could not bind Xiao tasks to local execution: {error}"))?;
    }

    let incomplete_workspaces: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE public_id IS NULL OR public_id = ''",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify Xiao workspace identities: {error}"))?;
    let incomplete_tasks: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE execution_environment_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify Xiao task environments: {error}"))?;
    if incomplete_workspaces != 0 || incomplete_tasks != 0 {
        return Err("Execution environment migration verification failed.".to_owned());
    }
    Ok(())
}

fn migrate_legacy_store(
    connection: &mut Connection,
    app_data_dir: &Path,
    fail_before_commit: bool,
) -> Result<(), String> {
    let already_imported = connection
        .query_row(
            "SELECT 1 FROM legacy_imports WHERE source_name = ?1",
            [LEGACY_STORE_FILE_NAME],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Xiao legacy migration marker: {error}"))?
        .is_some();
    if already_imported {
        return Ok(());
    }

    let legacy_path = app_data_dir.join(LEGACY_STORE_FILE_NAME);
    if !legacy_path.exists() {
        return Ok(());
    }

    let source_bytes = fs::read(&legacy_path).map_err(|error| {
        format!(
            "Could not read legacy Xiao state {}: {error}",
            legacy_path.display()
        )
    })?;
    let source_sha256 = sha256_hex(&source_bytes);
    let mut store: XiaoLegacyStore = serde_json::from_slice(&source_bytes)
        .map_err(|error| format!("Invalid legacy Xiao state file: {error}"))?;
    normalize_legacy_store(&mut store)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start legacy Xiao migration: {error}"))?;
    let imported_while_waiting = transaction
        .query_row(
            "SELECT 1 FROM legacy_imports WHERE source_name = ?1",
            [LEGACY_STORE_FILE_NAME],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not recheck Xiao legacy migration marker: {error}"))?
        .is_some();
    if imported_while_waiting {
        return transaction
            .commit()
            .map_err(|error| format!("Could not finish Xiao legacy migration check: {error}"));
    }
    let existing_workspaces: i64 = transaction
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .map_err(|error| format!("Could not inspect Xiao state before migration: {error}"))?;
    if existing_workspaces != 0 {
        return Err(
            "Xiao found legacy JSON beside a non-empty unmarked database and refused to merge them automatically."
                .to_owned(),
        );
    }

    let backup_path = ensure_legacy_backup(app_data_dir, &source_bytes, &source_sha256)?;
    let backup_name = backup_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Legacy Xiao backup file name is invalid.")?
        .to_owned();

    let workspace_count = store.workspaces.len();
    let task_count = store
        .workspaces
        .iter()
        .map(|workspace| workspace.tasks.len())
        .sum::<usize>();
    let timeline_entry_count = store
        .workspaces
        .iter()
        .flat_map(|workspace| &workspace.tasks)
        .map(|task| task.timeline.len())
        .sum::<usize>();
    let expected_hashes = store
        .workspaces
        .iter()
        .map(|workspace| {
            Ok((
                workspace.workspace_path.clone(),
                canonical_document_hash(workspace)?,
            ))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;

    for workspace in &store.workspaces {
        apply_workspace_update(&transaction, document_as_update(workspace.clone()))?;
    }
    verify_legacy_import(
        &transaction,
        workspace_count,
        task_count,
        timeline_entry_count,
        &expected_hashes,
    )?;
    transaction
        .execute(
            r#"INSERT INTO legacy_imports(
                source_name, source_sha256, backup_name, imported_at,
                workspace_count, task_count, timeline_entry_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                LEGACY_STORE_FILE_NAME,
                source_sha256,
                backup_name,
                now_millis()?,
                to_i64(workspace_count, "workspace count")?,
                to_i64(task_count, "task count")?,
                to_i64(timeline_entry_count, "timeline entry count")?,
            ],
        )
        .map_err(|error| format!("Could not record legacy Xiao migration: {error}"))?;
    #[cfg(debug_assertions)]
    if let Some(pause_ms) = std::env::var_os("XIAO_TEST_MIGRATION_PAUSE_MS")
        .and_then(|value| value.to_string_lossy().parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= 60_000)
    {
        std::thread::sleep(Duration::from_millis(pause_ms));
    }
    if fail_before_commit {
        return Err("Injected failure before legacy migration commit.".to_owned());
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit legacy Xiao migration: {error}"))
}

fn ensure_legacy_backup(
    app_data_dir: &Path,
    source_bytes: &[u8],
    source_sha256: &str,
) -> Result<PathBuf, String> {
    let backup_name = format!(
        "{LEGACY_STORE_FILE_NAME}.{}.pre-sqlite.bak",
        &source_sha256[..16]
    );
    let backup_path = app_data_dir.join(&backup_name);
    if backup_path.exists() {
        verify_legacy_backup(&backup_path, source_bytes)?;
        return Ok(backup_path);
    }

    let temporary_path = app_data_dir.join(format!(".{backup_name}.tmp"));
    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|error| {
            format!(
                "Could not remove interrupted Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
    }
    let result = (|| {
        let mut backup = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| {
                format!(
                    "Could not create temporary Xiao backup {}: {error}",
                    temporary_path.display()
                )
            })?;
        backup.write_all(source_bytes).map_err(|error| {
            format!(
                "Could not write temporary Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
        backup.sync_all().map_err(|error| {
            format!(
                "Could not sync temporary Xiao backup {}: {error}",
                temporary_path.display()
            )
        })?;
        drop(backup);
        fs::rename(&temporary_path, &backup_path).map_err(|error| {
            format!(
                "Could not finalize legacy Xiao backup {}: {error}",
                backup_path.display()
            )
        })?;
        sync_directory(app_data_dir)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(backup_path)
}

fn verify_legacy_backup(backup_path: &Path, source_bytes: &[u8]) -> Result<(), String> {
    let existing = fs::read(backup_path).map_err(|error| {
        format!(
            "Could not verify legacy Xiao backup {}: {error}",
            backup_path.display()
        )
    })?;
    if existing != source_bytes {
        return Err(format!(
            "Legacy Xiao backup {} exists with different contents.",
            backup_path.display()
        ));
    }
    Ok(())
}

fn verify_legacy_import(
    connection: &Connection,
    expected_workspaces: usize,
    expected_tasks: usize,
    expected_timeline_entries: usize,
    expected_hashes: &HashMap<String, String>,
) -> Result<(), String> {
    let workspace_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify migrated workspaces: {error}"))?;
    let task_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify migrated tasks: {error}"))?;
    let timeline_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM task_timeline_entries", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not verify migrated timeline entries: {error}"))?;
    if workspace_count != to_i64(expected_workspaces, "workspace count")?
        || task_count != to_i64(expected_tasks, "task count")?
        || timeline_count != to_i64(expected_timeline_entries, "timeline entry count")?
    {
        return Err("Legacy Xiao migration count verification failed.".to_owned());
    }

    for (workspace_path, expected_hash) in expected_hashes {
        let document = load_workspace_from_connection(connection, workspace_path, true, true)?
            .ok_or_else(|| format!("Migrated workspace `{workspace_path}` was not found."))?;
        let actual_hash = canonical_document_hash(&document)?;
        if &actual_hash != expected_hash {
            return Err(format!(
                "Legacy Xiao migration field verification failed for `{workspace_path}`."
            ));
        }
    }
    Ok(())
}

fn normalize_legacy_store(store: &mut XiaoLegacyStore) -> Result<(), String> {
    if store.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported legacy Xiao state schema version {}.",
            store.schema_version
        ));
    }

    let mut workspaces: Vec<XiaoWorkspaceDocument> = Vec::new();
    for mut document in std::mem::take(&mut store.workspaces) {
        document.workspace_path = normalize_workspace_path(&document.workspace_path);
        prepare_legacy_document(&mut document);
        remove_empty_bootstrap_tasks(&mut document);
        if let Some(existing) = workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_path == document.workspace_path)
        {
            merge_workspace_documents(existing, document);
            remove_empty_bootstrap_tasks(existing);
        } else {
            workspaces.push(document);
        }
    }
    for document in &workspaces {
        validate_document(document)?;
    }
    store.workspaces = workspaces;
    Ok(())
}

fn prepare_legacy_document(document: &mut XiaoWorkspaceDocument) {
    for task in &mut document.tasks {
        let legacy_thread_id = task.thread_id.take();
        if task.thread_binding.is_none() {
            task.thread_binding = legacy_thread_id.map(|thread_id| XiaoThreadBinding {
                thread_id,
                persistence: XiaoThreadPersistence::LegacyUntrusted,
                materialized: false,
                thread_source: None,
                cli_version: None,
            });
        }
        task.timeline_loaded = true;
        task.timeline_complete = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
        task.execution_environment_id = None;
        task.workspace_mode = XiaoWorkspaceMode::Local;
        task.managed_worktree_id = None;
    }
}

fn save_workspace_update(
    connection: &mut Connection,
    update: XiaoWorkspaceUpdate,
    fail_before_commit: bool,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Xiao workspace update: {error}"))?;
    apply_workspace_update(&transaction, update)?;
    if fail_before_commit {
        return Err("Injected failure before Xiao workspace commit.".to_owned());
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Xiao workspace update: {error}"))
}

fn apply_workspace_update(
    transaction: &Transaction<'_>,
    mut update: XiaoWorkspaceUpdate,
) -> Result<(), String> {
    update.workspace_path = normalize_workspace_path(&update.workspace_path);
    validate_update(&update)?;

    transaction
        .execute(
            r#"INSERT INTO workspaces(
                workspace_path, active_task_id, show_archived, updated_at, public_id
             ) VALUES (?1, NULL, ?2, 0, ?3)
             ON CONFLICT(workspace_path) DO NOTHING"#,
            params![
                update.workspace_path,
                bool_to_i64(update.show_archived),
                new_uuid_v7()
            ],
        )
        .map_err(|error| format!("Could not create Xiao workspace record: {error}"))?;
    let workspace_id = workspace_id(transaction, &update.workspace_path)?;
    let environment = ensure_local_environment(transaction, workspace_id, &update.workspace_path)?;
    let existing_task_ids = task_ids(transaction, workspace_id)?;

    for task in &mut update.tasks {
        prepare_task_for_save(task)?;
        let existed = existing_task_ids.contains(&task.id);
        if !task.timeline_complete && !existed {
            return Err(format!(
                "New Xiao task `{}` cannot be saved with partial timeline data.",
                task.id
            ));
        }
        upsert_task(transaction, workspace_id, &environment.id, task)?;
        if task.timeline_complete {
            replace_task_timeline_if_changed(transaction, workspace_id, task)?;
        }
    }

    let desired_ids = update.task_ids.iter().cloned().collect::<HashSet<_>>();
    for existing_id in existing_task_ids.difference(&desired_ids) {
        let active_runs: i64 = transaction
            .query_row(
                r#"SELECT COUNT(*) FROM runs
                 WHERE workspace_id = ?1 AND task_id = ?2
                   AND status IN ('queued', 'preparing', 'running', 'waiting_for_input', 'verifying')"#,
                params![workspace_id, existing_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect task run ownership: {error}"))?;
        if active_runs != 0 {
            return Err(format!(
                "Cancel active Xiao runs before removing task `{existing_id}`."
            ));
        }
        let routine_count: i64 = transaction
            .query_row(
                r#"SELECT COUNT(*) FROM routines
                 WHERE workspace_id = ?1 AND task_id = ?2"#,
                params![workspace_id, existing_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect task routine ownership: {error}"))?;
        if routine_count != 0 {
            return Err(format!(
                "Task `{existing_id}` cannot be removed because Xiao routine history is attached to it."
            ));
        }
        let owned_worktrees: i64 = transaction
            .query_row(
                r#"SELECT COUNT(*) FROM managed_worktrees
                 WHERE workspace_id = ?1 AND task_id = ?2 AND status != 'removed'"#,
                params![workspace_id, existing_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect task worktree ownership: {error}"))?;
        if owned_worktrees != 0 {
            return Err(format!(
                "Clean up Xiao-managed worktrees before removing task `{existing_id}`."
            ));
        }
        transaction
            .execute(
                "DELETE FROM tasks WHERE workspace_id = ?1 AND task_id = ?2",
                params![workspace_id, existing_id],
            )
            .map_err(|error| format!("Could not remove Xiao task `{existing_id}`: {error}"))?;
    }

    for (position, task_id) in update.task_ids.iter().enumerate() {
        let changed = transaction
            .execute(
                "UPDATE tasks SET position = ?1 WHERE workspace_id = ?2 AND task_id = ?3",
                params![to_i64(position, "task position")?, workspace_id, task_id],
            )
            .map_err(|error| format!("Could not order Xiao task `{task_id}`: {error}"))?;
        if changed != 1 {
            return Err(format!(
                "Xiao workspace update did not include data for new task `{task_id}`."
            ));
        }
    }

    let task_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not verify Xiao workspace task count: {error}"))?;
    if task_count != to_i64(update.task_ids.len(), "task count")? {
        return Err("Xiao workspace task count verification failed.".to_owned());
    }

    let updated_at: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM tasks WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not calculate Xiao workspace update time: {error}"))?;
    transaction
        .execute(
            r#"UPDATE workspaces SET active_task_id = ?1, show_archived = ?2, updated_at = ?3
             WHERE id = ?4"#,
            params![
                update.active_task_id,
                bool_to_i64(update.show_archived),
                updated_at,
                workspace_id
            ],
        )
        .map_err(|error| format!("Could not update Xiao workspace record: {error}"))?;
    Ok(())
}

fn validate_update(update: &XiaoWorkspaceUpdate) -> Result<(), String> {
    if update.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Xiao workspace schema version {}.",
            update.schema_version
        ));
    }
    if update.workspace_path.trim().is_empty() {
        return Err("Xiao workspace path cannot be empty.".to_owned());
    }

    let mut task_ids = HashSet::new();
    for task_id in &update.task_ids {
        if task_id.trim().is_empty() || !task_ids.insert(task_id) {
            return Err("Xiao workspace task ids must be non-empty and unique.".to_owned());
        }
    }
    if update
        .active_task_id
        .as_ref()
        .is_some_and(|id| !task_ids.contains(id))
    {
        return Err("The active Xiao task does not exist in this workspace.".to_owned());
    }

    let mut changed_ids = HashSet::new();
    for task in &update.tasks {
        validate_task(task)?;
        if !task_ids.contains(&task.id) {
            return Err(format!(
                "Updated Xiao task `{}` is not present in taskIds.",
                task.id
            ));
        }
        if !changed_ids.insert(&task.id) {
            return Err(format!("Duplicate updated Xiao task `{}`.", task.id));
        }
    }
    Ok(())
}

fn validate_document(document: &XiaoWorkspaceDocument) -> Result<(), String> {
    validate_update(&document_as_update(document.clone()))
}

fn validate_task(task: &XiaoTaskDocument) -> Result<(), String> {
    if task.id.trim().is_empty() || task.title.trim().is_empty() {
        return Err("Xiao task ids and titles cannot be empty.".to_owned());
    }
    if let Some(binding) = &task.thread_binding {
        if binding.thread_id.trim().is_empty() {
            return Err("Xiao thread binding id cannot be empty.".to_owned());
        }
    }
    if task.timeline_complete && task.timeline_start != 0 {
        return Err(format!(
            "Complete Xiao task `{}` timeline must start at zero.",
            task.id
        ));
    }
    Ok(())
}

fn prepare_task_for_save(task: &mut XiaoTaskDocument) -> Result<(), String> {
    if task
        .thread_binding
        .as_ref()
        .is_some_and(|binding| binding.persistence == XiaoThreadPersistence::Persistent)
    {
        task.thread_binding = None;
        task.thread_id = None;
    }
    if task.thread_binding.is_none() {
        task.thread_binding = task.thread_id.take().map(|thread_id| XiaoThreadBinding {
            thread_id,
            persistence: XiaoThreadPersistence::Ephemeral,
            materialized: false,
            thread_source: Some("xiao-workbench".to_owned()),
            cli_version: None,
        });
    } else {
        task.thread_id = None;
    }
    if task.timeline_complete {
        task.timeline_loaded = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
    }
    validate_task(task)
}

fn upsert_task(
    connection: &Connection,
    workspace_id: i64,
    execution_environment_id: &str,
    task: &XiaoTaskDocument,
) -> Result<(), String> {
    let follow_ups_json = json_string(&task.follow_ups, "task follow-ups")?;
    let thread_binding_json = optional_json_string(task.thread_binding.as_ref(), "thread binding")?;
    let goal_json = optional_json_string(task.goal.as_ref(), "task goal")?;
    let plan_json = optional_json_string(task.plan.as_ref(), "task plan")?;
    connection
        .execute(
            r#"INSERT INTO tasks(
                workspace_id, task_id, position, title, created_at, updated_at, draft_text,
                follow_ups_json, archived, pinned, unread, model, reasoning_effort,
                thread_binding_json, mode, approval_policy, sandbox_mode, goal_json, plan_json,
                execution_environment_id, workspace_mode, managed_worktree_id
             ) VALUES (
                ?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'local', NULL
             )
             ON CONFLICT(workspace_id, task_id) DO UPDATE SET
                title = excluded.title, created_at = excluded.created_at,
                updated_at = excluded.updated_at, draft_text = excluded.draft_text,
                follow_ups_json = excluded.follow_ups_json, archived = excluded.archived,
                pinned = excluded.pinned, unread = excluded.unread, model = excluded.model,
                reasoning_effort = excluded.reasoning_effort,
                thread_binding_json = CASE
                    WHEN json_extract(tasks.thread_binding_json, '$.persistence') = 'persistent'
                    THEN tasks.thread_binding_json
                    ELSE excluded.thread_binding_json
                END,
                mode = excluded.mode,
                approval_policy = excluded.approval_policy, sandbox_mode = excluded.sandbox_mode,
                goal_json = excluded.goal_json, plan_json = excluded.plan_json"#,
            params![
                workspace_id,
                task.id,
                task.title,
                task.created_at,
                task.updated_at,
                task.draft_text,
                follow_ups_json,
                bool_to_i64(task.archived),
                bool_to_i64(task.pinned),
                bool_to_i64(task.unread),
                task.model,
                task.reasoning_effort,
                thread_binding_json,
                task.mode,
                task.approval_policy,
                task.sandbox_mode,
                goal_json,
                plan_json,
                execution_environment_id,
            ],
        )
        .map_err(|error| format!("Could not save Xiao task `{}`: {error}", task.id))?;
    Ok(())
}

fn replace_task_timeline_if_changed(
    connection: &Connection,
    workspace_id: i64,
    task: &XiaoTaskDocument,
) -> Result<(), String> {
    let timeline_bytes = serde_json::to_vec(&task.timeline)
        .map_err(|error| format!("Could not serialize Xiao task timeline: {error}"))?;
    let desired_hash = sha256_hex(&timeline_bytes);
    let desired_count = to_i64(task.timeline.len(), "timeline entry count")?;
    let (current_hash, current_count): (Option<String>, i64) = connection
        .query_row(
            r#"SELECT timeline_sha256, timeline_entry_count FROM tasks
             WHERE workspace_id = ?1 AND task_id = ?2"#,
            params![workspace_id, task.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not inspect Xiao task timeline: {error}"))?;
    if current_hash.as_deref() == Some(desired_hash.as_str()) && current_count == desired_count {
        return Ok(());
    }

    connection
        .execute(
            "DELETE FROM task_timeline_entries WHERE workspace_id = ?1 AND task_id = ?2",
            params![workspace_id, task.id],
        )
        .map_err(|error| format!("Could not replace Xiao task timeline: {error}"))?;
    let mut statement = connection
        .prepare(
            r#"INSERT INTO task_timeline_entries(workspace_id, task_id, position, entry_json)
             VALUES (?1, ?2, ?3, ?4)"#,
        )
        .map_err(|error| format!("Could not prepare Xiao timeline write: {error}"))?;
    for (position, entry) in task.timeline.iter().enumerate() {
        statement
            .execute(params![
                workspace_id,
                task.id,
                to_i64(position, "timeline position")?,
                json_string(entry, "timeline entry")?,
            ])
            .map_err(|error| format!("Could not save Xiao timeline entry: {error}"))?;
    }
    drop(statement);
    connection
        .execute(
            r#"UPDATE tasks SET timeline_sha256 = ?1, timeline_entry_count = ?2
             WHERE workspace_id = ?3 AND task_id = ?4"#,
            params![desired_hash, desired_count, workspace_id, task.id],
        )
        .map_err(|error| format!("Could not record Xiao timeline identity: {error}"))?;
    Ok(())
}

fn load_workspace_from_connection(
    connection: &Connection,
    workspace_path: &str,
    include_active_timeline: bool,
    include_all_timelines: bool,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    let workspace = connection
        .query_row(
            "SELECT id, active_task_id, show_archived FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao workspace: {error}"))?;
    let Some((workspace_id, active_task_id, show_archived)) = workspace else {
        return Ok(None);
    };

    let mut tasks = load_task_metadata(connection, workspace_id)?;
    for task in &mut tasks {
        let should_load = include_all_timelines
            || (include_active_timeline && active_task_id.as_deref() == Some(task.id.as_str()));
        if should_load {
            let page = load_timeline_page_by_id(
                connection,
                workspace_id,
                &task.id,
                None,
                if include_all_timelines {
                    usize::MAX
                } else {
                    INITIAL_TIMELINE_PAGE_SIZE
                },
            )?;
            task.timeline = page.entries;
            task.timeline_loaded = true;
            task.timeline_complete = !page.has_more;
            task.timeline_start = page.start;
            task.timeline_entry_count = page.total;
        } else if task.timeline_entry_count == 0 {
            task.timeline_loaded = true;
            task.timeline_complete = true;
            task.timeline_start = 0;
        }
    }

    Ok(Some(XiaoWorkspaceDocument {
        schema_version: XIAO_SCHEMA_VERSION,
        workspace_path: workspace_path.to_owned(),
        active_task_id,
        show_archived,
        tasks,
    }))
}

fn load_task_metadata(
    connection: &Connection,
    workspace_id: i64,
) -> Result<Vec<XiaoTaskDocument>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT
                t.task_id, t.title, t.created_at, t.updated_at, t.draft_text,
                t.follow_ups_json, t.archived, t.pinned, t.unread, t.model,
                t.reasoning_effort, t.thread_binding_json, t.mode, t.approval_policy,
                t.sandbox_mode, t.goal_json, t.plan_json, t.timeline_entry_count,
                t.execution_environment_id, t.workspace_mode, t.managed_worktree_id
             FROM tasks t WHERE t.workspace_id = ?1 ORDER BY t.position ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao task load: {error}"))?;
    let rows = statement
        .query_map([workspace_id], |row| {
            Ok(StoredTaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                draft_text: row.get(4)?,
                follow_ups_json: row.get(5)?,
                archived: row.get::<_, i64>(6)? != 0,
                pinned: row.get::<_, i64>(7)? != 0,
                unread: row.get::<_, i64>(8)? != 0,
                model: row.get(9)?,
                reasoning_effort: row.get(10)?,
                thread_binding_json: row.get(11)?,
                mode: row.get(12)?,
                approval_policy: row.get(13)?,
                sandbox_mode: row.get(14)?,
                goal_json: row.get(15)?,
                plan_json: row.get(16)?,
                timeline_entry_count: row.get(17)?,
                execution_environment_id: row.get(18)?,
                workspace_mode: row.get(19)?,
                managed_worktree_id: row.get(20)?,
            })
        })
        .map_err(|error| format!("Could not query Xiao tasks: {error}"))?;

    rows.map(|row| {
        row.map_err(|error| format!("Could not decode Xiao task row: {error}"))?
            .into_document()
    })
    .collect()
}

struct StoredTaskRow {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    draft_text: String,
    follow_ups_json: String,
    archived: bool,
    pinned: bool,
    unread: bool,
    model: Option<String>,
    reasoning_effort: Option<String>,
    thread_binding_json: Option<String>,
    mode: String,
    approval_policy: String,
    sandbox_mode: String,
    goal_json: Option<String>,
    plan_json: Option<String>,
    timeline_entry_count: i64,
    execution_environment_id: Option<String>,
    workspace_mode: String,
    managed_worktree_id: Option<String>,
}

impl StoredTaskRow {
    fn into_document(self) -> Result<XiaoTaskDocument, String> {
        let timeline_entry_count = to_usize(self.timeline_entry_count, "timeline entry count")?;
        Ok(XiaoTaskDocument {
            id: self.id,
            title: self.title,
            created_at: self.created_at,
            updated_at: self.updated_at,
            draft_text: self.draft_text,
            follow_ups: parse_json(&self.follow_ups_json, "task follow-ups")?,
            archived: self.archived,
            pinned: self.pinned,
            unread: self.unread,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            thread_id: None,
            thread_binding: parse_optional_json(
                self.thread_binding_json.as_deref(),
                "thread binding",
            )?,
            mode: self.mode,
            approval_policy: self.approval_policy,
            sandbox_mode: self.sandbox_mode,
            goal: parse_optional_json(self.goal_json.as_deref(), "task goal")?,
            timeline: Vec::new(),
            timeline_loaded: false,
            timeline_complete: false,
            timeline_start: timeline_entry_count,
            timeline_entry_count,
            plan: parse_optional_json(self.plan_json.as_deref(), "task plan")?,
            execution_environment_id: self.execution_environment_id,
            workspace_mode: XiaoWorkspaceMode::from_database(&self.workspace_mode)?,
            managed_worktree_id: self.managed_worktree_id,
        })
    }
}

fn load_timeline_page_from_connection(
    connection: &Connection,
    workspace_path: &str,
    task_id: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<XiaoTimelinePage, String> {
    let workspace_id = connection
        .query_row(
            "SELECT id FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not find Xiao workspace for timeline: {error}"))?
        .ok_or("Xiao workspace was not found.")?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE workspace_id = ?1 AND task_id = ?2",
            params![workspace_id, task_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not find Xiao task timeline: {error}"))?
        .is_some();
    if !exists {
        return Err(format!("Xiao task `{task_id}` was not found."));
    }
    load_timeline_page_by_id(
        connection,
        workspace_id,
        task_id,
        before,
        limit
            .unwrap_or(DEFAULT_TIMELINE_PAGE_SIZE)
            .clamp(1, MAX_TIMELINE_PAGE_SIZE),
    )
}

fn load_timeline_page_by_id(
    connection: &Connection,
    workspace_id: i64,
    task_id: &str,
    before: Option<usize>,
    limit: usize,
) -> Result<XiaoTimelinePage, String> {
    let total: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM task_timeline_entries
             WHERE workspace_id = ?1 AND task_id = ?2"#,
            params![workspace_id, task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count Xiao timeline entries: {error}"))?;
    let total = to_usize(total, "timeline entry count")?;
    let before = before.unwrap_or(total).min(total);
    let start = before.saturating_sub(limit);
    let mut statement = connection
        .prepare(
            r#"SELECT entry_json FROM task_timeline_entries
             WHERE workspace_id = ?1 AND task_id = ?2 AND position >= ?3 AND position < ?4
             ORDER BY position ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao timeline page: {error}"))?;
    let rows = statement
        .query_map(
            params![
                workspace_id,
                task_id,
                to_i64(start, "timeline start")?,
                to_i64(before, "timeline end")?
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not query Xiao timeline page: {error}"))?;
    let entries = rows
        .map(|row| {
            let json =
                row.map_err(|error| format!("Could not decode Xiao timeline row: {error}"))?;
            parse_json(&json, "timeline entry")
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(XiaoTimelinePage {
        entries,
        start,
        total,
        has_more: start > 0,
    })
}

fn load_task_execution_binding(
    connection: &Connection,
    workspace_path: &str,
    task_id: &str,
) -> Result<TaskExecutionBinding, String> {
    let row = connection
        .query_row(
            r#"SELECT
                w.id, w.public_id, w.workspace_path, t.task_id, t.workspace_mode,
                e.id, e.kind, e.label, e.workspace_root, e.availability,
                t.managed_worktree_id
             FROM workspaces w
             JOIN tasks t ON t.workspace_id = w.id
             JOIN execution_environments e ON e.id = t.execution_environment_id
             WHERE w.workspace_path = ?1 AND t.task_id = ?2"#,
            params![workspace_path, task_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not load task execution binding: {error}"))?
        .ok_or_else(|| format!("Xiao task `{task_id}` was not found in this workspace."))?;
    let (
        workspace_id,
        workspace_public_id,
        project_path,
        task_id,
        workspace_mode,
        environment_id,
        environment_kind,
        environment_label,
        environment_root,
        environment_availability,
        managed_worktree_id,
    ) = row;
    let workspace_public_id = workspace_public_id
        .filter(|value| !value.trim().is_empty())
        .ok_or("The Xiao workspace is missing its durable identity.")?;
    let workspace_mode = XiaoWorkspaceMode::from_database(&workspace_mode)?;
    let managed_worktree = match managed_worktree_id {
        Some(worktree_id) => {
            let stored = connection
                .query_row(
                    r#"SELECT id, workspace_id, task_id, run_id, repository_root,
                        repository_common_dir_sha256, checkout_path, execution_root,
                        branch, base_commit, owner_marker_path, status, failure_reason,
                        created_at, removed_at
                     FROM managed_worktrees
                     WHERE id = ?1 AND workspace_id = ?2 AND task_id = ?3"#,
                    params![worktree_id, workspace_id, task_id],
                    managed_worktree_from_row,
                )
                .optional()
                .map_err(|error| format!("Could not load task managed worktree: {error}"))?
                .ok_or("The task references a missing managed worktree record.")?;
            Some(decode_managed_worktree(stored)?)
        }
        None => None,
    };
    match workspace_mode {
        XiaoWorkspaceMode::Local if managed_worktree.is_some() => {
            return Err("A Local task cannot reference a managed worktree.".to_owned());
        }
        XiaoWorkspaceMode::ManagedWorktree if managed_worktree.is_none() => {
            return Err("The managed task has no owned worktree record.".to_owned());
        }
        _ => {}
    }
    Ok(TaskExecutionBinding {
        workspace_id,
        workspace_public_id,
        project_path,
        task_id,
        workspace_mode,
        environment: ExecutionEnvironmentRecord {
            id: environment_id,
            kind: environment_kind,
            label: environment_label,
            workspace_root: environment_root,
            availability: environment_availability,
        },
        managed_worktree,
    })
}

struct StoredManagedWorktreeRow {
    id: String,
    workspace_id: i64,
    task_id: String,
    run_id: Option<String>,
    repository_root: String,
    repository_common_dir_sha256: String,
    checkout_path: String,
    execution_root: String,
    branch: String,
    base_commit: String,
    owner_marker_path: String,
    status: String,
    failure_reason: Option<String>,
    created_at: i64,
    removed_at: Option<i64>,
}

fn managed_worktree_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredManagedWorktreeRow> {
    Ok(StoredManagedWorktreeRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        task_id: row.get(2)?,
        run_id: row.get(3)?,
        repository_root: row.get(4)?,
        repository_common_dir_sha256: row.get(5)?,
        checkout_path: row.get(6)?,
        execution_root: row.get(7)?,
        branch: row.get(8)?,
        base_commit: row.get(9)?,
        owner_marker_path: row.get(10)?,
        status: row.get(11)?,
        failure_reason: row.get(12)?,
        created_at: row.get(13)?,
        removed_at: row.get(14)?,
    })
}

fn decode_managed_worktree(row: StoredManagedWorktreeRow) -> Result<ManagedWorktreeRecord, String> {
    Ok(ManagedWorktreeRecord {
        id: row.id,
        workspace_id: row.workspace_id,
        task_id: row.task_id,
        run_id: row.run_id,
        repository_root: row.repository_root,
        repository_common_dir_sha256: row.repository_common_dir_sha256,
        checkout_path: row.checkout_path,
        execution_root: row.execution_root,
        branch: row.branch,
        base_commit: row.base_commit,
        owner_marker_path: row.owner_marker_path,
        status: ManagedWorktreeStatus::from_database(&row.status)?,
        failure_reason: row.failure_reason,
        created_at: row.created_at,
        removed_at: row.removed_at,
    })
}

fn list_projects_from_connection(
    connection: &mut Connection,
) -> Result<Vec<XiaoProjectSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"SELECT workspace_path, updated_at,
                       (SELECT COUNT(*) FROM tasks WHERE tasks.workspace_id = workspaces.id)
                FROM workspaces
             ORDER BY updated_at DESC, workspace_path ASC"#,
        )
        .map_err(|error| format!("Could not prepare Xiao project list: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("Could not query Xiao projects: {error}"))?;
    rows.map(|row| {
        let (path, updated_at, task_count) =
            row.map_err(|error| format!("Could not decode Xiao project: {error}"))?;
        let name = PathBuf::from(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
            .to_owned();
        let task_count = usize::try_from(task_count)
            .map_err(|_| "Could not decode Xiao project task count.".to_owned())?;
        Ok(XiaoProjectSummary {
            path,
            name,
            updated_at,
            task_count,
        })
    })
    .collect()
}

fn ensure_local_environment(
    connection: &Connection,
    workspace_id: i64,
    workspace_path: &str,
) -> Result<ExecutionEnvironmentRecord, String> {
    let existing = connection
        .query_row(
            r#"SELECT id, kind, label, workspace_root, availability
             FROM execution_environments WHERE workspace_id = ?1"#,
            [workspace_id],
            |row| {
                Ok(ExecutionEnvironmentRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    label: row.get(2)?,
                    workspace_root: row.get(3)?,
                    availability: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Could not load Xiao execution environment: {error}"))?;
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let timestamp = now_millis()?;
    let environment = ExecutionEnvironmentRecord {
        id: new_uuid_v7(),
        kind: "windows".to_owned(),
        label: "Windows local".to_owned(),
        workspace_root: workspace_path.to_owned(),
        availability: if Path::new(workspace_path).is_dir() {
            "available".to_owned()
        } else {
            "unavailable".to_owned()
        },
    };
    connection
        .execute(
            r#"INSERT INTO execution_environments(
                id, workspace_id, kind, label, workspace_root, availability,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)"#,
            params![
                environment.id,
                workspace_id,
                environment.kind,
                environment.label,
                environment.workspace_root,
                environment.availability,
                timestamp
            ],
        )
        .map_err(|error| format!("Could not create Xiao execution environment: {error}"))?;
    Ok(environment)
}

fn workspace_id(connection: &Connection, workspace_path: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT id FROM workspaces WHERE workspace_path = ?1",
            [workspace_path],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not resolve Xiao workspace record: {error}"))
}

fn task_ids(connection: &Connection, workspace_id: i64) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT task_id FROM tasks WHERE workspace_id = ?1")
        .map_err(|error| format!("Could not prepare Xiao task identity query: {error}"))?;
    let rows = statement
        .query_map([workspace_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not query Xiao task identities: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("Could not decode Xiao task id: {error}")))
        .collect()
}

fn document_as_update(document: XiaoWorkspaceDocument) -> XiaoWorkspaceUpdate {
    XiaoWorkspaceUpdate {
        schema_version: document.schema_version,
        workspace_path: document.workspace_path,
        active_task_id: document.active_task_id,
        show_archived: document.show_archived,
        task_ids: document.tasks.iter().map(|task| task.id.clone()).collect(),
        tasks: document.tasks,
    }
}

fn canonical_document_hash(document: &XiaoWorkspaceDocument) -> Result<String, String> {
    let mut document = document.clone();
    for task in &mut document.tasks {
        task.thread_id = None;
        task.timeline_loaded = true;
        task.timeline_complete = true;
        task.timeline_start = 0;
        task.timeline_entry_count = task.timeline.len();
        task.execution_environment_id = None;
        task.workspace_mode = XiaoWorkspaceMode::Local;
        task.managed_worktree_id = None;
    }
    let bytes = serde_json::to_vec(&document)
        .map_err(|error| format!("Could not hash Xiao workspace document: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn remove_empty_bootstrap_tasks(document: &mut XiaoWorkspaceDocument) {
    let bootstrap_ids = document
        .tasks
        .iter()
        .filter(|task| {
            task.title == "New task"
                && !task.archived
                && !task.pinned
                && !task.unread
                && task.model.is_none()
                && task.reasoning_effort.is_none()
                && task.thread_binding.as_ref().is_none_or(|binding| {
                    binding.persistence == XiaoThreadPersistence::LegacyUntrusted
                })
                && task.mode == "default"
                && task.approval_policy == "on-request"
                && task.sandbox_mode == "workspace-write"
                && task.goal.is_none()
                && task.draft_text.trim().is_empty()
                && task.follow_ups.is_empty()
                && task.timeline.is_empty()
                && task.plan.is_none()
        })
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if bootstrap_ids.is_empty() {
        return;
    }
    document
        .tasks
        .retain(|task| !bootstrap_ids.contains(&task.id));
    if document
        .active_task_id
        .as_ref()
        .is_some_and(|id| bootstrap_ids.contains(id))
    {
        document.active_task_id = document
            .tasks
            .iter()
            .find(|task| !task.archived)
            .map(|task| task.id.clone());
    }
}

fn merge_workspace_documents(
    existing: &mut XiaoWorkspaceDocument,
    incoming: XiaoWorkspaceDocument,
) {
    let existing_updated_at = existing
        .tasks
        .iter()
        .map(|task| task.updated_at)
        .max()
        .unwrap_or_default();
    let incoming_updated_at = incoming
        .tasks
        .iter()
        .map(|task| task.updated_at)
        .max()
        .unwrap_or_default();

    for task in incoming.tasks {
        if let Some(current) = existing.tasks.iter_mut().find(|item| item.id == task.id) {
            if task.updated_at > current.updated_at {
                *current = task;
            }
        } else {
            existing.tasks.push(task);
        }
    }

    let incoming_active_exists = incoming
        .active_task_id
        .as_ref()
        .is_none_or(|id| existing.tasks.iter().any(|task| task.id == *id));
    if incoming_updated_at >= existing_updated_at && incoming_active_exists {
        existing.active_task_id = incoming.active_task_id;
        existing.show_archived = incoming.show_archived;
    }
}

pub(crate) fn normalize_workspace_path(path: &str) -> String {
    let path = PathBuf::from(path);
    let value = path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_owned();
        }
    }
    value
}

fn optional_json_string<T: Serialize>(
    value: Option<&T>,
    label: &str,
) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, label)).transpose()
}

fn json_string<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Could not serialize {label}: {error}"))
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    value: Option<&str>,
    label: &str,
) -> Result<Option<T>, String> {
    value.map(|value| parse_json(value, label)).transpose()
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("Could not deserialize {label}: {error}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn bounded_diagnostic(value: &str) -> String {
    const MAX_BYTES: usize = 4096;
    if value.len() <= MAX_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn to_i64(value: usize, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("Xiao {label} is too large."))
}

fn to_usize(value: i64, label: &str) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| format!("Xiao {label} is invalid."))
}

fn new_uuid_v7() -> String {
    Uuid::now_v7().to_string()
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp is too large.".to_owned())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync Xiao state directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    use serde_json::Value;

    use super::*;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-{label}-{}-{}-{}",
                std::process::id(),
                now_millis().unwrap(),
                TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn workspace(&self, name: &str) -> PathBuf {
            let path = self.path.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            for _ in 0..10 {
                if fs::remove_dir_all(&self.path).is_ok() || !self.path.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    fn timeline_entry(index: usize) -> Value {
        serde_json::json!({
            "id": format!("entry-{index}"),
            "kind": if index.is_multiple_of(2) { "user" } else { "result" },
            "title": format!("Entry {index}"),
            "body": format!("Body {index}"),
            "createdAt": index,
        })
    }

    fn task(id: &str, timeline_len: usize) -> XiaoTaskDocument {
        let timeline = (0..timeline_len).map(timeline_entry).collect::<Vec<_>>();
        XiaoTaskDocument {
            id: id.to_owned(),
            title: format!("Task {id}"),
            created_at: 10,
            updated_at: 20,
            draft_text: String::new(),
            follow_ups: Vec::new(),
            archived: false,
            pinned: false,
            unread: false,
            model: None,
            reasoning_effort: None,
            thread_id: None,
            thread_binding: None,
            mode: "default".to_owned(),
            approval_policy: "on-request".to_owned(),
            sandbox_mode: "workspace-write".to_owned(),
            goal: None,
            timeline,
            timeline_loaded: true,
            timeline_complete: true,
            timeline_start: 0,
            timeline_entry_count: timeline_len,
            plan: None,
            execution_environment_id: None,
            workspace_mode: XiaoWorkspaceMode::Local,
            managed_worktree_id: None,
        }
    }

    fn document(path: &Path, tasks: Vec<XiaoTaskDocument>) -> XiaoWorkspaceDocument {
        XiaoWorkspaceDocument {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: path.to_string_lossy().into_owned(),
            active_task_id: tasks.first().map(|task| task.id.clone()),
            show_archived: false,
            tasks,
        }
    }

    fn update(document: XiaoWorkspaceDocument) -> XiaoWorkspaceUpdate {
        document_as_update(document)
    }

    fn legacy_bytes(workspaces: Vec<XiaoWorkspaceDocument>) -> Vec<u8> {
        let mut value = serde_json::to_value(XiaoLegacyStore {
            schema_version: XIAO_SCHEMA_VERSION,
            workspaces,
        })
        .unwrap();
        for workspace in value["workspaces"].as_array_mut().unwrap() {
            for task in workspace["tasks"].as_array_mut().unwrap() {
                let task = task.as_object_mut().unwrap();
                task.remove("threadBinding");
                task.remove("timelineLoaded");
                task.remove("timelineComplete");
                task.remove("timelineStart");
                task.remove("timelineEntryCount");
                task.remove("executionEnvironmentId");
                task.remove("workspaceMode");
                task.remove("managedWorktreeId");
            }
        }
        serde_json::to_vec_pretty(&value).unwrap()
    }

    fn write_legacy(directory: &TestDirectory, workspaces: Vec<XiaoWorkspaceDocument>) -> Vec<u8> {
        let bytes = legacy_bytes(workspaces);
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), &bytes).unwrap();
        bytes
    }

    fn backup_path(directory: &TestDirectory, source: &[u8]) -> PathBuf {
        directory.path.join(format!(
            "{LEGACY_STORE_FILE_NAME}.{}.pre-sqlite.bak",
            &sha256_hex(source)[..16]
        ))
    }

    fn full_workspace(repository: &XiaoRepository, path: &Path) -> XiaoWorkspaceDocument {
        repository
            .with_connection(|connection| {
                load_workspace_from_connection(
                    connection,
                    &normalize_workspace_path(&path.to_string_lossy()),
                    true,
                    true,
                )
            })
            .unwrap()
            .unwrap()
    }

    #[test]
    fn fresh_database_applies_schema_and_pragmas_once() {
        let directory = TestDirectory::new("fresh-database");
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .with_connection(|connection| {
                    let migration_count: i64 = connection
                        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    let foreign_keys: i64 = connection
                        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let journal_mode: String = connection
                        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let synchronous: i64 = connection
                        .query_row("PRAGMA synchronous", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let pending_inputs: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'pending_inputs'",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    let runtime_generations: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'runtime_generations'",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    let run_generation_columns: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name IN ('execution_environment_id', 'input_json', 'runtime_generation', 'turn_id', 'cancel_requested')",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    let routine_tables: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('routines', 'routine_occurrences')",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    let routine_run_column: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'routine_occurrence_id'",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    assert_eq!(migration_count, XIAO_DATABASE_SCHEMA_VERSION);
                    assert_eq!(foreign_keys, 1);
                    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
                    assert_eq!(synchronous, 2);
                    assert_eq!(pending_inputs, 1);
                    assert_eq!(runtime_generations, 1);
                    assert_eq!(run_generation_columns, 5);
                    assert_eq!(routine_tables, 2);
                    assert_eq!(routine_run_column, 1);
                    Ok(())
                })
                .unwrap();
        }

        let reopened = XiaoRepository::open(&directory.path).unwrap();
        reopened
            .with_connection(|connection| {
                let migration_count: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(migration_count, XIAO_DATABASE_SCHEMA_VERSION);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn schema_v1_upgrade_backfills_local_execution_bindings() {
        let directory = TestDirectory::new("schema-v1-upgrade");
        let workspace = directory.workspace("workspace");
        {
            let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
            connection
                .execute_batch(
                    r#"CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                    );"#,
                )
                .unwrap();
            connection.execute_batch(MIGRATION_1_SQL).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'v1', 1)",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO workspaces(
                        id, workspace_path, active_task_id, show_archived, updated_at
                     ) VALUES (1, ?1, 'task', 0, 2)"#,
                    [workspace.to_string_lossy().into_owned()],
                )
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO tasks(
                        workspace_id, task_id, position, title, created_at, updated_at,
                        draft_text, follow_ups_json, archived, pinned, unread, model,
                        reasoning_effort, thread_binding_json, mode, approval_policy,
                        sandbox_mode, goal_json, plan_json, timeline_sha256,
                        timeline_entry_count
                     ) VALUES (
                        1, 'task', 0, 'Task', 1, 2, '', '[]', 0, 0, 0,
                        NULL, NULL, NULL, 'default', 'on-request', 'workspace-write',
                        NULL, NULL, NULL, 0
                     )"#,
                    [],
                )
                .unwrap();
        }

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let binding = repository
            .task_execution_binding(&workspace.to_string_lossy(), "task")
            .unwrap();
        assert_eq!(binding.workspace_mode, XiaoWorkspaceMode::Local);
        assert_eq!(binding.environment.kind, "windows");
        assert_eq!(
            normalize_workspace_path(&binding.environment.workspace_root),
            normalize_workspace_path(&workspace.to_string_lossy())
        );
        assert!(Uuid::parse_str(&binding.workspace_public_id).is_ok());
        assert!(Uuid::parse_str(&binding.environment.id).is_ok());
        repository
            .with_connection(|connection| {
                let versions: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(versions, XIAO_DATABASE_SCHEMA_VERSION);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn schema_v3_upgrade_adds_native_routines_once() {
        let directory = TestDirectory::new("schema-v3-routines-upgrade");
        let database_path = directory.path.join(DATABASE_FILE_NAME);
        {
            let mut connection = Connection::open(&database_path).unwrap();
            configure_connection(&mut connection).unwrap();
            connection
                .execute_batch(
                    r#"CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                    );"#,
                )
                .unwrap();
            connection.execute_batch(MIGRATION_1_SQL).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'v1', 1)",
                    [],
                )
                .unwrap();
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(MIGRATION_2_SQL).unwrap();
            backfill_execution_environments(&transaction).unwrap();
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (2, 'v2', 2)",
                    [],
                )
                .unwrap();
            transaction.commit().unwrap();
            connection.execute_batch(MIGRATION_3_SQL).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (3, 'v3', 3)",
                    [],
                )
                .unwrap();
        }

        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .with_connection(|connection| {
                let versions: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                let routine_tables: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('routines', 'routine_occurrences')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let routine_run_column: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'routine_occurrence_id'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(versions, XIAO_DATABASE_SCHEMA_VERSION);
                assert_eq!(routine_tables, 2);
                assert_eq!(routine_run_column, 1);
                Ok(())
            })
            .unwrap();
        drop(repository);
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .with_connection(|connection| {
                let versions: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(versions, XIAO_DATABASE_SCHEMA_VERSION);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn schema_v2_upgrade_preserves_existing_run_and_backfills_native_queue_fields() {
        let directory = TestDirectory::new("schema-v2-upgrade");
        let workspace = directory.path.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let database_path = directory.path.join(DATABASE_FILE_NAME);
        let environment_id;
        {
            let mut connection = Connection::open(&database_path).unwrap();
            configure_connection(&mut connection).unwrap();
            connection
                .execute_batch(
                    r#"CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                    );"#,
                )
                .unwrap();
            connection.execute_batch(MIGRATION_1_SQL).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'v1', 1)",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO workspaces(
                        id, workspace_path, active_task_id, show_archived, updated_at
                     ) VALUES (1, ?1, 'task', 0, 2)"#,
                    [workspace.to_string_lossy().into_owned()],
                )
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO tasks(
                        workspace_id, task_id, position, title, created_at, updated_at,
                        draft_text, follow_ups_json, archived, pinned, unread, model,
                        reasoning_effort, thread_binding_json, mode, approval_policy,
                        sandbox_mode, goal_json, plan_json, timeline_sha256,
                        timeline_entry_count
                     ) VALUES (
                        1, 'task', 0, 'Task', 1, 2, '', '[]', 0, 0, 0,
                        'gpt-test', 'medium', NULL, 'default', 'on-request',
                        'workspace-write', NULL, NULL, NULL, 0
                     )"#,
                    [],
                )
                .unwrap();
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(MIGRATION_2_SQL).unwrap();
            backfill_execution_environments(&transaction).unwrap();
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (2, 'v2', 2)",
                    [],
                )
                .unwrap();
            transaction.commit().unwrap();
            environment_id = connection
                .query_row("SELECT id FROM execution_environments", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO runs(
                        id, workspace_id, task_id, idempotency_key, status,
                        agent_outcome, verification_outcome, execution_root,
                        queued_at, version
                     ) VALUES (
                        'legacy-run', 1, 'task', 'legacy-key', 'queued',
                        'pending', 'not_requested', ?1, 3, 0
                     )"#,
                    [workspace.to_string_lossy().into_owned()],
                )
                .unwrap();
            connection
                .execute(
                    r#"INSERT INTO run_events(
                        run_id, sequence, timestamp, event_type, safe_payload_json
                     ) VALUES ('legacy-run', 0, 3, 'legacy.queued', '{}')"#,
                    [],
                )
                .unwrap();
        }

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let run = repository.get_run("legacy-run").unwrap();
        assert_eq!(run.execution_environment_id, environment_id);
        assert!(run.input.is_empty());
        assert!(run.history.is_empty());
        assert_eq!(run.prompt, "");
        assert!(!run.cancel_requested);
        assert_eq!(run.routine_occurrence_id, None);
        assert_eq!(
            repository
                .allocate_runtime_generation(&environment_id)
                .unwrap(),
            1
        );
        repository
            .with_connection(|connection| {
                let versions: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                let pending_inputs: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'pending_inputs'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let event_key: Option<String> = connection
                    .query_row(
                        "SELECT event_key FROM run_events WHERE run_id = 'legacy-run'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let foreign_key_errors: i64 = connection
                    .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(versions, XIAO_DATABASE_SCHEMA_VERSION);
                assert_eq!(pending_inputs, 1);
                assert_eq!(event_key, None);
                assert_eq!(foreign_key_errors, 0);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn newer_database_schema_is_rejected_without_mutation() {
        let directory = TestDirectory::new("newer-schema");
        {
            let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
            connection
                .execute_batch(
                    r#"CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                    );
                    INSERT INTO schema_migrations(version, name, applied_at) VALUES (99, 'future', 1);"#,
                )
                .unwrap();
        }

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("newer schema unexpectedly opened"),
            Err(error) => error,
        };
        assert!(error.contains("newer than this app supports"));
        let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn task_fields_and_thread_binding_round_trip() {
        let directory = TestDirectory::new("task-round-trip");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let mut stored_task = task("all-fields", 3);
        stored_task.draft_text = "unsent draft".to_owned();
        stored_task.follow_ups = vec![serde_json::json!({
            "id": "follow-up",
            "prompt": "Continue",
            "attachments": [],
            "createdAt": 30
        })];
        stored_task.archived = true;
        stored_task.pinned = true;
        stored_task.unread = true;
        stored_task.model = Some("gpt-test".to_owned());
        stored_task.reasoning_effort = Some("high".to_owned());
        stored_task.thread_id = Some("ephemeral-thread".to_owned());
        stored_task.mode = "plan".to_owned();
        stored_task.approval_policy = "untrusted".to_owned();
        stored_task.sandbox_mode = "read-only".to_owned();
        stored_task.goal = Some(serde_json::json!({
            "objective": "Preserve every field",
            "status": "active"
        }));
        stored_task.plan = Some(serde_json::json!({
            "explanation": "Test",
            "steps": [{ "step": "Round trip", "status": "inProgress" }]
        }));
        repository
            .save_workspace(update(document(&workspace, vec![stored_task])))
            .unwrap();

        let loaded = full_workspace(&repository, &workspace);
        let loaded_task = &loaded.tasks[0];
        assert_eq!(loaded_task.draft_text, "unsent draft");
        assert_eq!(loaded_task.follow_ups.len(), 1);
        assert!(loaded_task.archived);
        assert!(loaded_task.pinned);
        assert!(loaded_task.unread);
        assert_eq!(loaded_task.model.as_deref(), Some("gpt-test"));
        assert_eq!(loaded_task.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(loaded_task.thread_id, None);
        assert_eq!(
            loaded_task.thread_binding,
            Some(XiaoThreadBinding {
                thread_id: "ephemeral-thread".to_owned(),
                persistence: XiaoThreadPersistence::Ephemeral,
                materialized: false,
                thread_source: Some("xiao-workbench".to_owned()),
                cli_version: None,
            })
        );
        assert_eq!(loaded_task.mode, "plan");
        assert_eq!(loaded_task.approval_policy, "untrusted");
        assert_eq!(loaded_task.sandbox_mode, "read-only");
        assert!(loaded_task.goal.is_some());
        assert!(loaded_task.plan.is_some());
        assert_eq!(loaded_task.timeline.len(), 3);
        assert!(loaded_task.timeline_complete);
        assert_eq!(loaded_task.timeline_entry_count, 3);
        assert!(loaded_task.execution_environment_id.is_some());
        assert_eq!(loaded_task.workspace_mode, XiaoWorkspaceMode::Local);
        assert_eq!(loaded_task.managed_worktree_id, None);
    }

    #[test]
    fn generic_task_save_cannot_forge_persistent_thread_ownership() {
        let directory = TestDirectory::new("forged-thread-binding");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let mut forged = task("task", 0);
        forged.thread_binding = Some(XiaoThreadBinding {
            thread_id: "foreign-thread".to_owned(),
            persistence: XiaoThreadPersistence::Persistent,
            materialized: true,
            thread_source: Some("xiao-workbench".to_owned()),
            cli_version: Some("fake".to_owned()),
        });

        repository
            .save_workspace(update(document(&workspace, vec![forged])))
            .unwrap();

        assert!(full_workspace(&repository, &workspace).tasks[0]
            .thread_binding
            .is_none());
    }

    #[test]
    fn generic_task_save_cannot_forge_native_worktree_ownership() {
        let directory = TestDirectory::new("forged-execution-binding");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 0)])))
            .unwrap();
        let original_environment = full_workspace(&repository, &workspace).tasks[0]
            .execution_environment_id
            .clone();

        let mut forged = full_workspace(&repository, &workspace);
        forged.tasks[0].execution_environment_id = Some("forged-environment".to_owned());
        forged.tasks[0].workspace_mode = XiaoWorkspaceMode::ManagedWorktree;
        forged.tasks[0].managed_worktree_id = Some("forged-worktree".to_owned());
        repository.save_workspace(update(forged)).unwrap();

        let loaded = full_workspace(&repository, &workspace);
        assert_eq!(
            loaded.tasks[0].execution_environment_id,
            original_environment
        );
        assert_eq!(loaded.tasks[0].workspace_mode, XiaoWorkspaceMode::Local);
        assert_eq!(loaded.tasks[0].managed_worktree_id, None);
    }

    #[test]
    fn managed_worktree_repository_lifecycle_is_transactional() {
        let directory = TestDirectory::new("managed-lifecycle");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 0)])))
            .unwrap();
        let binding = repository
            .task_execution_binding(&workspace.to_string_lossy(), "task")
            .unwrap();
        let ownership = directory.path.join("managed");
        let checkout = ownership.join("checkout");
        let marker = ownership.join("ownership.json");
        let id = new_uuid_v7();
        repository
            .begin_managed_worktree(NewManagedWorktreeRecord {
                id: id.clone(),
                workspace_id: binding.workspace_id,
                task_id: "task".to_owned(),
                repository_root: workspace.to_string_lossy().into_owned(),
                repository_common_dir_sha256: "hash".to_owned(),
                checkout_path: checkout.to_string_lossy().into_owned(),
                execution_root: checkout.to_string_lossy().into_owned(),
                branch: format!("xiao/task/{}", &id[..8]),
                base_commit: "base".to_owned(),
                owner_marker_path: marker.to_string_lossy().into_owned(),
                created_at: now_millis().unwrap(),
            })
            .unwrap();
        repository
            .activate_managed_worktree(
                &id,
                &checkout.to_string_lossy(),
                &checkout.to_string_lossy(),
                &marker.to_string_lossy(),
            )
            .unwrap();
        let active = repository
            .task_execution_binding(&workspace.to_string_lossy(), "task")
            .unwrap();
        assert_eq!(active.workspace_mode, XiaoWorkspaceMode::ManagedWorktree);
        assert_eq!(active.managed_worktree.as_ref().unwrap().id, id);

        let removing = repository
            .begin_managed_worktree_removal(&workspace.to_string_lossy(), "task", &id)
            .unwrap();
        assert_eq!(removing.status, ManagedWorktreeStatus::Removing);
        repository.finish_managed_worktree_removal(&id).unwrap();
        let local = repository
            .task_execution_binding(&workspace.to_string_lossy(), "task")
            .unwrap();
        assert_eq!(local.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(local.managed_worktree.is_none());
    }

    #[test]
    fn concurrent_worktree_reservations_allow_one_owner_per_task() {
        let directory = TestDirectory::new("managed-concurrent");
        let workspace = directory.workspace("workspace");
        let repository = std::sync::Arc::new(XiaoRepository::open(&directory.path).unwrap());
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 0)])))
            .unwrap();
        let binding = repository
            .task_execution_binding(&workspace.to_string_lossy(), "task")
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for index in 0..2 {
            let repository = std::sync::Arc::clone(&repository);
            let barrier = std::sync::Arc::clone(&barrier);
            let id = new_uuid_v7();
            let workspace_id = binding.workspace_id;
            let root = directory.path.join(format!("owned-{index}"));
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                repository.begin_managed_worktree(NewManagedWorktreeRecord {
                    id: id.clone(),
                    workspace_id,
                    task_id: "task".to_owned(),
                    repository_root: "repository".to_owned(),
                    repository_common_dir_sha256: "hash".to_owned(),
                    checkout_path: root.join("checkout").to_string_lossy().into_owned(),
                    execution_root: root.join("checkout").to_string_lossy().into_owned(),
                    branch: format!("xiao/task/{}", &id[..8]),
                    base_commit: "base".to_owned(),
                    owner_marker_path: root.join("ownership.json").to_string_lossy().into_owned(),
                    created_at: now_millis().unwrap(),
                })
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(
            repository
                .list_managed_worktree_records(&workspace.to_string_lossy())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn partial_timeline_save_cannot_truncate_complete_history() {
        let directory = TestDirectory::new("partial-timeline");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 650)])))
            .unwrap();

        let mut partial = repository
            .load_workspace(&workspace.to_string_lossy(), true)
            .unwrap()
            .unwrap();
        assert_eq!(partial.tasks[0].timeline.len(), INITIAL_TIMELINE_PAGE_SIZE);
        assert_eq!(partial.tasks[0].timeline_start, 450);
        assert_eq!(partial.tasks[0].timeline_entry_count, 650);
        assert!(!partial.tasks[0].timeline_complete);
        partial.tasks[0].title = "Metadata changed".to_owned();
        repository.save_workspace(update(partial)).unwrap();

        let full = full_workspace(&repository, &workspace);
        assert_eq!(full.tasks[0].title, "Metadata changed");
        assert_eq!(full.tasks[0].timeline.len(), 650);
        assert_eq!(full.tasks[0].timeline[0]["id"], "entry-0");
        assert_eq!(full.tasks[0].timeline[649]["id"], "entry-649");

        repository
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        r#"CREATE TABLE timeline_delete_audit(count INTEGER NOT NULL);
                         INSERT INTO timeline_delete_audit(count) VALUES (0);
                         CREATE TRIGGER count_timeline_delete AFTER DELETE ON task_timeline_entries
                         BEGIN UPDATE timeline_delete_audit SET count = count + 1; END;"#,
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        repository.save_workspace(update(full.clone())).unwrap();
        repository
            .with_connection(|connection| {
                let deletes: i64 = connection
                    .query_row("SELECT count FROM timeline_delete_audit", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(deletes, 0, "unchanged timeline must not be rewritten");
                Ok(())
            })
            .unwrap();

        let bounded = repository
            .load_timeline_page(&workspace.to_string_lossy(), "task", Some(450), Some(100))
            .unwrap();
        assert_eq!(bounded.entries.len(), 100);
        assert_eq!(bounded.start, 350);
        assert_eq!(bounded.entries[0]["id"], "entry-350");
        assert!(bounded.has_more);
        let clamped = repository
            .load_timeline_page(&workspace.to_string_lossy(), "task", None, Some(50_000))
            .unwrap();
        assert_eq!(clamped.entries.len(), MAX_TIMELINE_PAGE_SIZE);

        let replacement = task("task", 2);
        repository
            .save_workspace(update(document(&workspace, vec![replacement])))
            .unwrap();
        let replaced = full_workspace(&repository, &workspace);
        assert_eq!(replaced.tasks[0].timeline.len(), 2);
        assert_eq!(replaced.tasks[0].timeline[1]["id"], "entry-1");
        repository
            .with_connection(|connection| {
                let deletes: i64 = connection
                    .query_row("SELECT count FROM timeline_delete_audit", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(
                    deletes, 650,
                    "changed timeline must replace old rows exactly once"
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn partial_task_update_preserves_unchanged_tasks_and_reorders_atomically() {
        let directory = TestDirectory::new("partial-task-update");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(
                &workspace,
                vec![task("first", 2), task("second", 3)],
            )))
            .unwrap();

        let mut second = full_workspace(&repository, &workspace).tasks.remove(1);
        second.title = "Second changed".to_owned();
        second.timeline.clear();
        second.timeline_loaded = false;
        second.timeline_complete = false;
        second.timeline_start = second.timeline_entry_count;
        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: Some("second".to_owned()),
                show_archived: false,
                task_ids: vec!["second".to_owned(), "first".to_owned()],
                tasks: vec![second],
            })
            .unwrap();

        let loaded = full_workspace(&repository, &workspace);
        assert_eq!(loaded.active_task_id.as_deref(), Some("second"));
        assert_eq!(loaded.tasks[0].id, "second");
        assert_eq!(loaded.tasks[0].title, "Second changed");
        assert_eq!(loaded.tasks[0].timeline.len(), 3);
        assert_eq!(loaded.tasks[1].id, "first");
        assert_eq!(loaded.tasks[1].timeline.len(), 2);
    }

    #[test]
    fn new_task_requires_complete_timeline_data() {
        let directory = TestDirectory::new("partial-new-task");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let mut partial = task("new", 0);
        partial.timeline_loaded = false;
        partial.timeline_complete = false;

        let error = repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: Some("new".to_owned()),
                show_archived: false,
                task_ids: vec!["new".to_owned()],
                tasks: vec![partial],
            })
            .unwrap_err();
        assert!(error.contains("cannot be saved with partial timeline data"));
        assert!(repository
            .load_workspace(&workspace.to_string_lossy(), true)
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_workspace_transaction_preserves_previous_commit() {
        let directory = TestDirectory::new("transaction-rollback");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let baseline = document(&workspace, vec![task("task", 2)]);
        repository.save_workspace(update(baseline)).unwrap();

        let mut changed = full_workspace(&repository, &workspace);
        changed.tasks[0].title = "Must roll back".to_owned();
        let error = repository
            .save_workspace_failing_before_commit(update(changed))
            .unwrap_err();
        assert!(error.contains("Injected failure"));

        let loaded = full_workspace(&repository, &workspace);
        assert_eq!(loaded.tasks[0].title, "Task task");
        assert_eq!(loaded.tasks[0].timeline.len(), 2);
    }

    #[test]
    fn concurrent_initialization_migrates_legacy_state_once() {
        let directory = TestDirectory::new("concurrent-initialize");
        let workspace = directory.workspace("workspace");
        write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 2)])],
        );
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let path = directory.path.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                XiaoRepository::open(&path)
            }));
        }
        for worker in workers {
            worker.join().unwrap().unwrap();
        }

        let repository = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(repository.list_projects().unwrap().len(), 1);
        repository
            .with_connection(|connection| {
                let markers: i64 = connection
                    .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(markers, 1);
                Ok(())
            })
            .unwrap();
        let backups = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".pre-sqlite.bak")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn repository_serializes_concurrent_connection_access() {
        let directory = TestDirectory::new("concurrent-access");
        let repository = std::sync::Arc::new(XiaoRepository::open(&directory.path).unwrap());
        let mut workers = Vec::new();
        for index in 0..8 {
            let repository = std::sync::Arc::clone(&repository);
            let workspace = directory.workspace(&format!("workspace-{index}"));
            workers.push(std::thread::spawn(move || {
                repository
                    .save_workspace(update(document(
                        &workspace,
                        vec![task(&format!("task-{index}"), 1)],
                    )))
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(repository.list_projects().unwrap().len(), 8);
    }

    #[test]
    fn active_run_prevents_task_removal() {
        let directory = TestDirectory::new("active-run-delete");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 0)])))
            .unwrap();
        repository
            .with_connection(|connection| {
                let workspace_id = workspace_id(
                    connection,
                    &normalize_workspace_path(&workspace.to_string_lossy()),
                )?;
                connection
                    .execute(
                        r#"INSERT INTO runs(
                            id, workspace_id, task_id, idempotency_key, status, agent_outcome,
                            verification_outcome, execution_root, queued_at, version
                         ) VALUES ('run', ?1, 'task', 'key', 'queued', 'pending',
                            'not_requested', ?2, 1, 0)"#,
                        params![workspace_id, workspace.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        let removal = repository.save_workspace(XiaoWorkspaceUpdate {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: workspace.to_string_lossy().into_owned(),
            active_task_id: None,
            show_archived: false,
            task_ids: Vec::new(),
            tasks: Vec::new(),
        });

        assert!(removal.is_err());
        assert_eq!(full_workspace(&repository, &workspace).tasks.len(), 1);
        repository
            .with_connection(|connection| {
                let runs: i64 = connection
                    .query_row("SELECT COUNT(*) FROM runs WHERE id = 'run'", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                assert_eq!(runs, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn removing_a_task_cascades_timeline_run_and_events() {
        let directory = TestDirectory::new("cascade-delete");
        let workspace = directory.workspace("workspace");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        repository
            .save_workspace(update(document(&workspace, vec![task("task", 2)])))
            .unwrap();
        repository
            .with_connection(|connection| {
                let workspace_id = workspace_id(connection, &normalize_workspace_path(&workspace.to_string_lossy()))?;
                connection
                    .execute(
                        r#"INSERT INTO runs(
                            id, workspace_id, task_id, idempotency_key, status, agent_outcome,
                            verification_outcome, execution_root, queued_at, version
                         ) VALUES ('run', ?1, 'task', 'key', 'completed', 'completed',
                            'not_requested', ?2, 1, 0)"#,
                        params![workspace_id, workspace.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        r#"INSERT INTO run_events(run_id, sequence, timestamp, event_type, safe_payload_json)
                         VALUES ('run', 0, 1, 'queued', '{}')"#,
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        repository
            .save_workspace(XiaoWorkspaceUpdate {
                schema_version: XIAO_SCHEMA_VERSION,
                workspace_path: workspace.to_string_lossy().into_owned(),
                active_task_id: None,
                show_archived: false,
                task_ids: Vec::new(),
                tasks: Vec::new(),
            })
            .unwrap();
        repository
            .with_connection(|connection| {
                for table in ["tasks", "task_timeline_entries", "runs", "run_events"] {
                    let count: i64 = connection
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    assert_eq!(count, 0, "{table} should be empty");
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn valid_legacy_state_migrates_once_with_immutable_backup() {
        let directory = TestDirectory::new("legacy-valid");
        let workspace = directory.workspace("workspace");
        let mut legacy_task = task("legacy", 4);
        legacy_task.draft_text = "draft".to_owned();
        legacy_task.pinned = true;
        legacy_task.unread = true;
        legacy_task.thread_id = Some("legacy-thread".to_owned());
        legacy_task.goal = Some(serde_json::json!({ "objective": "Migrate", "status": "active" }));
        legacy_task.plan = Some(serde_json::json!({ "explanation": null, "steps": [] }));
        let source = write_legacy(&directory, vec![document(&workspace, vec![legacy_task])]);
        let source_path = directory.path.join(LEGACY_STORE_FILE_NAME);
        let source_modified = fs::metadata(&source_path).unwrap().modified().unwrap();

        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            let migrated = full_workspace(&repository, &workspace);
            assert_eq!(migrated.tasks.len(), 1);
            let migrated_task = &migrated.tasks[0];
            assert_eq!(migrated_task.draft_text, "draft");
            assert!(migrated_task.pinned);
            assert!(migrated_task.unread);
            assert_eq!(migrated_task.timeline.len(), 4);
            assert_eq!(
                migrated_task
                    .thread_binding
                    .as_ref()
                    .map(|binding| binding.persistence),
                Some(XiaoThreadPersistence::LegacyUntrusted)
            );
            repository
                .with_connection(|connection| {
                    let marker_count: i64 = connection
                        .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    assert_eq!(marker_count, 1);
                    Ok(())
                })
                .unwrap();
        }

        assert_eq!(fs::read(&source_path).unwrap(), source);
        assert_eq!(
            fs::metadata(&source_path).unwrap().modified().unwrap(),
            source_modified
        );
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);

        let reopened = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&reopened, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_canonical_legacy_paths_merge_without_dropping_tasks() {
        let directory = TestDirectory::new("legacy-duplicate-paths");
        let workspace = directory.workspace("workspace");
        let canonical = normalize_workspace_path(&workspace.to_string_lossy());
        let verbatim = format!(r"\\?\{canonical}");
        let first = document(Path::new(&canonical), vec![task("first", 1)]);
        let mut second = document(Path::new(&verbatim), vec![task("second", 1)]);
        second.tasks[0].updated_at = 30;
        write_legacy(&directory, vec![first, second]);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let projects = repository.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 2);
        assert!(migrated.tasks.iter().any(|task| task.id == "first"));
        assert!(migrated.tasks.iter().any(|task| task.id == "second"));
    }

    #[test]
    fn corrupt_or_unsupported_legacy_state_is_recoverable_and_untouched() {
        for (label, source, expected_error) in [
            (
                "corrupt",
                b"{not-json".to_vec(),
                "Invalid legacy Xiao state file",
            ),
            (
                "unsupported",
                br#"{ "schemaVersion": 99, "workspaces": [] }"#.to_vec(),
                "Unsupported legacy Xiao state schema version",
            ),
        ] {
            let directory = TestDirectory::new(label);
            let source_path = directory.path.join(LEGACY_STORE_FILE_NAME);
            fs::write(&source_path, &source).unwrap();

            let error = match XiaoRepository::open(&directory.path) {
                Ok(_) => panic!("invalid legacy state unexpectedly migrated"),
                Err(error) => error,
            };
            assert!(error.contains(expected_error));
            assert_eq!(fs::read(&source_path).unwrap(), source);

            let recoverable = XiaoRepository::initialize(directory.path.clone());
            assert!(recoverable
                .list_projects()
                .unwrap_err()
                .contains(expected_error));
        }
    }

    #[test]
    fn interrupted_temporary_backup_is_replaced_safely() {
        let directory = TestDirectory::new("interrupted-backup");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        let final_path = backup_path(&directory, &source);
        let temporary_path = directory.path.join(format!(
            ".{}.tmp",
            final_path.file_name().unwrap().to_string_lossy()
        ));
        fs::write(&temporary_path, b"partial backup").unwrap();

        XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(fs::read(final_path).unwrap(), source);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn existing_backup_must_match_source_exactly() {
        let directory = TestDirectory::new("backup-conflict");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        fs::write(backup_path(&directory, &source), b"different").unwrap();

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("conflicting backup unexpectedly migrated"),
            Err(error) => error,
        };
        assert!(error.contains("exists with different contents"));
        assert_eq!(
            fs::read(directory.path.join(LEGACY_STORE_FILE_NAME)).unwrap(),
            source
        );
    }

    #[test]
    fn identical_existing_backup_is_reused() {
        let directory = TestDirectory::new("backup-identical");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        fs::write(backup_path(&directory, &source), &source).unwrap();

        let repository = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(full_workspace(&repository, &workspace).tasks.len(), 1);
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);
    }

    #[test]
    fn interrupted_legacy_import_retries_without_duplicates() {
        let directory = TestDirectory::new("legacy-retry");
        let workspace = directory.workspace("workspace");
        let source = write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 3)])],
        );

        let error = match XiaoRepository::open_with_options(
            &directory.path,
            RepositoryOpenOptions {
                fail_legacy_before_commit: true,
            },
        ) {
            Ok(_) => panic!("injected migration failure unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(error.contains("Injected failure"));
        {
            let connection = Connection::open(directory.path.join(DATABASE_FILE_NAME)).unwrap();
            let workspaces: i64 = connection
                .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
                .unwrap();
            let markers: i64 = connection
                .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                .unwrap();
            assert_eq!(workspaces, 0);
            assert_eq!(markers, 0);
        }
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 3);
        repository
            .with_connection(|connection| {
                let markers: i64 = connection
                    .query_row("SELECT COUNT(*) FROM legacy_imports", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(markers, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_marker_prevents_reimport_even_if_legacy_file_changes() {
        let directory = TestDirectory::new("legacy-marker");
        let workspace = directory.workspace("workspace");
        write_legacy(
            &directory,
            vec![document(&workspace, vec![task("task", 1)])],
        );
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            assert_eq!(full_workspace(&repository, &workspace).tasks.len(), 1);
        }
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), b"now invalid").unwrap();

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(migrated.tasks[0].timeline.len(), 1);
    }

    #[test]
    fn nonempty_unmarked_database_refuses_late_legacy_merge() {
        let directory = TestDirectory::new("legacy-nonempty");
        let workspace = directory.workspace("workspace");
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .save_workspace(update(document(&workspace, vec![task("database", 1)])))
                .unwrap();
        }
        let legacy_workspace = directory.workspace("legacy-workspace");
        write_legacy(
            &directory,
            vec![document(&legacy_workspace, vec![task("legacy", 1)])],
        );

        let error = match XiaoRepository::open(&directory.path) {
            Ok(_) => panic!("late legacy state unexpectedly merged"),
            Err(error) => error,
        };
        assert!(error.contains("non-empty unmarked database"));
    }

    #[test]
    fn legacy_empty_bootstrap_task_cleanup_matches_previous_behavior() {
        let directory = TestDirectory::new("legacy-bootstrap");
        let workspace = directory.workspace("workspace");
        let mut empty = task("empty", 0);
        empty.title = "New task".to_owned();
        empty.thread_id = Some("stale-runtime-thread".to_owned());
        write_legacy(&directory, vec![document(&workspace, vec![empty])]);

        let repository = XiaoRepository::open(&directory.path).unwrap();
        let migrated = full_workspace(&repository, &workspace);
        assert!(migrated.tasks.is_empty());
        assert_eq!(migrated.active_task_id, None);
    }

    #[test]
    #[ignore = "set XIAO_MIGRATION_FIXTURE to validate a copied beta state"]
    fn migrate_external_legacy_copy() {
        let source_path = std::env::var_os("XIAO_MIGRATION_FIXTURE")
            .map(PathBuf::from)
            .expect("XIAO_MIGRATION_FIXTURE is required");
        let source = fs::read(&source_path).unwrap();
        let source_hash = sha256_hex(&source);
        let source_modified = fs::metadata(&source_path).unwrap().modified().unwrap();
        let mut expected: XiaoLegacyStore = serde_json::from_slice(&source).unwrap();
        normalize_legacy_store(&mut expected).unwrap();
        let expected_workspaces = expected.workspaces.len();
        let expected_tasks = expected
            .workspaces
            .iter()
            .map(|workspace| workspace.tasks.len())
            .sum::<usize>();
        let expected_timeline = expected
            .workspaces
            .iter()
            .flat_map(|workspace| &workspace.tasks)
            .map(|task| task.timeline.len())
            .sum::<usize>();

        let directory = TestDirectory::new("external-legacy-copy");
        fs::write(directory.path.join(LEGACY_STORE_FILE_NAME), &source).unwrap();
        {
            let repository = XiaoRepository::open(&directory.path).unwrap();
            repository
                .with_connection(|connection| {
                    let workspaces: i64 = connection
                        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let tasks: i64 = connection
                        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
                        .map_err(|error| error.to_string())?;
                    let timeline: i64 = connection
                        .query_row("SELECT COUNT(*) FROM task_timeline_entries", [], |row| {
                            row.get(0)
                        })
                        .map_err(|error| error.to_string())?;
                    assert_eq!(workspaces, to_i64(expected_workspaces, "workspace count")?);
                    assert_eq!(tasks, to_i64(expected_tasks, "task count")?);
                    assert_eq!(timeline, to_i64(expected_timeline, "timeline count")?);
                    Ok(())
                })
                .unwrap();
        }
        let reopened = XiaoRepository::open(&directory.path).unwrap();
        assert_eq!(reopened.list_projects().unwrap().len(), expected_workspaces);
        assert_eq!(fs::read(backup_path(&directory, &source)).unwrap(), source);
        assert_eq!(fs::read(&source_path).unwrap(), source);
        assert_eq!(
            fs::metadata(&source_path).unwrap().modified().unwrap(),
            source_modified
        );
        eprintln!(
            "external_legacy_migration sha256={} workspaces={} tasks={} timeline_entries={}",
            &source_hash[..16],
            expected_workspaces,
            expected_tasks,
            expected_timeline
        );
    }

    #[test]
    #[ignore = "manual performance baseline for persistence migrations"]
    fn benchmark_representative_store_round_trip() {
        let directory = TestDirectory::new("sqlite-benchmark");
        let repository = XiaoRepository::open(&directory.path).unwrap();
        let timeline = (0usize..80)
            .map(|index| {
                serde_json::json!({
                    "id": format!("event-{index}"),
                    "kind": if index.is_multiple_of(2) { "user" } else { "result" },
                    "title": "Synthetic persistence benchmark entry",
                    "body": "x".repeat(512),
                    "createdAt": index,
                })
            })
            .collect::<Vec<_>>();
        let mut updates = Vec::new();
        for workspace_index in 0..5 {
            let workspace = directory.workspace(&format!("workspace-{workspace_index}"));
            let tasks = (0..20)
                .map(|task_index| {
                    let mut task = task(&format!("task-{workspace_index}-{task_index}"), 0);
                    task.timeline = timeline.clone();
                    task.timeline_entry_count = timeline.len();
                    task
                })
                .collect();
            updates.push(update(document(&workspace, tasks)));
        }
        let mut save_ms = Vec::new();
        let mut load_full_ms = Vec::new();
        let mut load_bounded_ms = Vec::new();

        for _ in 0..5 {
            let started = Instant::now();
            for update in &updates {
                repository.save_workspace(update.clone()).unwrap();
            }
            save_ms.push(started.elapsed().as_millis());

            let started = Instant::now();
            repository
                .with_connection(|connection| {
                    for update in &updates {
                        let loaded = load_workspace_from_connection(
                            connection,
                            &normalize_workspace_path(&update.workspace_path),
                            true,
                            true,
                        )?
                        .unwrap();
                        assert_eq!(loaded.tasks.len(), 20);
                    }
                    Ok(())
                })
                .unwrap();
            load_full_ms.push(started.elapsed().as_millis());

            let started = Instant::now();
            for update in &updates {
                let loaded = repository
                    .load_workspace(&update.workspace_path, true)
                    .unwrap()
                    .unwrap();
                assert_eq!(loaded.tasks.len(), 20);
                assert!(loaded
                    .tasks
                    .iter()
                    .skip(1)
                    .all(|task| !task.timeline_loaded));
            }
            load_bounded_ms.push(started.elapsed().as_millis());
        }

        let mut metadata_only = updates[0].tasks[0].clone();
        metadata_only.title = "Updated benchmark title".to_owned();
        metadata_only.timeline.clear();
        metadata_only.timeline_loaded = false;
        metadata_only.timeline_complete = false;
        metadata_only.timeline_start = metadata_only.timeline_entry_count;
        let metadata_update = XiaoWorkspaceUpdate {
            tasks: vec![metadata_only],
            ..updates[0].clone()
        };
        let mut save_incremental_ms = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            repository.save_workspace(metadata_update.clone()).unwrap();
            save_incremental_ms.push(started.elapsed().as_millis());
        }

        let database_bytes = fs::metadata(directory.path.join(DATABASE_FILE_NAME))
            .unwrap()
            .len();
        eprintln!(
            "xiao_sqlite_baseline database_bytes={database_bytes} save_full_ms={save_ms:?} save_incremental_ms={save_incremental_ms:?} load_full_ms={load_full_ms:?} load_bounded_ms={load_bounded_ms:?}"
        );
    }
}
