use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::models::{
    GitBranch, GitFileChange, GitFileStatus, GitRepositoryIdentity, GitSummary, GitWorktree,
    GitWorktreeEvidence,
};

const MAX_CHANGES: usize = 300;
const MAX_PATCH_BYTES: usize = 96 * 1024;
const MAX_APPLY_PATCH_BYTES: usize = 8 * 1024 * 1024;
static CHECKPOINT_COUNTER: AtomicU64 = AtomicU64::new(1);
static GIT_INDEX_COUNTER: AtomicU64 = AtomicU64::new(1);
const CHECKPOINT_ADD_ARGUMENTS: &[&str] = &[
    "add",
    "-A",
    "--",
    ".",
    ":(exclude,glob)**/.git/**",
    ":(exclude,glob)**/node_modules/**",
    ":(exclude,glob)**/target/**",
    ":(exclude,glob)**/dist/**",
    ":(exclude,glob)**/build/**",
    ":(exclude,glob)**/.next/**",
    ":(exclude,glob)**/.vite/**",
    ":(exclude,glob)**/.venv/**",
    ":(exclude,glob)**/venv/**",
    ":(exclude,glob)**/coverage/**",
];

pub fn read_git_summary(root: &Path) -> Option<GitSummary> {
    let repository_root = PathBuf::from(run_git(root, &["rev-parse", "--show-toplevel"])?.trim());
    let repository_root = repository_root.canonicalize().ok()?;
    let workspace_root = root.canonicalize().ok()?;
    let prefix = run_git(root, &["rev-parse", "--show-prefix"])
        .unwrap_or_default()
        .trim()
        .replace('\\', "/");
    let status = run_git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
            ".",
        ],
    )?;
    let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .or_else(|| run_git(root, &["symbolic-ref", "--short", "HEAD"]))
        .unwrap_or_else(|| "HEAD".to_owned());
    let mut summary = GitSummary {
        branch: branch.trim().to_owned(),
        repository_root: display_path(&repository_root),
        workspace_scoped: repository_root != workspace_root,
        added: 0,
        modified: 0,
        deleted: 0,
        untracked: 0,
        clean: status.is_empty(),
        changes: Vec::new(),
        changes_truncated: false,
    };

    for line in status.split('\0').filter(|line| !line.is_empty()) {
        let code = line.get(..2).unwrap_or(line);
        let repository_path = line.get(3..).unwrap_or_default().replace('\\', "/");
        let workspace_path = repository_path
            .strip_prefix(&prefix)
            .unwrap_or(&repository_path)
            .to_owned();
        let status = if code == "??" {
            summary.untracked += 1;
            GitFileStatus::Untracked
        } else if code.contains('D') {
            summary.deleted += 1;
            GitFileStatus::Deleted
        } else if code.contains('A') {
            summary.added += 1;
            GitFileStatus::Added
        } else {
            summary.modified += 1;
            GitFileStatus::Modified
        };
        if summary.changes.len() == MAX_CHANGES {
            summary.changes_truncated = true;
            continue;
        }
        let (patch, patch_truncated, additions, deletions) = match status {
            GitFileStatus::Untracked => untracked_patch(&workspace_root, &workspace_path),
            _ => tracked_patch(&repository_root, &repository_path),
        };
        summary.changes.push(GitFileChange {
            path: workspace_path,
            status,
            additions,
            deletions,
            patch,
            patch_truncated,
        });
    }

    Some(summary)
}

pub fn list_branches(workspace_path: &str) -> Result<Vec<GitBranch>, String> {
    let root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let output = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(HEAD)%09%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .ok_or("Could not list Git branches.")?;
    let mut branches = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let name = fields.next()?.trim();
            let current = fields.next()?.trim() == "*";
            let full_ref = fields.next()?.trim();
            if name.is_empty() || full_ref.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch {
                name: name.to_owned(),
                current,
                remote: full_ref.starts_with("refs/remotes/"),
            })
        })
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.remote.cmp(&right.remote))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(branches)
}

pub fn read_git_comparison(workspace_path: &str, base_branch: &str) -> Result<GitSummary, String> {
    let base_branch = base_branch.trim();
    if base_branch.is_empty()
        || base_branch.starts_with('-')
        || base_branch.chars().any(char::is_whitespace)
    {
        return Err("A valid comparison branch is required.".to_owned());
    }

    let workspace_root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let repository_root = run_git(&workspace_root, &["rev-parse", "--show-toplevel"])
        .and_then(|path| PathBuf::from(path.trim()).canonicalize().ok())
        .ok_or("The workspace is not inside a Git repository.")?;
    let prefix = run_git(&workspace_root, &["rev-parse", "--show-prefix"])
        .unwrap_or_default()
        .trim()
        .replace('\\', "/");
    let scope = prefix.trim_end_matches('/');
    let scope = if scope.is_empty() { "." } else { scope };
    let revision = format!("{base_branch}^{{commit}}");
    let base_commit = run_git(&repository_root, &["rev-parse", "--verify", &revision])
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Git branch `{base_branch}` was not found."))?;
    let merge_base = run_git(&repository_root, &["merge-base", "HEAD", &base_commit])
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Git branch `{base_branch}` has no common history with HEAD."))?;
    let changed = run_git(
        &repository_root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            &merge_base,
            "--",
            scope,
        ],
    )
    .ok_or("Could not compare Git branches.")?;
    let branch = run_git(&repository_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "HEAD".to_owned());
    let mut summary = GitSummary {
        branch: branch.trim().to_owned(),
        repository_root: display_path(&repository_root),
        workspace_scoped: repository_root != workspace_root,
        added: 0,
        modified: 0,
        deleted: 0,
        untracked: 0,
        clean: true,
        changes: Vec::new(),
        changes_truncated: false,
    };

    let mut fields = changed.split('\0').filter(|field| !field.is_empty());
    while let (Some(code), Some(repository_path)) = (fields.next(), fields.next()) {
        let workspace_path = repository_path
            .strip_prefix(&prefix)
            .unwrap_or(repository_path)
            .to_owned();
        let status = match code.chars().next() {
            Some('A') => {
                summary.added += 1;
                GitFileStatus::Added
            }
            Some('D') => {
                summary.deleted += 1;
                GitFileStatus::Deleted
            }
            _ => {
                summary.modified += 1;
                GitFileStatus::Modified
            }
        };
        if summary.changes.len() == MAX_CHANGES {
            summary.changes_truncated = true;
            continue;
        }
        let (patch, patch_truncated, additions, deletions) =
            tracked_patch_against(&repository_root, &merge_base, repository_path);
        summary.changes.push(GitFileChange {
            path: workspace_path,
            status,
            additions,
            deletions,
            patch,
            patch_truncated,
        });
    }

    let untracked = run_git(
        &workspace_root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
            ".",
        ],
    )
    .ok_or("Could not read untracked files.")?;
    for line in untracked.split('\0').filter(|line| line.starts_with("?? ")) {
        let repository_path = line.get(3..).unwrap_or_default().replace('\\', "/");
        let workspace_path = repository_path
            .strip_prefix(&prefix)
            .unwrap_or(&repository_path)
            .to_owned();
        summary.untracked += 1;
        if summary.changes.len() == MAX_CHANGES {
            summary.changes_truncated = true;
            continue;
        }
        let (patch, patch_truncated, additions, deletions) =
            untracked_patch(&workspace_root, &workspace_path);
        summary.changes.push(GitFileChange {
            path: workspace_path,
            status: GitFileStatus::Untracked,
            additions,
            deletions,
            patch,
            patch_truncated,
        });
    }

    summary.clean = summary.added + summary.modified + summary.deleted + summary.untracked == 0;
    Ok(summary)
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

fn tracked_patch(repository_root: &Path, path: &str) -> (String, bool, usize, usize) {
    let arguments = ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path];
    let patch = run_git(repository_root, &arguments)
        .or_else(|| {
            run_git(
                repository_root,
                &["diff", "--cached", "--unified=3", "--", path],
            )
        })
        .unwrap_or_default();
    let (additions, deletions) = count_patch_lines(&patch);
    let (patch, truncated) = truncate_patch(patch);
    (patch, truncated, additions, deletions)
}

fn tracked_patch_against(
    repository_root: &Path,
    base_commit: &str,
    path: &str,
) -> (String, bool, usize, usize) {
    let patch = run_git(
        repository_root,
        &[
            "diff",
            "--no-ext-diff",
            "--unified=3",
            base_commit,
            "--",
            path,
        ],
    )
    .unwrap_or_default();
    let (additions, deletions) = count_patch_lines(&patch);
    let (patch, truncated) = truncate_patch(patch);
    (patch, truncated, additions, deletions)
}

fn untracked_patch(workspace_root: &Path, path: &str) -> (String, bool, usize, usize) {
    let full_path = workspace_root.join(path);
    let Ok(bytes) = fs::read(&full_path) else {
        return (
            "Unable to read this untracked file.".to_owned(),
            false,
            0,
            0,
        );
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return ("Binary file (preview unavailable).".to_owned(), false, 0, 0);
    };
    let additions = text.lines().count();
    let mut patch = format!("--- /dev/null\n+++ b/{path}\n");
    for line in text.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
        if patch.len() > MAX_PATCH_BYTES {
            break;
        }
    }
    let (patch, truncated) = truncate_patch(patch);
    (patch, truncated, additions, 0)
}

fn truncate_patch(mut patch: String) -> (String, bool) {
    if patch.len() <= MAX_PATCH_BYTES {
        return (patch, false);
    }
    let mut cut = MAX_PATCH_BYTES;
    while !patch.is_char_boundary(cut) {
        cut -= 1;
    }
    patch.truncate(cut);
    patch.push_str("\n... diff preview truncated ...\n");
    (patch, true)
}

fn count_patch_lines(patch: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in patch.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn run_git(root: &Path, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(arguments);
    hide_window(&mut command);

    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn run_git_action(
    workspace_path: &str,
    action: &str,
    paths: &[String],
    message: Option<&str>,
) -> Result<String, String> {
    let root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut arguments = Vec::<String>::new();
    match action {
        "stage" => {
            validate_git_paths(paths)?;
            arguments.push("add".to_owned());
            arguments.push("--".to_owned());
            arguments.extend(paths.iter().cloned());
        }
        "stage-all" => {
            arguments.extend([
                "add".to_owned(),
                "-A".to_owned(),
                "--".to_owned(),
                ".".to_owned(),
            ]);
        }
        "unstage" => {
            validate_git_paths(paths)?;
            if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_some() {
                arguments.extend(["restore".to_owned(), "--staged".to_owned(), "--".to_owned()]);
            } else {
                arguments.extend([
                    "rm".to_owned(),
                    "--cached".to_owned(),
                    "-r".to_owned(),
                    "-f".to_owned(),
                    "--".to_owned(),
                ]);
            }
            arguments.extend(paths.iter().cloned());
        }
        "discard" => {
            validate_git_paths(paths)?;
            if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_none() {
                return Err(
                    "Staged changes cannot be discarded before the first commit.".to_owned(),
                );
            }
            arguments.extend([
                "restore".to_owned(),
                "--source=HEAD".to_owned(),
                "--staged".to_owned(),
                "--worktree".to_owned(),
                "--".to_owned(),
            ]);
            arguments.extend(paths.iter().cloned());
        }
        "commit" => {
            let message = message
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("A commit message is required.")?;
            return commit_workspace_staged(&root, message);
        }
        "switch" => {
            let branch = message
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("A branch name is required.")?;
            if branch.starts_with('-') || branch.contains(char::is_whitespace) {
                return Err("A valid branch name is required.".to_owned());
            }
            arguments.extend(["switch".to_owned(), branch.to_owned()]);
        }
        _ => return Err(format!("Unsupported Git action `{action}`.")),
    }
    run_git_checked(&root, &arguments)
}

fn commit_workspace_staged(workspace: &Path, message: &str) -> Result<String, String> {
    let repository = run_git(workspace, &["rev-parse", "--show-toplevel"])
        .and_then(|path| PathBuf::from(path.trim()).canonicalize().ok())
        .ok_or("The workspace is not inside a Git repository.")?;
    let prefix = run_git(workspace, &["rev-parse", "--show-prefix"])
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_owned();
    let scope = if prefix.is_empty() { "." } else { &prefix };
    let patch = run_git_bytes_checked(
        &repository,
        &[
            "diff".to_owned(),
            "--cached".to_owned(),
            "--binary".to_owned(),
            "--full-index".to_owned(),
            "--no-ext-diff".to_owned(),
            "--".to_owned(),
            scope.to_owned(),
        ],
    )?;
    if patch.is_empty() {
        return Err("No staged changes exist inside this workspace.".to_owned());
    }

    let index = temporary_git_index()?;
    let result = (|| {
        let initialize = if run_git(&repository, &["rev-parse", "--verify", "HEAD"]).is_some() {
            vec!["read-tree".to_owned(), "HEAD".to_owned()]
        } else {
            vec!["read-tree".to_owned(), "--empty".to_owned()]
        };
        run_git_with_index(&repository, &initialize, &index, None)?;
        run_git_with_index(
            &repository,
            &[
                "apply".to_owned(),
                "--cached".to_owned(),
                "--whitespace=nowarn".to_owned(),
                "-".to_owned(),
            ],
            &index,
            Some(&patch),
        )?;
        run_git_with_index(
            &repository,
            &["commit".to_owned(), "-m".to_owned(), message.to_owned()],
            &index,
            None,
        )
    })();
    let _ = fs::remove_file(&index);
    let _ = fs::remove_file(format!("{}.lock", index.display()));
    result
}

fn temporary_git_index() -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(std::env::temp_dir().join(format!(
        "xiao-git-index-{}-{timestamp}-{}",
        std::process::id(),
        GIT_INDEX_COUNTER.fetch_add(1, Ordering::Relaxed),
    )))
}

pub fn apply_workspace_patch(
    workspace_path: &str,
    patch: &str,
    reverse: bool,
    check_only: bool,
) -> Result<(), String> {
    if patch.trim().is_empty() {
        return Ok(());
    }
    if patch.len() > MAX_APPLY_PATCH_BYTES {
        return Err("The turn patch is too large to apply safely.".to_owned());
    }
    let root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("The Xiao workspace is not a directory.".to_owned());
    }

    let repository_root = run_git(&root, &["rev-parse", "--show-toplevel"])
        .and_then(|path| PathBuf::from(path.trim()).canonicalize().ok());
    let command_root = repository_root.as_deref().unwrap_or(&root);
    let workspace_prefix = repository_root
        .as_deref()
        .filter(|repository| *repository != root)
        .and_then(|repository| root.strip_prefix(repository).ok())
        .map(|prefix| prefix.to_string_lossy().replace('\\', "/"));

    if reverse && check_only {
        if let Some(repository) = repository_root.as_deref() {
            let scope = workspace_prefix.as_deref().unwrap_or(".");
            let staged = run_git(
                repository,
                &["diff", "--cached", "--name-only", "--", scope],
            )
            .unwrap_or_default();
            if !staged.trim().is_empty() {
                return Err("Unstage workspace changes before undoing a turn.".to_owned());
            }
        }
    }

    let mut command = Command::new("git");
    command.arg("-C").arg(command_root).arg("apply");
    if let Some(prefix) = workspace_prefix {
        command.arg(format!("--directory={prefix}"));
    }
    if reverse {
        command.arg("--reverse");
    }
    if check_only {
        command.arg("--check");
    }
    command
        .arg("--whitespace=nowarn")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Could not open Git patch input.")?
        .write_all(patch.as_bytes())
        .map_err(|error| error.to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if error.is_empty() {
        "Git could not apply the turn patch.".to_owned()
    } else {
        error
    })
}

pub fn create_workspace_checkpoint(workspace_path: &str) -> Result<String, String> {
    let workspace = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !workspace.is_dir() {
        return Err("The Xiao workspace is not a directory.".to_owned());
    }

    let token = format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos(),
        CHECKPOINT_COUNTER.fetch_add(1, Ordering::Relaxed),
    );
    let directory = checkpoint_directory(&token)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let result = (|| {
        let repository = directory.join("repository.git");
        let mut init = Command::new("git");
        init.arg("init").arg("--bare").arg(&repository);
        hide_window(&mut init);
        let output = init.output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(command_error(
                &output.stderr,
                "Could not initialize the undo checkpoint.",
            ));
        }

        snapshot_workspace(&directory, &repository, &workspace)?;
        let tree = run_checkpoint_git(&directory, &repository, &workspace, &["write-tree"])?;
        fs::write(directory.join("tree"), tree.trim()).map_err(|error| error.to_string())?;
        fs::write(directory.join("workspace"), display_path(&workspace))
            .map_err(|error| error.to_string())?;
        Ok(token.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
}

pub fn finish_workspace_checkpoint(workspace_path: &str, token: &str) -> Result<String, String> {
    let directory = checkpoint_directory(token)?;
    let result = (|| {
        let workspace = Path::new(workspace_path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let expected_workspace = fs::read_to_string(directory.join("workspace"))
            .map_err(|_| "The undo checkpoint is no longer available.".to_owned())?;
        if display_path(&workspace) != expected_workspace {
            return Err("The undo checkpoint belongs to a different workspace.".to_owned());
        }

        let repository = directory.join("repository.git");
        let before = fs::read_to_string(directory.join("tree"))
            .map_err(|_| "The undo checkpoint is incomplete.".to_owned())?;
        snapshot_workspace(&directory, &repository, &workspace)?;
        let after = run_checkpoint_git(&directory, &repository, &workspace, &["write-tree"])?;
        let patch = run_checkpoint_git(
            &directory,
            &repository,
            &workspace,
            &[
                "diff",
                "--binary",
                "--full-index",
                "--no-ext-diff",
                "--no-renames",
                before.trim(),
                after.trim(),
            ],
        )?;
        if patch.len() > MAX_APPLY_PATCH_BYTES {
            return Err("The turn patch is too large to undo safely.".to_owned());
        }
        Ok(patch)
    })();
    let _ = fs::remove_dir_all(directory);
    result
}

pub fn discard_workspace_checkpoint(token: &str) -> Result<(), String> {
    let directory = checkpoint_directory(token)?;
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn checkpoint_directory(token: &str) -> Result<PathBuf, String> {
    if token.is_empty()
        || !token
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
    {
        return Err("Invalid undo checkpoint token.".to_owned());
    }
    Ok(std::env::temp_dir()
        .join("xiao-workbench-checkpoints")
        .join(token))
}

fn snapshot_workspace(directory: &Path, repository: &Path, workspace: &Path) -> Result<(), String> {
    run_checkpoint_git(directory, repository, workspace, CHECKPOINT_ADD_ARGUMENTS).map(|_| ())
}

fn run_checkpoint_git(
    directory: &Path,
    repository: &Path,
    workspace: &Path,
    arguments: &[&str],
) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg(format!("--git-dir={}", repository.to_string_lossy()))
        .arg(format!("--work-tree={}", workspace.to_string_lossy()))
        .args(arguments)
        .env("GIT_INDEX_FILE", directory.join("index"));
    hide_window(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(command_error(
            &output.stderr,
            "Could not capture the workspace checkpoint.",
        ))
    }
}

fn command_error(stderr: &[u8], fallback: &str) -> String {
    let error = String::from_utf8_lossy(stderr).trim().to_owned();
    if error.is_empty() {
        fallback.to_owned()
    } else {
        error
    }
}

pub(crate) fn inspect_git_repository(
    workspace_path: &Path,
) -> Result<GitRepositoryIdentity, String> {
    let workspace = workspace_path
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize project for isolation: {error}"))?;
    if !workspace.is_dir() {
        return Err("The Xiao project is not a directory.".to_owned());
    }
    let repository_root = run_git(&workspace, &["rev-parse", "--show-toplevel"])
        .and_then(|path| PathBuf::from(path.trim()).canonicalize().ok())
        .ok_or("Managed worktree isolation requires a Git repository.")?;
    let common_dir_output = run_git(
        &workspace,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .or_else(|| run_git(&workspace, &["rev-parse", "--git-common-dir"]))
    .ok_or("Could not resolve the Git common directory.")?;
    let common_candidate = PathBuf::from(common_dir_output.trim());
    let common_candidate = if common_candidate.is_absolute() {
        common_candidate
    } else {
        workspace.join(common_candidate)
    };
    let common_dir = common_candidate
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize the Git common directory: {error}"))?;
    let head = run_git(&repository_root, &["rev-parse", "--verify", "HEAD"])
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or("Managed worktree isolation requires at least one Git commit.")?;
    let workspace_relative = workspace
        .strip_prefix(&repository_root)
        .map_err(|_| "The project path is outside its reported Git repository.".to_owned())?
        .to_path_buf();
    Ok(GitRepositoryIdentity {
        repository_root,
        common_dir,
        workspace_relative,
        head,
    })
}

pub(crate) fn create_managed_worktree(
    repository: &GitRepositoryIdentity,
    checkout_path: &Path,
    branch: &str,
) -> Result<(), String> {
    if checkout_path.exists() {
        return Err("The managed checkout path already exists.".to_owned());
    }
    run_git_checked(
        &repository.repository_root,
        &[
            "check-ref-format".to_owned(),
            "--branch".to_owned(),
            branch.to_owned(),
        ],
    )?;
    run_git_checked(
        &repository.repository_root,
        &[
            "worktree".to_owned(),
            "add".to_owned(),
            "-b".to_owned(),
            branch.to_owned(),
            display_path(checkout_path),
            repository.head.clone(),
        ],
    )?;
    Ok(())
}

pub(crate) fn find_worktree_evidence(
    repository_root: &Path,
    expected_checkout: &Path,
) -> Result<Option<GitWorktreeEvidence>, String> {
    let expected_checkout = expected_checkout
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed checkout evidence: {error}"))?;
    let output = run_git_checked(
        repository_root,
        &[
            "worktree".to_owned(),
            "list".to_owned(),
            "--porcelain".to_owned(),
        ],
    )?;
    for block in output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        let mut path = None;
        let mut head = None;
        let mut branch = "detached".to_owned();
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = PathBuf::from(value).canonicalize().ok();
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                branch = value.to_owned();
            }
        }
        if path.as_deref() == Some(expected_checkout.as_path()) {
            return Ok(Some(GitWorktreeEvidence {
                path: expected_checkout,
                branch,
                head: head.unwrap_or_default(),
            }));
        }
    }
    Ok(None)
}

pub(crate) fn prune_managed_worktrees(repository_root: &Path) -> Result<(), String> {
    run_git_checked(
        repository_root,
        &["worktree".to_owned(), "prune".to_owned()],
    )?;
    Ok(())
}

pub(crate) fn worktree_path_registered(
    repository_root: &Path,
    expected_checkout: &Path,
) -> Result<bool, String> {
    let output = run_git_checked(
        repository_root,
        &[
            "worktree".to_owned(),
            "list".to_owned(),
            "--porcelain".to_owned(),
        ],
    )?;
    Ok(output.lines().any(|line| {
        line.strip_prefix("worktree ")
            .is_some_and(|path| paths_equal_for_evidence(Path::new(path), expected_checkout))
    }))
}

fn paths_equal_for_evidence(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        display_path(&left).eq_ignore_ascii_case(&display_path(&right))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) fn managed_worktree_has_changes(checkout_path: &Path) -> Result<bool, String> {
    let status = run_git(
        checkout_path,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--no-renames",
        ],
    )
    .ok_or("Could not inspect managed worktree changes.")?;
    Ok(!status.trim().is_empty())
}

pub(crate) fn remove_managed_worktree(
    repository_root: &Path,
    checkout_path: &Path,
) -> Result<(), String> {
    run_git_checked(
        repository_root,
        &[
            "worktree".to_owned(),
            "remove".to_owned(),
            "--force".to_owned(),
            display_path(checkout_path),
        ],
    )?;
    Ok(())
}

pub fn list_worktrees(workspace_path: &str) -> Result<Vec<GitWorktree>, String> {
    let root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let output = run_git_checked(
        &root,
        &[
            "worktree".to_owned(),
            "list".to_owned(),
            "--porcelain".to_owned(),
        ],
    )?;
    let main = run_git(&root, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let mut worktrees = Vec::new();
    for block in output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        let mut path = String::new();
        let mut head = String::new();
        let mut branch = "detached".to_owned();
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = value.to_owned();
            }
            if let Some(value) = line.strip_prefix("HEAD ") {
                head = value.to_owned();
            }
            if let Some(value) = line.strip_prefix("branch refs/heads/") {
                branch = value.to_owned();
            }
        }
        if !path.is_empty() {
            worktrees.push(GitWorktree {
                is_main: Path::new(&path) == Path::new(main.trim()),
                path,
                branch,
                head,
            });
        }
    }
    Ok(worktrees)
}

pub fn create_worktree(
    workspace_path: &str,
    target_path: &str,
    branch: &str,
) -> Result<(), String> {
    let root = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') {
        return Err("A valid branch name is required.".to_owned());
    }
    let target = Path::new(target_path);
    if target_path.trim().is_empty() || target.exists() {
        return Err("Choose a new directory for the worktree.".to_owned());
    }
    run_git_checked(
        &root,
        &[
            "worktree".to_owned(),
            "add".to_owned(),
            target_path.to_owned(),
            "-b".to_owned(),
            branch.to_owned(),
        ],
    )?;
    Ok(())
}

fn validate_git_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Select at least one workspace path.".to_owned());
    }
    for path in paths {
        let candidate = Path::new(path);
        if candidate.is_absolute()
            || candidate.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err("Git paths must stay inside the workspace.".to_owned());
        }
    }
    Ok(())
}

fn run_git_checked(root: &Path, arguments: &[String]) -> Result<String, String> {
    run_git_bytes_checked(root, arguments)
        .map(|output| String::from_utf8_lossy(&output).trim().to_owned())
}

fn run_git_bytes_checked(root: &Path, arguments: &[String]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(arguments);
    hide_window(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(command_error(&output.stderr, "Git command failed."))
    }
}

fn run_git_with_index(
    root: &Path,
    arguments: &[String],
    index: &Path,
    input: Option<&[u8]>,
) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("GIT_INDEX_FILE", index);
    hide_window(&mut command);
    let output = if let Some(input) = input {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let write_result = child
            .stdin
            .take()
            .ok_or("Could not open Git input.")?
            .write_all(input);
        if let Err(error) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
        child
            .wait_with_output()
            .map_err(|error| error.to_string())?
    } else {
        command.output().map_err(|error| error.to_string())?
    };
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(command_error(&output.stderr, "Git command failed."))
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::{
        apply_workspace_patch, create_workspace_checkpoint, discard_workspace_checkpoint,
        finish_workspace_checkpoint, list_branches, read_git_comparison, read_git_summary,
        run_git_action,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    #[test]
    fn workspace_inside_a_parent_repository_is_scoped_to_the_workspace() {
        let root = std::env::temp_dir().join(format!(
            "xiao-git-scope-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "xiao@example.com"]);
        run(&root, &["config", "user.name", "Xiao Test"]);
        fs::write(root.join("outside.txt"), "outside").unwrap();
        fs::write(workspace.join("inside.txt"), "inside").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-m", "initial"]);
        fs::write(root.join("outside.txt"), "outside changed").unwrap();
        fs::write(workspace.join("inside.txt"), "inside changed").unwrap();

        let summary = read_git_summary(&workspace).unwrap();
        assert!(summary.workspace_scoped);
        assert_eq!(summary.changes.len(), 1);
        assert_eq!(summary.changes[0].path, "inside.txt");
        assert!(summary.changes[0].patch.contains("inside changed"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn current_workspace_has_a_git_summary() {
        assert!(read_git_summary(Path::new(env!("CARGO_MANIFEST_DIR"))).is_some());
    }

    #[test]
    fn branch_comparison_is_scoped_and_does_not_checkout() {
        let root = temporary_directory("branch-comparison");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "xiao@example.com"]);
        run(&root, &["config", "user.name", "Xiao Test"]);
        fs::write(root.join("outside.txt"), "outside before\n").unwrap();
        fs::write(workspace.join("base.txt"), "base before\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-m", "initial"]);
        run(&root, &["branch", "-M", "main"]);
        run(&root, &["switch", "-c", "feature"]);
        fs::write(root.join("outside.txt"), "outside committed\n").unwrap();
        fs::write(workspace.join("feature.txt"), "feature\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-m", "feature"]);
        fs::write(root.join("outside.txt"), "outside working\n").unwrap();
        fs::write(workspace.join("base.txt"), "base working\n").unwrap();
        fs::write(workspace.join("scratch.txt"), "scratch\n").unwrap();

        let head_before = git_text(&root, &["rev-parse", "HEAD"]);
        let status_before = super::run_git(&root, &["status", "--porcelain"]).unwrap();
        let summary = read_git_comparison(&workspace.to_string_lossy(), "main").unwrap();
        let paths = summary
            .changes
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(summary.branch, "feature");
        assert!(summary.workspace_scoped);
        assert!(paths.contains(&"base.txt"));
        assert!(paths.contains(&"feature.txt"));
        assert!(paths.contains(&"scratch.txt"));
        assert!(!paths.iter().any(|path| path.contains("outside.txt")));
        assert!(summary
            .changes
            .iter()
            .find(|change| change.path == "feature.txt")
            .unwrap()
            .patch
            .contains("+feature"));
        assert_eq!(git_text(&root, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            super::run_git(&root, &["status", "--porcelain"]).unwrap(),
            status_before
        );

        let branches = list_branches(&workspace.to_string_lossy()).unwrap();
        assert!(branches.iter().any(|branch| branch.name == "main"));
        assert!(branches
            .iter()
            .any(|branch| branch.name == "feature" && branch.current));
        assert!(read_git_comparison(&workspace.to_string_lossy(), "--help").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unstages_files_before_the_first_commit() {
        let root = std::env::temp_dir().join(format!(
            "xiao-git-unborn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        fs::write(root.join("first.txt"), "first").unwrap();
        run(&root, &["add", "first.txt"]);

        let result = run_git_action(
            &root.to_string_lossy(),
            "unstage",
            &["first.txt".to_owned()],
            None,
        );

        assert!(result.is_ok(), "unstage failed: {result:?}");
        let status = super::run_git(&root, &["status", "--porcelain"]).unwrap();
        assert_eq!(status.trim(), "?? first.txt");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn commit_stays_scoped_to_staged_workspace_changes() {
        let root = temporary_directory("scoped-commit");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "xiao@example.com"]);
        run(&root, &["config", "user.name", "Xiao Test"]);
        fs::write(root.join("outside.txt"), "outside before\n").unwrap();
        fs::write(workspace.join("inside.txt"), "inside before\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-m", "initial"]);

        fs::write(root.join("outside.txt"), "outside staged\n").unwrap();
        fs::write(workspace.join("inside.txt"), "inside staged\n").unwrap();
        run(&root, &["add", "."]);
        fs::write(
            workspace.join("inside.txt"),
            "inside staged\ninside unstaged\n",
        )
        .unwrap();

        run_git_action(
            &workspace.to_string_lossy(),
            "commit",
            &[],
            Some("workspace only"),
        )
        .unwrap();

        assert_eq!(
            git_text(&root, &["show", "HEAD:outside.txt"]),
            "outside before"
        );
        assert_eq!(
            git_text(&root, &["show", "HEAD:workspace/inside.txt"]),
            "inside staged"
        );
        let status = super::run_git(&root, &["status", "--porcelain"]).unwrap();
        assert!(status.lines().any(|line| line == "M  outside.txt"));
        assert!(status.lines().any(|line| line == " M workspace/inside.txt"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discard_clears_staged_and_worktree_changes() {
        let root = temporary_directory("discard-staged");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        run(&root, &["config", "user.email", "xiao@example.com"]);
        run(&root, &["config", "user.name", "Xiao Test"]);
        fs::write(root.join("note.txt"), "before\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-m", "initial"]);
        fs::write(root.join("note.txt"), "staged\n").unwrap();
        run(&root, &["add", "note.txt"]);
        fs::write(root.join("note.txt"), "unstaged\n").unwrap();

        run_git_action(
            &root.to_string_lossy(),
            "discard",
            &["note.txt".to_owned()],
            None,
        )
        .unwrap();

        assert_eq!(read_text(&root.join("note.txt")), "before\n");
        assert!(super::run_git(&root, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stage_all_is_not_limited_by_the_change_preview() {
        let root = temporary_directory("stage-all");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        for index in 0..=super::MAX_CHANGES {
            fs::write(root.join(format!("change-{index:03}.txt")), "changed\n").unwrap();
        }
        let summary = read_git_summary(&root).unwrap();
        assert!(summary.changes_truncated);

        run_git_action(&root.to_string_lossy(), "stage-all", &[], None).unwrap();

        let staged = super::run_git(&root, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.lines().count(), super::MAX_CHANGES + 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_patches_round_trip_and_reject_conflicts() {
        let root = temporary_directory("patch-round-trip");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        fs::write(root.join("note.txt"), "before\n").unwrap();
        let patch = concat!(
            "diff --git a/note.txt b/note.txt\n",
            "--- a/note.txt\n",
            "+++ b/note.txt\n",
            "@@ -1 +1 @@\n",
            "-before\n",
            "+after\n",
        );

        apply_workspace_patch(&root.to_string_lossy(), patch, false, false).unwrap();
        assert_eq!(read_text(&root.join("note.txt")), "after\n");
        apply_workspace_patch(&root.to_string_lossy(), patch, true, true).unwrap();
        apply_workspace_patch(&root.to_string_lossy(), patch, true, false).unwrap();
        assert_eq!(read_text(&root.join("note.txt")), "before\n");

        apply_workspace_patch(&root.to_string_lossy(), patch, false, false).unwrap();
        fs::write(root.join("note.txt"), "user edit\n").unwrap();
        assert!(apply_workspace_patch(&root.to_string_lossy(), patch, true, true).is_err());
        assert_eq!(read_text(&root.join("note.txt")), "user edit\n");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_patches_stay_scoped_inside_a_parent_repository() {
        let root = temporary_directory("nested-patch");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        run(&root, &["init"]);
        fs::write(root.join("inside.txt"), "outside\n").unwrap();
        fs::write(workspace.join("inside.txt"), "before\n").unwrap();
        let patch = concat!(
            "diff --git a/inside.txt b/inside.txt\n",
            "--- a/inside.txt\n",
            "+++ b/inside.txt\n",
            "@@ -1 +1 @@\n",
            "-before\n",
            "+after\n",
        );

        apply_workspace_patch(&workspace.to_string_lossy(), patch, false, false).unwrap();

        assert_eq!(read_text(&workspace.join("inside.txt")), "after\n");
        assert_eq!(read_text(&root.join("inside.txt")), "outside\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_checkpoints_capture_turn_changes_without_touching_ignored_files() {
        let root = temporary_directory("checkpoint");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("note.txt"), "before\n").unwrap();
        fs::write(root.join("removed.txt"), "restore me\n").unwrap();
        fs::write(root.join("ignored.txt"), "ignored before\n").unwrap();
        fs::create_dir_all(root.join("node_modules/package")).unwrap();
        fs::write(root.join("node_modules/package/cache.js"), "before\n").unwrap();
        let checkpoint = create_workspace_checkpoint(&root.to_string_lossy()).unwrap();

        fs::write(root.join("note.txt"), "after\n").unwrap();
        fs::write(root.join("added.txt"), "new\n").unwrap();
        fs::remove_file(root.join("removed.txt")).unwrap();
        fs::write(root.join("ignored.txt"), "ignored after\n").unwrap();
        fs::write(root.join("node_modules/package/cache.js"), "after\n").unwrap();
        let patch = finish_workspace_checkpoint(&root.to_string_lossy(), &checkpoint).unwrap();

        assert!(patch.contains("note.txt"));
        assert!(patch.contains("added.txt"));
        assert!(patch.contains("removed.txt"));
        assert!(!patch.contains("ignored.txt"));
        assert!(!patch.contains("node_modules"));
        run(&root, &["add", "note.txt"]);
        assert!(apply_workspace_patch(&root.to_string_lossy(), &patch, true, true).is_err());
        run(&root, &["rm", "--cached", "note.txt"]);
        apply_workspace_patch(&root.to_string_lossy(), &patch, true, true).unwrap();
        apply_workspace_patch(&root.to_string_lossy(), &patch, true, false).unwrap();
        assert_eq!(read_text(&root.join("note.txt")), "before\n");
        assert!(!root.join("added.txt").exists());
        assert_eq!(read_text(&root.join("removed.txt")), "restore me\n");
        assert_eq!(read_text(&root.join("ignored.txt")), "ignored after\n");

        let discarded = create_workspace_checkpoint(&root.to_string_lossy()).unwrap();
        discard_workspace_checkpoint(&discarded).unwrap();
        assert!(finish_workspace_checkpoint(&root.to_string_lossy(), &discarded).is_err());
        let _ = fs::remove_dir_all(root);
    }

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "xiao-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn read_text(path: &Path) -> String {
        fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn git_text(root: &Path, arguments: &[&str]) -> String {
        super::run_git(root, arguments).unwrap().trim().to_owned()
    }

    fn run(root: &PathBuf, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {:?} failed", arguments);
    }
}
