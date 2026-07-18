use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::xiao::models::XiaoWorkspaceMode;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironmentSummary {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub availability: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeSummary {
    pub id: String,
    pub task_id: String,
    pub branch: String,
    pub checkout_path: String,
    pub execution_root: String,
    pub status: ManagedWorktreeStatus,
    pub base_commit: String,
    pub failure_reason: Option<String>,
    pub disk_bytes: u64,
    pub size_complete: bool,
    pub has_changes: Option<bool>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub project_path: String,
    pub execution_root: String,
    pub environment: ExecutionEnvironmentSummary,
    pub workspace_mode: XiaoWorkspaceMode,
    pub managed_worktree: Option<ManagedWorktreeSummary>,
    pub isolation_available: bool,
    pub isolation_unavailable_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ExecutionEnvironmentRecord {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub workspace_root: String,
    pub availability: String,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskExecutionBinding {
    pub workspace_id: i64,
    pub workspace_public_id: String,
    pub project_path: String,
    pub task_id: String,
    pub workspace_mode: XiaoWorkspaceMode,
    pub environment: ExecutionEnvironmentRecord,
    pub managed_worktree: Option<ManagedWorktreeRecord>,
}

#[derive(Debug, Clone)]
pub(crate) struct ManagedWorktreeRecord {
    pub id: String,
    pub workspace_id: i64,
    pub task_id: String,
    pub run_id: Option<String>,
    pub repository_root: String,
    pub repository_common_dir_sha256: String,
    pub checkout_path: String,
    pub execution_root: String,
    pub branch: String,
    pub base_commit: String,
    pub owner_marker_path: String,
    pub status: ManagedWorktreeStatus,
    pub failure_reason: Option<String>,
    pub created_at: i64,
    #[allow(dead_code)] // Retained for startup reconciliation diagnostics in M3.
    pub removed_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewManagedWorktreeRecord {
    pub id: String,
    pub workspace_id: i64,
    pub task_id: String,
    pub repository_root: String,
    pub repository_common_dir_sha256: String,
    pub checkout_path: String,
    pub execution_root: String,
    pub branch: String,
    pub base_commit: String,
    pub owner_marker_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedWorktreeStatus {
    Preparing,
    Active,
    Removing,
    Failed,
    Removed,
}

impl ManagedWorktreeStatus {
    pub fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "preparing" => Ok(Self::Preparing),
            "active" => Ok(Self::Active),
            "removing" => Ok(Self::Removing),
            "failed" => Ok(Self::Failed),
            "removed" => Ok(Self::Removed),
            _ => Err(format!("Unsupported managed worktree status `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnershipMarker {
    pub version: u32,
    pub worktree_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub run_id: Option<String>,
    pub canonical_checkout_path: String,
    pub repository_common_dir_sha256: String,
    pub branch: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ManagedPaths {
    pub ownership_directory: PathBuf,
    pub checkout_path: PathBuf,
    pub execution_root: PathBuf,
    pub marker_path: PathBuf,
}
