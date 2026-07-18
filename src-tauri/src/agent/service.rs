use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::models::{
    AgentAccountSummary, AgentAccountUsage, AgentDailyUsageBucket, AgentModelSummary,
    AgentThreadTokenUsage, ModelListResponse, PersistentAgentSession, ThreadStartResponse,
    XiaoHistoryItem,
};
use super::runtime::AgentRuntime;
use crate::xiao::models::{XiaoThreadBinding, XiaoThreadPersistence};

const MODEL_PAGE_SIZE: u64 = 100;

pub async fn read_account(runtime: &AgentRuntime) -> Result<AgentAccountSummary, String> {
    let result = runtime
        .request("account/read".to_owned(), json!({ "refreshToken": false }))
        .await?;
    let account = result.get("account").filter(|account| !account.is_null());

    Ok(AgentAccountSummary {
        authenticated: account.is_some(),
        auth_mode: account
            .and_then(|account| account.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        email: account
            .and_then(|account| account.get("email"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_type: account
            .and_then(|account| account.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        requires_openai_auth: result
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

pub async fn read_account_usage(runtime: &AgentRuntime) -> Result<AgentAccountUsage, String> {
    let result = runtime
        .request("account/usage/read".to_owned(), Value::Null)
        .await?;
    let summary = result
        .get("summary")
        .ok_or("account/usage/read did not include a summary.")?;
    let daily_usage_buckets = result
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|bucket| {
            Some(AgentDailyUsageBucket {
                start_date: bucket.get("startDate")?.as_str()?.to_owned(),
                tokens: read_u64(bucket.get("tokens")?)?,
            })
        })
        .collect();

    Ok(AgentAccountUsage {
        lifetime_tokens: summary.get("lifetimeTokens").and_then(read_u64),
        peak_daily_tokens: summary.get("peakDailyTokens").and_then(read_u64),
        longest_running_turn_sec: summary.get("longestRunningTurnSec").and_then(read_u64),
        current_streak_days: summary.get("currentStreakDays").and_then(read_u64),
        longest_streak_days: summary.get("longestStreakDays").and_then(read_u64),
        daily_usage_buckets,
    })
}

fn read_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

pub async fn list_models(runtime: &AgentRuntime) -> Result<Vec<AgentModelSummary>, String> {
    let mut cursor: Option<String> = None;
    let mut models = Vec::new();

    loop {
        let result = runtime
            .request(
                "model/list".to_owned(),
                json!({
                    "cursor": cursor,
                    "limit": MODEL_PAGE_SIZE,
                    "includeHidden": false,
                }),
            )
            .await?;
        let response: ModelListResponse = serde_json::from_value(result)
            .map_err(|error| format!("Invalid model/list response: {error}"))?;
        models.extend(
            response
                .data
                .into_iter()
                .filter(|model| !model.hidden)
                .map(|model| AgentModelSummary {
                    id: model.id,
                    model: model.model,
                    display_name: model.display_name,
                    description: model.description,
                    is_default: model.is_default,
                    default_reasoning_effort: model.default_reasoning_effort,
                    supported_reasoning_efforts: model.supported_reasoning_efforts,
                    service_tiers: model.service_tiers,
                    context_window: model.context_window,
                }),
        );

        match response.next_cursor {
            Some(next_cursor) if Some(&next_cursor) != cursor.as_ref() => {
                cursor = Some(next_cursor)
            }
            Some(_) => return Err("model/list returned the same cursor twice.".to_owned()),
            None => break,
        }
    }

    Ok(models)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare_persistent_xiao_session(
    runtime: &AgentRuntime,
    workspace_path: &str,
    project_path: &str,
    task_id: &str,
    model: Option<&str>,
    history: Vec<XiaoHistoryItem>,
    binding: Option<&XiaoThreadBinding>,
    service_tier: Option<&str>,
    approval_policy: &str,
    sandbox: &str,
) -> Result<PersistentAgentSession, String> {
    if workspace_path.trim().is_empty() {
        return Err("A workspace path is required to prepare a Xiao session.".to_owned());
    }

    if let Some(binding) = resumable_persistent_binding(binding)? {
        if runtime.is_thread_bound(&binding.thread_id, project_path, task_id, workspace_path)? {
            return Ok(PersistentAgentSession {
                thread_id: binding.thread_id.clone(),
                model: model.map(str::to_owned),
                materialized: true,
            });
        }
        let result = runtime
            .request(
                "thread/resume".to_owned(),
                json!({
                    "threadId": binding.thread_id,
                    "cwd": workspace_path,
                    "runtimeWorkspaceRoots": [workspace_path],
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "excludeTurns": false,
                }),
            )
            .await?;
        let response: ThreadStartResponse = serde_json::from_value(result)
            .map_err(|error| format!("Invalid thread/resume response: {error}"))?;
        validate_persistent_thread(&response, &binding.thread_id)?;
        runtime.bind_thread_to_task(&response.thread.id, project_path, task_id, workspace_path)?;
        return Ok(PersistentAgentSession {
            thread_id: response.thread.id,
            model: response.model.or_else(|| model.map(str::to_owned)),
            materialized: true,
        });
    }

    let result = runtime
        .request(
            "thread/start".to_owned(),
            persistent_thread_start_request(
                workspace_path,
                model,
                service_tier,
                approval_policy,
                sandbox,
            ),
        )
        .await?;
    let response: ThreadStartResponse = serde_json::from_value(result)
        .map_err(|error| format!("Invalid thread/start response: {error}"))?;
    validate_persistent_thread(&response, &response.thread.id)?;
    let history_items = history_items_for_injection(history)?;
    let materialized = !history_items.is_empty();
    if materialized {
        runtime
            .request(
                "thread/inject_items".to_owned(),
                json!({
                    "threadId": response.thread.id,
                    "items": history_items,
                }),
            )
            .await?;
    }
    runtime.bind_thread_to_task(&response.thread.id, project_path, task_id, workspace_path)?;
    Ok(PersistentAgentSession {
        thread_id: response.thread.id,
        model: response.model.or_else(|| model.map(str::to_owned)),
        materialized,
    })
}

fn resumable_persistent_binding(
    binding: Option<&XiaoThreadBinding>,
) -> Result<Option<&XiaoThreadBinding>, String> {
    let Some(binding) = binding else {
        return Ok(None);
    };
    if binding.persistence != XiaoThreadPersistence::Persistent || !binding.materialized {
        return Ok(None);
    }
    if binding.thread_source.as_deref() != Some("xiao-workbench") {
        return Err("The stored Codex thread is not owned by Xiao Workbench.".to_owned());
    }
    Ok(Some(binding))
}

fn validate_persistent_thread(
    response: &ThreadStartResponse,
    expected_thread_id: &str,
) -> Result<(), String> {
    if response.thread.id != expected_thread_id
        || response.thread.ephemeral != Some(false)
        || response.thread.thread_source.as_deref() != Some("xiao-workbench")
    {
        return Err(
            "Codex returned a thread that does not match Xiao's persistent ownership binding."
                .to_owned(),
        );
    }
    Ok(())
}

fn persistent_thread_start_request(
    workspace_path: &str,
    model: Option<&str>,
    service_tier: Option<&str>,
    approval_policy: &str,
    sandbox: &str,
) -> Value {
    json!({
        "cwd": workspace_path,
        "runtimeWorkspaceRoots": [workspace_path],
        "model": model,
        "serviceTier": service_tier,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
        "ephemeral": false,
        "serviceName": "Xiao Workbench",
        "threadSource": "xiao-workbench",
    })
}

pub fn read_thread_token_usage() -> Result<Vec<AgentThreadTokenUsage>, String> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".codex")))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .ok_or("Could not locate the Codex home directory.")?;
    let mut files = Vec::new();
    collect_rollouts(&codex_home.join("sessions"), &mut files)?;
    collect_rollouts(&codex_home.join("archived_sessions"), &mut files)?;

    let mut usage = Vec::new();
    for path in files {
        if let Some(item) = read_rollout_usage(&path)? {
            usage.push(item);
        }
    }
    usage.sort_by(|left, right| right.total_tokens.cmp(&left.total_tokens));
    Ok(usage)
}

fn collect_rollouts(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, files)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

fn read_rollout_usage(path: &Path) -> Result<Option<AgentThreadTokenUsage>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut thread_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut originator: Option<String> = None;
    let mut totals: Option<(u64, u64, u64, u64, u64)> = None;
    let mut previous_total = 0;
    let mut daily_usage = BTreeMap::<String, u64>::new();

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if thread_id.is_none() && line.contains("\"session_meta\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                thread_id = value
                    .get("payload")
                    .and_then(|payload| payload.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                originator = value
                    .get("payload")
                    .and_then(|payload| payload.get("originator"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
        }
        if line.contains("\"turn_context\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(value) = value
                    .get("payload")
                    .and_then(|payload| payload.get("model"))
                    .and_then(Value::as_str)
                {
                    model = Some(value.to_owned());
                }
            }
        }
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(total) = value
            .get("payload")
            .and_then(|payload| payload.get("info"))
            .and_then(|info| info.get("total_token_usage"))
        else {
            continue;
        };
        let current_total = total.get("total_tokens").and_then(read_u64).unwrap_or(0);
        if let Some(date) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|timestamp| timestamp.get(..10))
        {
            *daily_usage.entry(date.to_owned()).or_default() +=
                current_total.saturating_sub(previous_total);
        }
        previous_total = current_total;
        totals = Some((
            current_total,
            total.get("input_tokens").and_then(read_u64).unwrap_or(0),
            total
                .get("cached_input_tokens")
                .and_then(read_u64)
                .unwrap_or(0),
            total.get("output_tokens").and_then(read_u64).unwrap_or(0),
            total
                .get("reasoning_output_tokens")
                .and_then(read_u64)
                .unwrap_or(0),
        ));
    }

    let (
        thread_id,
        (total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens),
    ) = match (thread_id, totals) {
        (Some(thread_id), Some(totals)) => (thread_id, totals),
        _ => return Ok(None),
    };
    let updated_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Ok(Some(AgentThreadTokenUsage {
        thread_id,
        model,
        originator,
        total_tokens,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        updated_at,
        daily_usage_buckets: daily_usage
            .into_iter()
            .map(|(start_date, tokens)| AgentDailyUsageBucket { start_date, tokens })
            .collect(),
    }))
}

fn history_items_for_injection(history: Vec<XiaoHistoryItem>) -> Result<Vec<Value>, String> {
    history
        .into_iter()
        .filter(|item| !item.text.trim().is_empty())
        .map(history_item_to_response_item)
        .collect()
}

fn history_item_to_response_item(item: XiaoHistoryItem) -> Result<Value, String> {
    let text = item.text.trim().to_owned();
    match item.role.as_str() {
        "user" => Ok(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }],
        })),
        "assistant" => Ok(json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        })),
        role => Err(format!("Unsupported Xiao history role `{role}`.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_sessions_are_source_tagged_and_non_ephemeral() {
        let params = persistent_thread_start_request(
            "C:/workspace",
            Some("gpt-test"),
            Some("priority"),
            "on-request",
            "workspace-write",
        );

        assert_eq!(params["ephemeral"], false);
        assert_eq!(params["threadSource"], "xiao-workbench");
        assert_eq!(params["serviceName"], "Xiao Workbench");
        assert_eq!(params["runtimeWorkspaceRoots"], json!(["C:/workspace"]));
        assert_eq!(params["serviceTier"], "priority");
    }

    #[test]
    fn materialized_persistent_binding_requires_xiao_ownership() {
        let wrong_source = XiaoThreadBinding {
            thread_id: "owned".to_owned(),
            persistence: XiaoThreadPersistence::Persistent,
            materialized: true,
            thread_source: Some("another-client".to_owned()),
            cli_version: None,
        };
        assert!(resumable_persistent_binding(Some(&wrong_source)).is_err());

        let provisional = XiaoThreadBinding {
            materialized: false,
            ..wrong_source
        };
        assert!(resumable_persistent_binding(Some(&provisional))
            .unwrap()
            .is_none());
    }

    #[test]
    fn persistent_thread_validation_rejects_wrong_source_or_id() {
        let valid = ThreadStartResponse {
            thread: super::super::models::ThreadRecord {
                id: "owned".to_owned(),
                ephemeral: Some(false),
                thread_source: Some("xiao-workbench".to_owned()),
            },
            model: Some("gpt-test".to_owned()),
        };
        assert!(validate_persistent_thread(&valid, "owned").is_ok());
        assert!(validate_persistent_thread(&valid, "other").is_err());

        let wrong_source = ThreadStartResponse {
            thread: super::super::models::ThreadRecord {
                id: "owned".to_owned(),
                ephemeral: Some(false),
                thread_source: Some("another-client".to_owned()),
            },
            model: None,
        };
        assert!(validate_persistent_thread(&wrong_source, "owned").is_err());
    }

    #[test]
    fn persistent_sessions_restore_xiao_history() {
        let items = history_items_for_injection(vec![
            XiaoHistoryItem {
                role: "user".to_owned(),
                text: "Previous question".to_owned(),
            },
            XiaoHistoryItem {
                role: "assistant".to_owned(),
                text: "Previous answer".to_owned(),
            },
            XiaoHistoryItem {
                role: "assistant".to_owned(),
                text: "   ".to_owned(),
            },
        ])
        .unwrap();

        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[1]["role"], "assistant");
    }

    #[test]
    fn history_items_use_responses_api_message_shape() {
        let item = history_item_to_response_item(XiaoHistoryItem {
            role: "assistant".to_owned(),
            text: "  Done  ".to_owned(),
        })
        .unwrap();

        assert_eq!(item["type"], "message");
        assert_eq!(item["role"], "assistant");
        assert_eq!(item["content"][0]["type"], "output_text");
        assert_eq!(item["content"][0]["text"], "Done");
    }
}
