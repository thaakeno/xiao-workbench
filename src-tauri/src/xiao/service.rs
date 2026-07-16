use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Manager};

use super::models::{XiaoProjectSummary, XiaoStore, XiaoWorkspaceDocument, XIAO_SCHEMA_VERSION};

const STORE_FILE_NAME: &str = "xiao-state-v1.json";
static STORE_LOCK: Mutex<()> = Mutex::new(());
static STORE_WRITE_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn load_workspace(
    app: &AppHandle,
    workspace_path: &str,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    let _store_guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let store = read_store(app)?;
    let workspace_path = normalize_workspace_path(workspace_path);
    Ok(store
        .workspaces
        .into_iter()
        .find(|workspace| workspace.workspace_path == workspace_path))
}

pub fn save_workspace(app: &AppHandle, mut document: XiaoWorkspaceDocument) -> Result<(), String> {
    document.workspace_path = normalize_workspace_path(&document.workspace_path);
    clear_runtime_thread_ids(&mut document);
    validate_document(&document)?;
    let _store_guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let mut store = read_store(app)?;
    upsert_workspace(&mut store, document);
    write_store(app, &store)
}

pub fn list_projects(app: &AppHandle) -> Result<Vec<XiaoProjectSummary>, String> {
    let _store_guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let store = read_store(app)?;
    let mut projects = store
        .workspaces
        .into_iter()
        .map(|workspace| XiaoProjectSummary {
            name: PathBuf::from(&workspace.workspace_path)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or(&workspace.workspace_path)
                .to_owned(),
            updated_at: workspace
                .tasks
                .iter()
                .map(|task| task.updated_at)
                .max()
                .unwrap_or_default(),
            task_count: workspace.tasks.len(),
            path: workspace.workspace_path,
        })
        .collect::<Vec<_>>();
    projects.sort_by_key(|project| Reverse(project.updated_at));
    Ok(projects)
}

pub fn open_project(path: &str) -> Result<(), String> {
    let directory = Path::new(path);
    if !directory.is_dir() {
        return Err(format!(
            "Xiao project path is not an existing directory: {}",
            directory.display()
        ));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new("explorer");
        command.arg(directory).creation_flags(CREATE_NO_WINDOW);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(directory);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(directory);
        command
    };

    command.spawn().map(|_| ()).map_err(|error| {
        format!(
            "Failed to open Xiao project directory {}: {error}",
            directory.display()
        )
    })
}

fn validate_document(document: &XiaoWorkspaceDocument) -> Result<(), String> {
    if document.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Xiao workspace schema version {}.",
            document.schema_version
        ));
    }
    if document.workspace_path.trim().is_empty() {
        return Err("Xiao workspace path cannot be empty.".to_owned());
    }
    if let Some(active_task_id) = &document.active_task_id {
        if !document.tasks.iter().any(|task| task.id == *active_task_id) {
            return Err("The active Xiao task does not exist in this workspace.".to_owned());
        }
    }

    let mut task_ids = HashSet::new();
    for task in &document.tasks {
        if task.id.trim().is_empty() || task.title.trim().is_empty() {
            return Err("Xiao task ids and titles cannot be empty.".to_owned());
        }
        if !task_ids.insert(&task.id) {
            return Err(format!("Duplicate Xiao task id `{}`.", task.id));
        }
    }
    Ok(())
}

fn upsert_workspace(store: &mut XiaoStore, document: XiaoWorkspaceDocument) {
    store.schema_version = XIAO_SCHEMA_VERSION;
    if let Some(existing) = store
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.workspace_path == document.workspace_path)
    {
        *existing = document;
    } else {
        store.workspaces.push(document);
    }
}

fn read_store(app: &AppHandle) -> Result<XiaoStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(XiaoStore {
            schema_version: XIAO_SCHEMA_VERSION,
            workspaces: Vec::new(),
        });
    }

    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mut store: XiaoStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Xiao state file: {error}"))?;
    if store.schema_version != XIAO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Xiao state schema version {}.",
            store.schema_version
        ));
    }
    normalize_store_paths(&mut store);
    Ok(store)
}

fn normalize_store_paths(store: &mut XiaoStore) {
    let mut workspaces: Vec<XiaoWorkspaceDocument> = Vec::new();
    for mut document in std::mem::take(&mut store.workspaces) {
        document.workspace_path = normalize_workspace_path(&document.workspace_path);
        clear_runtime_thread_ids(&mut document);
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
    store.workspaces = workspaces;
}

fn clear_runtime_thread_ids(document: &mut XiaoWorkspaceDocument) {
    for task in &mut document.tasks {
        task.thread_id = None;
    }
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
                && task.thread_id.is_none()
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

fn normalize_workspace_path(path: &str) -> String {
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

fn write_store(app: &AppHandle, store: &XiaoStore) -> Result<(), String> {
    let path = store_path(app)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    write_atomically(&path, &bytes)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Xiao state path does not have a parent directory.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Xiao state file name is invalid.")?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{timestamp}-{}",
        std::process::id(),
        STORE_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed),
    ));

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    // MoveFileExW provides atomic replacement on the same volume, which std::fs::rename cannot do on Windows.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORE_FILE_NAME))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xiao::models::XiaoTaskDocument;

    fn document(path: &str, task_id: &str) -> XiaoWorkspaceDocument {
        XiaoWorkspaceDocument {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: path.to_owned(),
            active_task_id: Some(task_id.to_owned()),
            show_archived: false,
            tasks: vec![XiaoTaskDocument {
                id: task_id.to_owned(),
                title: "Task".to_owned(),
                created_at: 1,
                updated_at: 2,
                draft_text: String::new(),
                follow_ups: Vec::new(),
                archived: false,
                pinned: false,
                unread: false,
                model: None,
                reasoning_effort: None,
                thread_id: None,
                mode: "default".to_owned(),
                approval_policy: "on-request".to_owned(),
                sandbox_mode: "workspace-write".to_owned(),
                goal: None,
                timeline: Vec::new(),
                plan: None,
            }],
        }
    }

    #[test]
    fn workspace_documents_are_replaced_by_path() {
        let mut store = XiaoStore::default();
        upsert_workspace(&mut store, document("C:/one", "task-1"));
        upsert_workspace(&mut store, document("C:/one", "task-2"));

        assert_eq!(store.schema_version, XIAO_SCHEMA_VERSION);
        assert_eq!(store.workspaces.len(), 1);
        assert_eq!(
            store.workspaces[0].active_task_id.as_deref(),
            Some("task-2")
        );
    }

    #[test]
    fn duplicate_canonical_workspace_paths_are_merged() {
        let current = env!("CARGO_MANIFEST_DIR");
        let canonical = normalize_workspace_path(current);
        let verbatim = format!(r"\\?\{canonical}");
        let first = document(&canonical, "task-1");
        let mut second = document(&verbatim, "task-2");
        second.tasks[0]
            .timeline
            .push(serde_json::json!({ "kind": "user" }));
        let mut store = XiaoStore {
            schema_version: XIAO_SCHEMA_VERSION,
            workspaces: vec![first, second],
        };

        normalize_store_paths(&mut store);

        assert_eq!(store.workspaces.len(), 1);
        assert_eq!(store.workspaces[0].tasks.len(), 2);
        assert_eq!(store.workspaces[0].workspace_path, canonical);
    }

    #[test]
    fn persisted_runtime_thread_ids_are_removed_on_load() {
        let mut workspace = document("C:/one", "task-1");
        workspace.tasks[0].thread_id = Some("runtime-only-thread".to_owned());
        let mut store = XiaoStore {
            schema_version: XIAO_SCHEMA_VERSION,
            workspaces: vec![workspace],
        };

        normalize_store_paths(&mut store);

        assert_eq!(store.workspaces[0].tasks[0].thread_id, None);
    }

    #[test]
    fn empty_bootstrap_tasks_are_removed_without_removing_real_tasks() {
        let mut workspace = document("C:/one", "empty-1");
        workspace.tasks[0].title = "New task".to_owned();
        let mut second_empty = document("C:/one", "empty-2").tasks.remove(0);
        second_empty.title = "New task".to_owned();
        workspace.tasks.push(second_empty);
        let mut real_task = document("C:/one", "real").tasks.remove(0);
        real_task
            .timeline
            .push(serde_json::json!({ "kind": "user" }));
        workspace.tasks.push(real_task);

        remove_empty_bootstrap_tasks(&mut workspace);

        assert_eq!(workspace.tasks.len(), 1);
        assert!(workspace.tasks.iter().any(|task| task.id == "real"));
        assert_eq!(workspace.active_task_id.as_deref(), Some("real"));
    }

    #[test]
    fn configured_new_tasks_are_not_removed_as_empty_bootstrap_tasks() {
        let mut workspace = document("C:/one", "empty");
        workspace.tasks[0].title = "New task".to_owned();

        let mut goal_task = workspace.tasks[0].clone();
        goal_task.id = "goal".to_owned();
        goal_task.goal = Some(serde_json::json!({
            "objective": "Keep this task",
            "status": "active"
        }));

        let mut pinned_task = workspace.tasks[0].clone();
        pinned_task.id = "pinned".to_owned();
        pinned_task.pinned = true;

        let mut draft_task = workspace.tasks[0].clone();
        draft_task.id = "draft".to_owned();
        draft_task.draft_text = "Unsaved prompt".to_owned();
        let mut queued_task = workspace.tasks[0].clone();
        queued_task.id = "queued".to_owned();
        queued_task.follow_ups.push(serde_json::json!({
            "id": "follow-up",
            "prompt": "Continue after this turn",
            "attachments": [],
            "createdAt": 1
        }));
        workspace
            .tasks
            .extend([goal_task, pinned_task, draft_task, queued_task]);

        remove_empty_bootstrap_tasks(&mut workspace);

        assert_eq!(workspace.tasks.len(), 4);
        assert!(workspace.tasks.iter().any(|task| task.id == "goal"));
        assert!(workspace.tasks.iter().any(|task| task.id == "pinned"));
        assert!(workspace.tasks.iter().any(|task| task.id == "draft"));
        assert!(workspace.tasks.iter().any(|task| task.id == "queued"));
    }

    #[test]
    fn empty_workspace_document_is_valid() {
        let workspace = XiaoWorkspaceDocument {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: "C:/one".to_owned(),
            active_task_id: None,
            show_archived: false,
            tasks: Vec::new(),
        };

        assert!(validate_document(&workspace).is_ok());
    }

    #[test]
    fn atomic_write_replaces_the_store_without_leaving_temporary_files() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-state-write-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join(STORE_FILE_NAME);

        write_atomically(&path, br#"{ "version": 1 }"#).unwrap();
        write_atomically(&path, br#"{ "version": 2 }"#).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{ "version": 2 }"#);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        let _ = fs::remove_dir_all(directory);
    }
}
