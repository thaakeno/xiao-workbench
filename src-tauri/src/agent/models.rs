use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountSummary {
    pub authenticated: bool,
    pub auth_mode: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountUsage {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
    pub daily_usage_buckets: Vec<AgentDailyUsageBucket>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDailyUsageBucket {
    pub start_date: String,
    pub tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadTokenUsage {
    pub thread_id: String,
    pub model: Option<String>,
    pub originator: Option<String>,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub updated_at: u64,
    pub daily_usage_buckets: Vec<AgentDailyUsageBucket>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSummary {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<AgentReasoningEffortOption>,
    pub service_tiers: Vec<AgentModelServiceTier>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReasoningEffortOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub struct XiaoHistoryItem {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelListResponse {
    pub data: Vec<ModelRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRecord {
    pub id: String,
    pub model: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub hidden: bool,
    pub is_default: bool,
    #[serde(default)]
    pub default_reasoning_effort: String,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<AgentReasoningEffortOption>,
    #[serde(default)]
    pub service_tiers: Vec<AgentModelServiceTier>,
    #[serde(default)]
    pub context_window: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ThreadStartResponse {
    pub thread: ThreadRecord,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadRecord {
    pub id: String,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default)]
    pub thread_source: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersistentAgentSession {
    pub thread_id: String,
    pub model: Option<String>,
    pub materialized: bool,
}
