use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const XIAO_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoWorkspaceDocument {
    pub schema_version: u32,
    pub workspace_path: String,
    pub active_task_id: Option<String>,
    pub show_archived: bool,
    pub tasks: Vec<XiaoTaskDocument>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[serde(default)]
    pub plan: Option<Value>,
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
pub(crate) struct XiaoStore {
    pub schema_version: u32,
    pub workspaces: Vec<XiaoWorkspaceDocument>,
}
