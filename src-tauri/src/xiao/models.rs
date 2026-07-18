use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const XIAO_SCHEMA_VERSION: u32 = 1;
pub const XIAO_DATABASE_SCHEMA_VERSION: i64 = 4;

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoWorkspaceDocument {
    pub schema_version: u32,
    pub workspace_path: String,
    pub active_task_id: Option<String>,
    pub show_archived: bool,
    pub tasks: Vec<XiaoTaskDocument>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoWorkspaceUpdate {
    pub schema_version: u32,
    pub workspace_path: String,
    pub active_task_id: Option<String>,
    pub show_archived: bool,
    pub task_ids: Vec<String>,
    pub tasks: Vec<XiaoTaskDocument>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoTaskDocument {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub draft_text: String,
    #[serde(default)]
    pub follow_ups: Vec<Value>,
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub unread: bool,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_binding: Option<XiaoThreadBinding>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
    #[serde(default = "default_sandbox_mode")]
    pub sandbox_mode: String,
    #[serde(default)]
    pub goal: Option<Value>,
    #[serde(default)]
    pub timeline: Vec<Value>,
    #[serde(default = "default_true")]
    pub timeline_loaded: bool,
    #[serde(default = "default_true")]
    pub timeline_complete: bool,
    #[serde(default)]
    pub timeline_start: usize,
    #[serde(default)]
    pub timeline_entry_count: usize,
    #[serde(default)]
    pub plan: Option<Value>,
    #[serde(default)]
    pub execution_environment_id: Option<String>,
    #[serde(default)]
    pub workspace_mode: XiaoWorkspaceMode,
    #[serde(default)]
    pub managed_worktree_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum XiaoWorkspaceMode {
    #[default]
    Local,
    ManagedWorktree,
}

impl XiaoWorkspaceMode {
    pub fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "managed-worktree" => Ok(Self::ManagedWorktree),
            _ => Err(format!("Unsupported Xiao workspace mode `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoThreadBinding {
    pub thread_id: String,
    pub persistence: XiaoThreadPersistence,
    pub materialized: bool,
    pub thread_source: Option<String>,
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum XiaoThreadPersistence {
    Ephemeral,
    Persistent,
    LegacyUntrusted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoTimelinePage {
    pub entries: Vec<Value>,
    pub start: usize,
    pub total: usize,
    pub has_more: bool,
}

fn default_true() -> bool {
    true
}

fn default_mode() -> String {
    "default".to_owned()
}

fn default_approval_policy() -> String {
    "on-request".to_owned()
}

fn default_sandbox_mode() -> String {
    "workspace-write".to_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoProjectSummary {
    pub path: String,
    pub name: String,
    pub updated_at: i64,
    pub task_count: usize,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct XiaoLegacyStore {
    pub schema_version: u32,
    pub workspaces: Vec<XiaoWorkspaceDocument>,
}
