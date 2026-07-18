use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::execution::models::ExecutionContext;
use crate::git::service::read_git_summary;

use super::models::{FileKind, FileNode, WorkspaceSnapshot};

const SKIPPED_DIRECTORIES: &[&str] = &[".git", "node_modules", "target", "dist", ".idea"];
const MAX_FILE_PREVIEW_BYTES: u64 = 512 * 1024;

pub fn snapshot_workspace(context: ExecutionContext) -> Result<WorkspaceSnapshot, String> {
    let project = resolve_workspace(Some(&context.project_path))?;
    let root = resolve_workspace(Some(&context.execution_root))?;
    let files = read_directory(&root, &root)?;
    let name = project
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_owned();

    Ok(WorkspaceSnapshot {
        name,
        path: display_path(&project),
        execution: context,
        git: read_git_summary(&root),
        files,
    })
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
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

pub fn list_workspace_directory(
    execution_root: &str,
    relative_path: &str,
) -> Result<Vec<FileNode>, String> {
    let root = resolve_workspace(Some(execution_root))?;
    let relative = validate_relative_path(relative_path)?;
    let directory = root.join(relative);
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err("Directory path must stay inside the workspace.".to_owned());
    }
    read_directory(&root, &directory)
}

pub fn read_workspace_text_file(
    execution_root: &str,
    relative_path: &str,
) -> Result<String, String> {
    let root = resolve_workspace(Some(execution_root))?;
    let relative = validate_relative_path(relative_path)?;
    let path = root.join(relative);
    let path = path
        .canonicalize()
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("File path must stay inside the workspace.".to_owned());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_PREVIEW_BYTES {
        return Err("File is larger than the 512 KB preview limit.".to_owned());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|_| "Binary files cannot be previewed as text.".to_owned())
}

fn validate_relative_path(path: &str) -> Result<&Path, String> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path must stay inside the workspace.".to_owned());
    }
    Ok(relative)
}

fn resolve_workspace(path: Option<&str>) -> Result<PathBuf, String> {
    let candidate = match path {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };

    let candidate = if candidate.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        candidate.parent().unwrap_or(&candidate).to_path_buf()
    } else {
        candidate
    };

    if !candidate.is_dir() {
        return Err(format!("Workspace does not exist: {}", candidate.display()));
    }

    candidate.canonicalize().map_err(|error| error.to_string())
}

fn read_directory(root: &Path, directory: &Path) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_none_or(|name| !SKIPPED_DIRECTORIES.contains(&name))
        })
        .collect::<Vec<_>>();

    paths.sort_by(|left, right| {
        right
            .is_dir()
            .cmp(&left.is_dir())
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let mut nodes = Vec::new();
    for path in paths {
        let is_directory = path.is_dir();

        nodes.push(FileNode {
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_owned(),
            path: path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
            kind: if is_directory {
                FileKind::Directory
            } else {
                FileKind::File
            },
            children: Vec::new(),
        });
    }

    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use crate::execution::models::{ExecutionContext, ExecutionEnvironmentSummary};
    use crate::xiao::models::XiaoWorkspaceMode;

    use super::{list_workspace_directory, snapshot_workspace};

    fn local_context() -> ExecutionContext {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        ExecutionContext {
            project_path: project.clone(),
            execution_root: project,
            environment: ExecutionEnvironmentSummary {
                id: "test".to_owned(),
                kind: "windows".to_owned(),
                label: "Windows local".to_owned(),
                availability: "available".to_owned(),
            },
            workspace_mode: XiaoWorkspaceMode::Local,
            managed_worktree: None,
            isolation_available: true,
            isolation_unavailable_reason: None,
        }
    }

    #[test]
    fn snapshots_an_existing_workspace() {
        let snapshot = snapshot_workspace(local_context()).unwrap();
        assert_eq!(snapshot.name, "xiao");
        assert!(!snapshot.files.is_empty());
    }

    #[test]
    fn lists_nested_directories_on_demand() {
        let entries =
            list_workspace_directory(&local_context().execution_root, "src-tauri/src/agent")
                .unwrap();
        assert!(entries.iter().any(|entry| entry.name == "runtime.rs"));
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let result = list_workspace_directory(&local_context().execution_root, "../");
        assert!(result.is_err());
    }
}
