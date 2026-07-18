use serde_json::{json, Value};

pub fn initialize_request() -> Value {
    json!({
        "method": "initialize",
        "id": 0,
        "params": {
            "clientInfo": {
                "name": "xiao_workbench",
                "title": "Xiao Workbench",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true
            }
        }
    })
}

pub fn initialized_notification() -> Value {
    json!({ "method": "initialized", "params": {} })
}

pub fn request(id: u64, method: &str, params: Value) -> Value {
    if params.is_null() {
        json!({ "method": method, "id": id })
    } else {
        json!({ "method": method, "id": id, "params": params })
    }
}

pub fn response(id: Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const V2_FIXTURE: &str = include_str!("fixtures/codex-app-server-v2.jsonl");

    fn fixture_messages() -> Vec<Value> {
        V2_FIXTURE
            .lines()
            .map(|line| serde_json::from_str(line).expect("protocol fixture must be valid JSONL"))
            .collect()
    }

    #[test]
    fn interleaved_turn_events_keep_thread_and_turn_correlation() {
        let messages = fixture_messages();
        let started = messages
            .iter()
            .filter(|message| message["method"] == "turn/started")
            .map(|message| {
                (
                    message["params"]["threadId"]
                        .as_str()
                        .expect("turn/started must include threadId"),
                    message["params"]["turn"]["id"]
                        .as_str()
                        .expect("turn/started must include turn.id"),
                )
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(started.len(), 2);
        assert_eq!(started.get("thread-a"), Some(&"turn-a"));
        assert_eq!(started.get("thread-b"), Some(&"turn-b"));

        let terminal = messages
            .iter()
            .filter(|message| message["method"] == "turn/completed")
            .map(|message| {
                (
                    message["params"]["threadId"]
                        .as_str()
                        .expect("turn/completed must include threadId"),
                    (
                        message["params"]["turn"]["id"]
                            .as_str()
                            .expect("turn/completed must include turn.id"),
                        message["params"]["turn"]["status"]
                            .as_str()
                            .expect("turn/completed must include turn.status"),
                    ),
                )
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(terminal.get("thread-a"), Some(&("turn-a", "interrupted")));
        assert_eq!(terminal.get("thread-b"), Some(&("turn-b", "completed")));
    }

    #[test]
    fn item_events_keep_thread_turn_and_item_correlation() {
        let messages = fixture_messages();
        let item = messages
            .iter()
            .find(|message| message["method"] == "item/started")
            .expect("fixture must include an item event");

        assert_eq!(item["params"]["threadId"], "thread-a");
        assert_eq!(item["params"]["turnId"], "turn-a");
        assert_eq!(item["params"]["item"]["id"], "item-command-a");
    }

    #[test]
    fn server_approval_request_has_a_complete_route_key() {
        let messages = fixture_messages();
        let request = messages
            .iter()
            .find(|message| message["method"] == "item/commandExecution/requestApproval")
            .expect("fixture must include an approval request");

        assert!(request["id"].is_number());
        assert_eq!(request["params"]["threadId"], "thread-a");
        assert_eq!(request["params"]["turnId"], "turn-a");
        assert_eq!(request["params"]["itemId"], "item-command-a");
    }

    #[test]
    fn fixture_contains_no_machine_or_account_data() {
        for private_marker in [
            "C:/Users/",
            r"C:\\Users\\",
            "authorization",
            "access_token",
            "refresh_token",
            "data:image",
            "@",
        ] {
            assert!(!V2_FIXTURE.contains(private_marker));
        }
    }

    #[test]
    fn collaboration_item_exposes_parent_and_child_threads() {
        let messages = fixture_messages();
        let item = messages
            .iter()
            .find_map(|message| {
                let item = message.get("params")?.get("item")?;
                (item.get("type")? == "collabAgentToolCall").then_some(item)
            })
            .expect("fixture must include a collaboration item");

        assert_eq!(item["senderThreadId"], "thread-a");
        assert_eq!(item["receiverThreadIds"], json!(["thread-child"]));
        assert_eq!(item["agentsStates"]["thread-child"]["status"], "running");
    }
}
