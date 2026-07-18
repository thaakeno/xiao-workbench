use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::models::XiaoHistoryItem;
use crate::xiao::models::XiaoThreadBinding;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Preparing,
    Running,
    WaitingForInput,
    Verifying,
    Completed,
    NeedsAttention,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::Running => "running",
            Self::WaitingForInput => "waiting_for_input",
            Self::Verifying => "verifying",
            Self::Completed => "completed",
            Self::NeedsAttention => "needs_attention",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "queued" => Ok(Self::Queued),
            "preparing" => Ok(Self::Preparing),
            "running" => Ok(Self::Running),
            "waiting_for_input" => Ok(Self::WaitingForInput),
            "verifying" => Ok(Self::Verifying),
            "completed" => Ok(Self::Completed),
            "needs_attention" => Ok(Self::NeedsAttention),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("Unsupported Xiao run status `{value}`.")),
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOutcome {
    Pending,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

impl AgentOutcome {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "interrupted" => Ok(Self::Interrupted),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!("Unsupported Xiao agent outcome `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationOutcome {
    NotRequested,
    Pending,
    Passed,
    Failed,
    Blocked,
}

impl VerificationOutcome {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::NotRequested => "not_requested",
            Self::Pending => "pending",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "not_requested" => Ok(Self::NotRequested),
            "pending" => Ok(Self::Pending),
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "blocked" => Ok(Self::Blocked),
            _ => Err(format!("Unsupported Xiao verification outcome `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueRunRequest {
    pub project_path: String,
    pub task_id: String,
    pub idempotency_key: String,
    pub prompt: String,
    pub input: Vec<Value>,
    #[serde(default)]
    pub history: Vec<XiaoHistoryItem>,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewRun {
    pub id: String,
    pub workspace_id: i64,
    pub task_id: String,
    pub idempotency_key: String,
    pub parent_run_id: Option<String>,
    pub candidate_group_id: Option<String>,
    pub routine_occurrence_id: Option<String>,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub prompt: String,
    pub input: Vec<Value>,
    pub history: Vec<XiaoHistoryItem>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub goal: Option<Value>,
    pub queued_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct RunRecord {
    pub id: String,
    pub workspace_id: i64,
    pub workspace_path: String,
    pub task_id: String,
    pub idempotency_key: String,
    pub parent_run_id: Option<String>,
    pub candidate_group_id: Option<String>,
    pub routine_occurrence_id: Option<String>,
    pub status: RunStatus,
    pub agent_outcome: AgentOutcome,
    pub verification_outcome: VerificationOutcome,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub prompt: String,
    pub input: Vec<Value>,
    pub history: Vec<XiaoHistoryItem>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub goal: Option<Value>,
    pub thread_id: Option<String>,
    pub thread_source: Option<String>,
    pub cli_version: Option<String>,
    pub runtime_generation: Option<u64>,
    pub turn_id: Option<String>,
    pub cancel_requested: bool,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub version: i64,
}

impl RunRecord {
    pub(crate) fn snapshot(&self) -> RunSnapshot {
        RunSnapshot {
            id: self.id.clone(),
            workspace_path: self.workspace_path.clone(),
            task_id: self.task_id.clone(),
            idempotency_key: self.idempotency_key.clone(),
            parent_run_id: self.parent_run_id.clone(),
            candidate_group_id: self.candidate_group_id.clone(),
            routine_occurrence_id: self.routine_occurrence_id.clone(),
            status: self.status,
            agent_outcome: self.agent_outcome,
            verification_outcome: self.verification_outcome,
            execution_environment_id: self.execution_environment_id.clone(),
            execution_root: self.execution_root.clone(),
            managed_worktree_id: self.managed_worktree_id.clone(),
            prompt: self.prompt.clone(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            service_tier: self.service_tier.clone(),
            mode: self.mode.clone(),
            approval_policy: self.approval_policy.clone(),
            sandbox_mode: self.sandbox_mode.clone(),
            thread_id: self.thread_id.clone(),
            thread_source: self.thread_source.clone(),
            cli_version: self.cli_version.clone(),
            runtime_generation: self.runtime_generation,
            turn_id: self.turn_id.clone(),
            cancel_requested: self.cancel_requested,
            queued_at: self.queued_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            version: self.version,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub workspace_path: String,
    pub task_id: String,
    pub idempotency_key: String,
    pub parent_run_id: Option<String>,
    pub candidate_group_id: Option<String>,
    pub routine_occurrence_id: Option<String>,
    pub status: RunStatus,
    pub agent_outcome: AgentOutcome,
    pub verification_outcome: VerificationOutcome,
    pub execution_environment_id: String,
    pub execution_root: String,
    pub managed_worktree_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub thread_id: Option<String>,
    pub thread_source: Option<String>,
    pub cli_version: Option<String>,
    pub runtime_generation: Option<u64>,
    pub turn_id: Option<String>,
    pub cancel_requested: bool,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRecord {
    pub run_id: String,
    pub sequence: i64,
    pub timestamp: i64,
    pub event_type: String,
    pub event_key: Option<String>,
    pub safe_payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventPage {
    pub events: Vec<RunEventRecord>,
    pub next_sequence: Option<i64>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingInputKind {
    CommandApproval,
    FileApproval,
    Permissions,
    Question,
    McpElicitation,
}

impl PendingInputKind {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::CommandApproval => "command_approval",
            Self::FileApproval => "file_approval",
            Self::Permissions => "permissions",
            Self::Question => "question",
            Self::McpElicitation => "mcp_elicitation",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "command_approval" => Ok(Self::CommandApproval),
            "file_approval" => Ok(Self::FileApproval),
            "permissions" => Ok(Self::Permissions),
            "question" => Ok(Self::Question),
            "mcp_elicitation" => Ok(Self::McpElicitation),
            _ => Err(format!("Unsupported Xiao pending input kind `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInputSnapshot {
    pub id: String,
    pub run_id: String,
    pub runtime_generation: u64,
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub kind: PendingInputKind,
    pub safe_summary: Value,
    pub opened_at: i64,
    pub resolved_at: Option<i64>,
    pub invalidated_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewPendingInput {
    pub run_id: String,
    pub runtime_generation: u64,
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub kind: PendingInputKind,
    pub safe_summary: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct RunTaskDefaults {
    pub workspace_id: i64,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub mode: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub goal: Option<Value>,
    pub thread_binding: Option<XiaoThreadBinding>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeAttachment {
    pub generation: u64,
    pub thread_id: String,
    pub thread_source: String,
    pub cli_version: String,
    pub materialized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUpdateEnvelope {
    pub snapshot: RunSnapshot,
    pub event: Option<RunEventRecord>,
    pub pending_input: Option<PendingInputSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProtocolEnvelope {
    pub run_id: String,
    pub task_id: String,
    pub execution_environment_id: String,
    pub runtime_generation: u64,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub sequence: Option<i64>,
    pub message: Value,
    pub turn_diff: Option<String>,
    pub pending_input: Option<PendingInputSnapshot>,
}
