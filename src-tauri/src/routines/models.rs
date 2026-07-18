use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runs::models::{RunSnapshot, RunStatus};
use crate::xiao::models::XiaoWorkspaceMode;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineScheduleKind {
    OneShot,
    Daily,
}

impl RoutineScheduleKind {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::OneShot => "one_shot",
            Self::Daily => "daily",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "one_shot" => Ok(Self::OneShot),
            "daily" => Ok(Self::Daily),
            _ => Err(format!("Unsupported Xiao routine schedule `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MissedRunPolicy {
    Skip,
    RunOnce,
}

impl MissedRunPolicy {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::RunOnce => "run_once",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "skip" => Ok(Self::Skip),
            "run_once" => Ok(Self::RunOnce),
            _ => Err(format!("Unsupported Xiao missed-run policy `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineTriggerKind {
    Automatic,
    Manual,
}

impl RoutineTriggerKind {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Manual => "manual",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "manual" => Ok(Self::Manual),
            _ => Err(format!("Unsupported Xiao routine trigger `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOccurrenceStatus {
    Reserved,
    Dispatched,
    Skipped,
    Cancelled,
}

impl RoutineOccurrenceStatus {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Dispatched => "dispatched",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "reserved" => Ok(Self::Reserved),
            "dispatched" => Ok(Self::Dispatched),
            "skipped" => Ok(Self::Skipped),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!(
                "Unsupported Xiao routine occurrence status `{value}`."
            )),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSchedulePayload {
    pub scheduled_for: Option<i64>,
    pub hour: Option<u32>,
    pub minute: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoutineRequest {
    pub project_path: String,
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule_kind: RoutineScheduleKind,
    pub timezone: String,
    pub scheduled_for: Option<i64>,
    pub daily_time: Option<String>,
    pub missed_run_policy: MissedRunPolicy,
    #[serde(default)]
    pub prefer_isolation: bool,
    #[serde(default)]
    pub dangerous_access_confirmed: bool,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoutineRequest {
    pub routine_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule_kind: RoutineScheduleKind,
    pub timezone: String,
    pub scheduled_for: Option<i64>,
    pub daily_time: Option<String>,
    pub missed_run_policy: MissedRunPolicy,
    #[serde(default)]
    pub prefer_isolation: bool,
    #[serde(default)]
    pub dangerous_access_confirmed: bool,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewRoutine {
    pub id: String,
    pub workspace_id: i64,
    pub workspace_path: String,
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule_kind: RoutineScheduleKind,
    pub timezone: String,
    pub schedule_payload: RoutineSchedulePayload,
    pub missed_run_policy: MissedRunPolicy,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub goal: Option<Value>,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub next_run_at: i64,
    pub isolation_warning: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct RoutineRecord {
    pub id: String,
    pub workspace_id: i64,
    pub workspace_path: String,
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule_kind: RoutineScheduleKind,
    pub timezone: String,
    pub schedule_payload: RoutineSchedulePayload,
    pub missed_run_policy: MissedRunPolicy,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub goal: Option<Value>,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub isolation_warning: Option<String>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutineOccurrenceRecord {
    pub id: String,
    pub scheduled_for: i64,
    pub trigger_kind: RoutineTriggerKind,
    pub status: RoutineOccurrenceStatus,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOccurrenceSummary {
    pub id: String,
    pub scheduled_for: i64,
    pub trigger_kind: RoutineTriggerKind,
    pub status: RoutineOccurrenceStatus,
    pub run: Option<RunSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSummary {
    pub id: String,
    pub workspace_path: String,
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule_kind: RoutineScheduleKind,
    pub timezone: String,
    pub scheduled_for: Option<i64>,
    pub daily_time: Option<String>,
    pub missed_run_policy: MissedRunPolicy,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub workspace_mode: XiaoWorkspaceMode,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub isolation_warning: Option<String>,
    pub last_status: Option<RunStatus>,
    pub history: Vec<RoutineOccurrenceSummary>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) enum RoutineReservation {
    Dispatched {
        routine: RoutineRecord,
        run: Box<crate::runs::repository::RunMutation>,
    },
    Skipped {
        routine: RoutineRecord,
    },
    Disabled {
        routine: RoutineRecord,
    },
    Unchanged {
        routine: RoutineRecord,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineUpdateEnvelope {
    pub workspace_path: String,
    pub routine: Option<RoutineSummary>,
    pub deleted_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOpenRunTarget {
    pub workspace_path: String,
    pub task_id: String,
    pub routine_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RoutineNotificationTarget {
    pub route: RoutineOpenRunTarget,
    pub routine_title: String,
    pub prompt: String,
}
