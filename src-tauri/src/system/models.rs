use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub platform: String,
    pub shell: String,
    pub codex_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub can_update: bool,
    pub update_method: Option<String>,
    pub installation_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUpdateResult {
    pub previous_version: String,
    pub version: String,
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartSettings {
    pub enabled: bool,
    pub background: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub installer_size: u64,
}
