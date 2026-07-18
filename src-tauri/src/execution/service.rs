use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::git::models::GitRepositoryIdentity;
use crate::git::service::{
    create_managed_worktree, find_worktree_evidence, inspect_git_repository,
    managed_worktree_has_changes, prune_managed_worktrees, remove_managed_worktree,
    worktree_path_registered,
};
use crate::xiao::models::XiaoWorkspaceMode;
use crate::xiao::repository::{normalize_workspace_path, XiaoRepository};

use super::models::{
    ExecutionContext, ExecutionEnvironmentSummary, ManagedPaths, ManagedWorktreeRecord,
    ManagedWorktreeStatus, ManagedWorktreeSummary, NewManagedWorktreeRecord, OwnershipMarker,
    TaskExecutionBinding,
};

const MARKER_VERSION: u32 = 1;
const MAX_SIZE_ENTRIES: usize = 100_000;

pub fn resolve_execution_context(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<ExecutionContext, String> {
    let project_path = canonical_directory(project_path, "project")?;
    let project_display = display_path(&project_path);
    let Some(task_id) = task_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(unbound_local_context(&project_path));
    };
    let binding = repository.task_execution_binding(&project_display, task_id)?;
    let environment_root = canonical_directory(&binding.environment.workspace_root, "environment")?;
    if environment_root != project_path
        || normalize_workspace_path(&binding.project_path) != project_display
        || binding.environment.kind != "windows"
    {
        return Err("The task execution environment does not match its project root.".to_owned());
    }

    let (execution_root, managed_worktree) = match binding.workspace_mode {
        XiaoWorkspaceMode::Local => (project_path.clone(), None),
        XiaoWorkspaceMode::ManagedWorktree => {
            let record = binding
                .managed_worktree
                .as_ref()
                .ok_or("The managed task has no worktree ownership record.")?;
            if record.status != ManagedWorktreeStatus::Active {
                return Err("The managed task execution root is being removed.".to_owned());
            }
            let verified = verify_managed_ownership(repository, &binding, record)?;
            let summary = summarize_record(record);
            (verified, Some(summary))
        }
    };
    let (isolation_available, isolation_unavailable_reason) = isolation_capability(&project_path);
    Ok(ExecutionContext {
        project_path: project_display,
        execution_root: display_path(&execution_root),
        environment: ExecutionEnvironmentSummary {
            id: binding.environment.id,
            kind: binding.environment.kind,
            label: binding.environment.label,
            availability: if execution_root.is_dir() {
                "available".to_owned()
            } else {
                binding.environment.availability
            },
        },
        workspace_mode: binding.workspace_mode,
        managed_worktree,
        isolation_available,
        isolation_unavailable_reason,
    })
}

pub fn prepare_managed_task_environment(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: &str,
) -> Result<ExecutionContext, String> {
    let binding = repository.task_execution_binding(project_path, task_id)?;
    if repository.task_has_active_runs(project_path, task_id)? {
        return Err("Cancel active Xiao runs before changing the task environment.".to_owned());
    }
    if binding.workspace_mode != XiaoWorkspaceMode::Local || binding.managed_worktree.is_some() {
        return Err("The task already uses a managed worktree.".to_owned());
    }
    let project = canonical_directory(&binding.project_path, "project")?;
    let git = inspect_git_repository(&project)?;
    if let Some(preparing) = repository
        .list_managed_worktree_records(project_path)?
        .into_iter()
        .find(|record| {
            record.task_id == task_id && record.status == ManagedWorktreeStatus::Preparing
        })
    {
        if resume_or_clear_preparing(repository, &binding, &git, &preparing)? {
            return resolve_execution_context(repository, project_path, Some(task_id));
        }
    }
    let common_hash = path_sha256(&git.common_dir);
    let managed_root = repository.app_data_dir().join("managed-worktrees");
    fs::create_dir_all(&managed_root)
        .map_err(|error| format!("Could not create managed worktree root: {error}"))?;
    let managed_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed worktree root: {error}"))?;
    let worktree_id = Uuid::now_v7().to_string();
    let workspace_key = sha256_hex(
        format!(
            "{}\0{}",
            binding.environment.id,
            display_path(&git.common_dir)
        )
        .as_bytes(),
    );
    let ownership_directory = managed_root.join(&workspace_key[..16]).join(&worktree_id);
    if ownership_directory.exists() {
        return Err("The generated managed worktree path already exists.".to_owned());
    }
    let checkout_path = ownership_directory.join("checkout");
    let execution_root = checkout_path.join(&git.workspace_relative);
    let marker_path = ownership_directory.join("ownership.json");
    ensure_lexically_below(&managed_root, &ownership_directory)?;
    let branch = managed_branch(&binding.task_id, &worktree_id);
    let created_at = now_millis()?;
    let paths = ManagedPaths {
        ownership_directory: ownership_directory.clone(),
        checkout_path: checkout_path.clone(),
        execution_root: execution_root.clone(),
        marker_path: marker_path.clone(),
    };
    let ownership_parent = ownership_directory
        .parent()
        .ok_or("Managed worktree ownership path has no parent.")?;
    fs::create_dir_all(ownership_parent)
        .map_err(|error| format!("Could not create managed workspace directory: {error}"))?;
    repository.begin_managed_worktree(NewManagedWorktreeRecord {
        id: worktree_id.clone(),
        workspace_id: binding.workspace_id,
        task_id: binding.task_id.clone(),
        repository_root: display_path(&git.repository_root),
        repository_common_dir_sha256: common_hash.clone(),
        checkout_path: display_path(&checkout_path),
        execution_root: display_path(&execution_root),
        branch: branch.clone(),
        base_commit: git.head.clone(),
        owner_marker_path: display_path(&marker_path),
        created_at,
    })?;
    if let Err(error) = fs::create_dir(&ownership_directory) {
        let diagnostic = format!("Could not reserve managed ownership directory: {error}");
        let _ = repository.fail_managed_worktree(&worktree_id, &diagnostic);
        return Err(diagnostic);
    }

    let setup_result = setup_managed_worktree(
        &managed_root,
        &git,
        &paths,
        OwnershipMarker {
            version: MARKER_VERSION,
            worktree_id: worktree_id.clone(),
            workspace_id: binding.workspace_public_id,
            task_id: binding.task_id,
            run_id: None,
            canonical_checkout_path: String::new(),
            repository_common_dir_sha256: common_hash,
            branch: branch.clone(),
            created_at,
        },
    );
    let (checkout, execution, marker) = match setup_result {
        Ok(paths) => paths,
        Err(setup_error) => {
            let cleanup_error = compensate_failed_setup(&git, &managed_root, &paths, &branch).err();
            let diagnostic = match cleanup_error {
                Some(cleanup_error) => {
                    format!("{setup_error} Setup cleanup also failed: {cleanup_error}")
                }
                None => setup_error.clone(),
            };
            let _ = repository.fail_managed_worktree(&worktree_id, &diagnostic);
            return Err(diagnostic);
        }
    };
    if let Err(error) = repository.activate_managed_worktree(
        &worktree_id,
        &display_path(&checkout),
        &display_path(&execution),
        &display_path(&marker),
    ) {
        let cleanup_error = compensate_failed_setup(&git, &managed_root, &paths, &branch).err();
        let diagnostic = cleanup_error.map_or_else(
            || error.clone(),
            |cleanup| format!("{error} Setup cleanup also failed: {cleanup}"),
        );
        let _ = repository.fail_managed_worktree(&worktree_id, &diagnostic);
        return Err(diagnostic);
    }
    resolve_execution_context(repository, project_path, Some(task_id))
}

pub fn list_managed_worktrees(
    repository: &XiaoRepository,
    project_path: &str,
) -> Result<Vec<ManagedWorktreeSummary>, String> {
    let records = repository.list_managed_worktree_records(project_path)?;
    Ok(records.iter().map(summarize_record).collect())
}

pub fn remove_managed_task_environment(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: &str,
    worktree_id: &str,
    confirmed: bool,
) -> Result<ExecutionContext, String> {
    if !confirmed {
        return Err("Managed worktree cleanup requires explicit confirmation.".to_owned());
    }
    if repository.task_has_active_runs(project_path, task_id)? {
        return Err("Cancel active Xiao runs before changing the task environment.".to_owned());
    }
    let record = repository.begin_managed_worktree_removal(project_path, task_id, worktree_id)?;
    let binding = repository.task_execution_binding(project_path, task_id)?;
    if record.status == ManagedWorktreeStatus::Removing
        && !PathBuf::from(&record.checkout_path).exists()
    {
        finalize_interrupted_removal(repository, &binding, &record)?;
        return resolve_execution_context(repository, project_path, Some(task_id));
    }
    verify_managed_ownership(repository, &binding, &record)?;
    let checkout = canonical_directory(&record.checkout_path, "managed checkout")?;
    remove_managed_worktree(Path::new(&record.repository_root), &checkout)?;
    crash_at_test_failpoint("after-git-remove");
    let ownership_directory = expected_ownership_directory(repository, &record)?;
    fs::remove_dir_all(&ownership_directory).map_err(|error| {
        format!(
            "Git removed the checkout but Xiao could not remove ownership directory {}: {error}",
            ownership_directory.display()
        )
    })?;
    repository.finish_managed_worktree_removal(worktree_id)?;
    resolve_execution_context(repository, project_path, Some(task_id))
}

fn unbound_local_context(project_path: &Path) -> ExecutionContext {
    let (isolation_available, isolation_unavailable_reason) = isolation_capability(project_path);
    ExecutionContext {
        project_path: display_path(project_path),
        execution_root: display_path(project_path),
        environment: ExecutionEnvironmentSummary {
            id: "unbound-windows-local".to_owned(),
            kind: "windows".to_owned(),
            label: "Windows local".to_owned(),
            availability: "available".to_owned(),
        },
        workspace_mode: XiaoWorkspaceMode::Local,
        managed_worktree: None,
        isolation_available,
        isolation_unavailable_reason,
    }
}

fn isolation_capability(project_path: &Path) -> (bool, Option<String>) {
    match inspect_git_repository(project_path) {
        Ok(_) => (true, None),
        Err(error) => (false, Some(error)),
    }
}

fn finalize_interrupted_removal(
    repository: &XiaoRepository,
    binding: &TaskExecutionBinding,
    record: &ManagedWorktreeRecord,
) -> Result<(), String> {
    let managed_root = repository.app_data_dir().join("managed-worktrees");
    let managed_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed root: {error}"))?;
    let repository_root = canonical_directory(&record.repository_root, "repository")?;
    let git = inspect_git_repository(&repository_root)?;
    if path_sha256(&git.common_dir) != record.repository_common_dir_sha256 {
        return Err("Interrupted removal repository identity no longer matches.".to_owned());
    }
    let checkout_path = PathBuf::from(&record.checkout_path);
    ensure_lexically_below(&PathBuf::from(display_path(&managed_root)), &checkout_path)?;
    if worktree_path_registered(&git.repository_root, &checkout_path)? {
        prune_managed_worktrees(&git.repository_root)?;
    }
    if worktree_path_registered(&git.repository_root, &checkout_path)? {
        return Err("Git still reports the interrupted managed checkout.".to_owned());
    }

    let marker_path = PathBuf::from(&record.owner_marker_path);
    let ownership_path = marker_path
        .parent()
        .ok_or("Interrupted ownership marker has no parent directory.")?
        .to_path_buf();
    ensure_lexically_below(&PathBuf::from(display_path(&managed_root)), &ownership_path)?;
    if ownership_path.exists() {
        let ownership = ownership_path.canonicalize().map_err(|error| {
            format!("Could not canonicalize interrupted ownership directory: {error}")
        })?;
        ensure_canonical_below(&managed_root, &ownership)?;
        let expected_checkout = ownership.join("checkout");
        if normalize_workspace_path(&record.checkout_path) != display_path(&expected_checkout) {
            return Err("Interrupted checkout does not match its ownership directory.".to_owned());
        }
        let marker = read_marker(&marker_path)?;
        let expected_marker = OwnershipMarker {
            version: MARKER_VERSION,
            worktree_id: record.id.clone(),
            workspace_id: binding.workspace_public_id.clone(),
            task_id: binding.task_id.clone(),
            run_id: record.run_id.clone(),
            canonical_checkout_path: normalize_workspace_path(&record.checkout_path),
            repository_common_dir_sha256: record.repository_common_dir_sha256.clone(),
            branch: record.branch.clone(),
            created_at: record.created_at,
        };
        if !marker_matches(&marker, &expected_marker) {
            return Err(
                "Interrupted ownership marker does not match its database record.".to_owned(),
            );
        }
        fs::remove_dir_all(&ownership)
            .map_err(|error| format!("Could not finish interrupted ownership cleanup: {error}"))?;
    }
    repository.finish_managed_worktree_removal(&record.id)
}

fn resume_or_clear_preparing(
    repository: &XiaoRepository,
    binding: &TaskExecutionBinding,
    git: &GitRepositoryIdentity,
    record: &ManagedWorktreeRecord,
) -> Result<bool, String> {
    let managed_root = repository.app_data_dir().join("managed-worktrees");
    let managed_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed root: {error}"))?;
    let checkout_path = PathBuf::from(&record.checkout_path);
    if !checkout_path.exists() {
        let ownership_path = PathBuf::from(&record.owner_marker_path)
            .parent()
            .ok_or("Interrupted ownership marker has no parent directory.")?
            .to_path_buf();
        ensure_lexically_below(&PathBuf::from(display_path(&managed_root)), &ownership_path)?;
        if normalize_workspace_path(&record.checkout_path)
            != display_path(&ownership_path.join("checkout"))
        {
            return Err("Interrupted checkout does not match its ownership directory.".to_owned());
        }
        if worktree_path_registered(&git.repository_root, &checkout_path)? {
            prune_managed_worktrees(&git.repository_root)?;
        }
        if worktree_path_registered(&git.repository_root, &checkout_path)? {
            return Err("Git still reports the interrupted managed checkout.".to_owned());
        }
        if ownership_path.exists() {
            let ownership = ownership_path.canonicalize().map_err(|error| {
                format!("Could not canonicalize interrupted ownership directory: {error}")
            })?;
            ensure_canonical_below(&managed_root, &ownership)?;
            let marker_path = PathBuf::from(&record.owner_marker_path);
            if marker_path.exists() {
                let marker = read_marker(&marker_path)?;
                let expected_marker = OwnershipMarker {
                    version: MARKER_VERSION,
                    worktree_id: record.id.clone(),
                    workspace_id: binding.workspace_public_id.clone(),
                    task_id: binding.task_id.clone(),
                    run_id: record.run_id.clone(),
                    canonical_checkout_path: normalize_workspace_path(&record.checkout_path),
                    repository_common_dir_sha256: record.repository_common_dir_sha256.clone(),
                    branch: record.branch.clone(),
                    created_at: record.created_at,
                };
                if !marker_matches(&marker, &expected_marker) {
                    return Err(
                        "Interrupted ownership marker does not match its reservation.".to_owned(),
                    );
                }
            }
            fs::remove_dir_all(ownership).map_err(|error| {
                format!("Could not clear interrupted ownership directory: {error}")
            })?;
        }
        repository.fail_managed_worktree(
            &record.id,
            "Interrupted before the managed checkout became active.",
        )?;
        return Ok(false);
    }

    let ownership = expected_ownership_directory(repository, record)?;
    let checkout = canonical_directory(&record.checkout_path, "managed checkout")?;
    if checkout.parent() != Some(ownership.as_path())
        || checkout.file_name().and_then(|value| value.to_str()) != Some("checkout")
    {
        return Err("Interrupted checkout path does not match its ownership directory.".to_owned());
    }
    let marker_path = PathBuf::from(&record.owner_marker_path);
    if !Path::new(&record.execution_root).is_dir() && !marker_path.exists() {
        if display_path(&git.repository_root) != normalize_workspace_path(&record.repository_root)
            || path_sha256(&git.common_dir) != record.repository_common_dir_sha256
        {
            return Err("Interrupted worktree repository identity no longer matches.".to_owned());
        }
        let evidence = find_worktree_evidence(&git.repository_root, &checkout)?
            .ok_or("Git does not report the interrupted managed checkout.")?;
        if evidence.branch != record.branch {
            return Err("Interrupted worktree branch does not match its reservation.".to_owned());
        }
        compensate_failed_setup(
            git,
            &managed_root,
            &ManagedPaths {
                ownership_directory: ownership,
                checkout_path,
                execution_root: PathBuf::from(&record.execution_root),
                marker_path,
            },
            &record.branch,
        )?;
        repository.fail_managed_worktree(
            &record.id,
            "Interrupted setup had no managed execution root.",
        )?;
        return Ok(false);
    }
    let execution_root = canonical_directory(&record.execution_root, "managed execution root")?;
    if !execution_root.starts_with(&checkout) {
        return Err("Interrupted execution root escaped its checkout.".to_owned());
    }
    if display_path(&git.repository_root) != normalize_workspace_path(&record.repository_root)
        || path_sha256(&git.common_dir) != record.repository_common_dir_sha256
    {
        return Err("Interrupted worktree repository identity no longer matches.".to_owned());
    }
    let evidence = find_worktree_evidence(&git.repository_root, &checkout)?
        .ok_or("Git does not report the interrupted managed checkout.")?;
    if evidence.branch != record.branch {
        return Err("Interrupted worktree branch does not match its reservation.".to_owned());
    }
    let marker_path = PathBuf::from(&record.owner_marker_path);
    let expected_marker = OwnershipMarker {
        version: MARKER_VERSION,
        worktree_id: record.id.clone(),
        workspace_id: binding.workspace_public_id.clone(),
        task_id: binding.task_id.clone(),
        run_id: record.run_id.clone(),
        canonical_checkout_path: display_path(&checkout),
        repository_common_dir_sha256: record.repository_common_dir_sha256.clone(),
        branch: record.branch.clone(),
        created_at: record.created_at,
    };
    if marker_path.exists() {
        let marker = read_marker(&marker_path)?;
        if !marker_matches(&marker, &expected_marker) {
            return Err("Interrupted ownership marker does not match its reservation.".to_owned());
        }
    } else {
        write_marker(&marker_path, &expected_marker)?;
    }
    let marker_path = marker_path
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize resumed ownership marker: {error}"))?;
    repository.activate_managed_worktree(
        &record.id,
        &display_path(&checkout),
        &display_path(&execution_root),
        &display_path(&marker_path),
    )?;
    Ok(true)
}

fn marker_matches(actual: &OwnershipMarker, expected: &OwnershipMarker) -> bool {
    actual.version == expected.version
        && actual.worktree_id == expected.worktree_id
        && actual.workspace_id == expected.workspace_id
        && actual.task_id == expected.task_id
        && actual.run_id == expected.run_id
        && actual.canonical_checkout_path == expected.canonical_checkout_path
        && actual.repository_common_dir_sha256 == expected.repository_common_dir_sha256
        && actual.branch == expected.branch
        && actual.created_at == expected.created_at
}

fn setup_managed_worktree(
    managed_root: &Path,
    git: &GitRepositoryIdentity,
    paths: &ManagedPaths,
    mut marker: OwnershipMarker,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let ownership_directory = paths
        .ownership_directory
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize ownership directory: {error}"))?;
    ensure_canonical_below(managed_root, &ownership_directory)?;
    create_managed_worktree(git, &paths.checkout_path, &marker.branch)?;
    crash_at_test_failpoint("after-git-add");
    let checkout = paths
        .checkout_path
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed checkout: {error}"))?;
    ensure_canonical_below(managed_root, &checkout)?;
    let execution_root = paths
        .execution_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve managed execution root: {error}"))?;
    if !execution_root.starts_with(&checkout) || !execution_root.is_dir() {
        return Err("Managed execution root escaped its checkout.".to_owned());
    }
    let checkout_git = inspect_git_repository(&execution_root)?;
    if path_sha256(&checkout_git.common_dir) != marker.repository_common_dir_sha256 {
        return Err("Managed checkout resolved a different Git common directory.".to_owned());
    }
    marker.canonical_checkout_path = display_path(&checkout);
    write_marker(&paths.marker_path, &marker)?;
    let marker_path = paths
        .marker_path
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize ownership marker: {error}"))?;
    if marker_path.parent() != Some(ownership_directory.as_path()) {
        return Err("Managed ownership marker escaped its directory.".to_owned());
    }
    let evidence = find_worktree_evidence(&git.repository_root, &checkout)?
        .ok_or("Git did not report the newly-created managed worktree.")?;
    if evidence.branch != marker.branch || evidence.path != checkout {
        return Err("Git worktree evidence did not match the ownership marker.".to_owned());
    }
    Ok((checkout, execution_root, marker_path))
}

fn compensate_failed_setup(
    git: &GitRepositoryIdentity,
    managed_root: &Path,
    paths: &ManagedPaths,
    expected_branch: &str,
) -> Result<(), String> {
    if paths.checkout_path.exists() {
        let checkout = paths
            .checkout_path
            .canonicalize()
            .map_err(|error| format!("Could not canonicalize failed checkout: {error}"))?;
        ensure_canonical_below(managed_root, &checkout)?;
        if let Some(evidence) = find_worktree_evidence(&git.repository_root, &checkout)? {
            if evidence.branch != expected_branch {
                return Err("Refused to remove failed setup with unexpected Git branch.".to_owned());
            }
            remove_managed_worktree(&git.repository_root, &checkout)?;
        }
    }
    if paths.ownership_directory.exists() {
        let ownership = paths
            .ownership_directory
            .canonicalize()
            .map_err(|error| format!("Could not canonicalize failed ownership path: {error}"))?;
        ensure_canonical_below(managed_root, &ownership)?;
        fs::remove_dir_all(ownership)
            .map_err(|error| format!("Could not remove failed ownership directory: {error}"))?;
    }
    Ok(())
}

fn verify_managed_ownership(
    repository: &XiaoRepository,
    binding: &TaskExecutionBinding,
    record: &ManagedWorktreeRecord,
) -> Result<PathBuf, String> {
    if !matches!(
        record.status,
        ManagedWorktreeStatus::Active | ManagedWorktreeStatus::Removing
    ) {
        return Err("The managed worktree is not active.".to_owned());
    }
    if record.workspace_id != binding.workspace_id
        || record.task_id != binding.task_id
        || record.run_id.is_some()
    {
        return Err("Managed worktree database ownership does not match the task.".to_owned());
    }
    let ownership_directory = expected_ownership_directory(repository, record)?;
    let checkout = canonical_directory(&record.checkout_path, "managed checkout")?;
    if checkout.parent() != Some(ownership_directory.as_path())
        || checkout.file_name().and_then(|value| value.to_str()) != Some("checkout")
    {
        return Err("Managed checkout path does not match its ownership directory.".to_owned());
    }
    let execution_root = canonical_directory(&record.execution_root, "managed execution root")?;
    if !execution_root.starts_with(&checkout) {
        return Err("Managed execution root is outside its checkout.".to_owned());
    }
    let marker_path = PathBuf::from(&record.owner_marker_path)
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize ownership marker: {error}"))?;
    if marker_path != ownership_directory.join("ownership.json") {
        return Err("Managed marker path does not match its ownership directory.".to_owned());
    }
    let marker = read_marker(&marker_path)?;
    if marker.version != MARKER_VERSION
        || marker.worktree_id != record.id
        || marker.workspace_id != binding.workspace_public_id
        || marker.task_id != binding.task_id
        || marker.run_id != record.run_id
        || marker.canonical_checkout_path != display_path(&checkout)
        || marker.repository_common_dir_sha256 != record.repository_common_dir_sha256
        || marker.branch != record.branch
        || marker.created_at != record.created_at
    {
        return Err("Managed ownership marker does not match the database record.".to_owned());
    }
    let project_git = inspect_git_repository(Path::new(&binding.project_path))?;
    if display_path(&project_git.repository_root)
        != normalize_workspace_path(&record.repository_root)
        || path_sha256(&project_git.common_dir) != record.repository_common_dir_sha256
    {
        return Err("Managed worktree repository identity does not match the project.".to_owned());
    }
    let evidence = find_worktree_evidence(&project_git.repository_root, &checkout)?
        .ok_or("Git no longer reports the managed checkout.")?;
    if evidence.path != checkout || evidence.branch != record.branch || evidence.head.is_empty() {
        return Err("Git worktree evidence does not match the ownership record.".to_owned());
    }
    Ok(execution_root)
}

fn expected_ownership_directory(
    repository: &XiaoRepository,
    record: &ManagedWorktreeRecord,
) -> Result<PathBuf, String> {
    let managed_root = repository.app_data_dir().join("managed-worktrees");
    let managed_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize managed root: {error}"))?;
    let marker = PathBuf::from(&record.owner_marker_path);
    let ownership = marker
        .parent()
        .ok_or("Managed marker has no ownership directory.")?
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize ownership directory: {error}"))?;
    ensure_canonical_below(&managed_root, &ownership)?;
    Ok(ownership)
}

fn summarize_record(record: &ManagedWorktreeRecord) -> ManagedWorktreeSummary {
    let ownership = Path::new(&record.owner_marker_path)
        .parent()
        .unwrap_or_else(|| Path::new(&record.checkout_path));
    let (disk_bytes, size_complete) = directory_size(ownership, MAX_SIZE_ENTRIES);
    let has_changes = if Path::new(&record.checkout_path).is_dir() {
        managed_worktree_has_changes(Path::new(&record.execution_root)).ok()
    } else {
        None
    };
    ManagedWorktreeSummary {
        id: record.id.clone(),
        task_id: record.task_id.clone(),
        branch: record.branch.clone(),
        checkout_path: record.checkout_path.clone(),
        execution_root: record.execution_root.clone(),
        status: record.status,
        base_commit: record.base_commit.clone(),
        failure_reason: record.failure_reason.clone(),
        disk_bytes,
        size_complete,
        has_changes,
        created_at: record.created_at,
    }
}

fn write_marker(path: &Path, marker: &OwnershipMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("Could not serialize ownership marker: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    if !path.exists() && temporary.exists() {
        fs::remove_file(&temporary)
            .map_err(|error| format!("Could not clear interrupted ownership marker: {error}"))?;
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create temporary ownership marker: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("Could not write ownership marker: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync ownership marker: {error}"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not finalize ownership marker: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn read_marker(path: &Path) -> Result<OwnershipMarker, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read ownership marker: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid managed ownership marker: {error}"))
}

fn managed_branch(task_id: &str, worktree_id: &str) -> String {
    let ownership_id = worktree_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    format!("xiao/{}/{}", short_identifier(task_id), ownership_id)
}

fn short_identifier(value: &str) -> String {
    let filtered = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(10)
        .collect::<String>()
        .to_ascii_lowercase();
    if filtered.is_empty() {
        "task".to_owned()
    } else {
        filtered
    }
}

fn canonical_directory(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize Xiao {label}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("The Xiao {label} is not a directory."));
    }
    Ok(path)
}

fn ensure_lexically_below(root: &Path, candidate: &Path) -> Result<(), String> {
    if !candidate.starts_with(root) || candidate == root {
        return Err("Managed worktree path escaped the Xiao-managed root.".to_owned());
    }
    Ok(())
}

fn ensure_canonical_below(root: &Path, candidate: &Path) -> Result<(), String> {
    if !candidate.starts_with(root) || candidate == root {
        return Err("Canonical managed worktree path escaped the Xiao-managed root.".to_owned());
    }
    Ok(())
}

fn directory_size(root: &Path, max_entries: usize) -> (u64, bool) {
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0_u64;
    let mut entries = 0_usize;
    while let Some(path) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        entries += 1;
        if entries > max_entries {
            return (bytes, false);
        }
        if metadata.file_type().is_symlink() {
            bytes = bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            if let Ok(children) = fs::read_dir(path) {
                pending.extend(children.filter_map(Result::ok).map(|entry| entry.path()));
            }
        } else {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    (bytes, true)
}

fn path_sha256(path: &Path) -> String {
    sha256_hex(display_path(path).as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
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

#[cfg(test)]
fn crash_at_test_failpoint(phase: &str) {
    if std::env::var("XIAO_TEST_WORKTREE_CRASH_PHASE").as_deref() == Ok(phase) {
        std::process::abort();
    }
}

#[cfg(not(test))]
fn crash_at_test_failpoint(_phase: &str) {}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "Current timestamp is too large.".to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::xiao::models::{
        XiaoTaskDocument, XiaoWorkspaceDocument, XiaoWorkspaceMode, XiaoWorkspaceUpdate,
        XIAO_SCHEMA_VERSION,
    };

    static COUNTER: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-m2-{label}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            for _ in 0..10 {
                if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }

    fn task_update(workspace: &Path, task_id: &str) -> XiaoWorkspaceUpdate {
        let task = XiaoTaskDocument {
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
            thread_binding: None,
            mode: "default".to_owned(),
            approval_policy: "on-request".to_owned(),
            sandbox_mode: "workspace-write".to_owned(),
            goal: None,
            timeline: vec![json!({ "id": "entry", "kind": "user", "title": "test" })],
            timeline_loaded: true,
            timeline_complete: true,
            timeline_start: 0,
            timeline_entry_count: 1,
            plan: None,
            execution_environment_id: None,
            workspace_mode: XiaoWorkspaceMode::Local,
            managed_worktree_id: None,
        };
        let document = XiaoWorkspaceDocument {
            schema_version: XIAO_SCHEMA_VERSION,
            workspace_path: workspace.to_string_lossy().into_owned(),
            active_task_id: Some(task_id.to_owned()),
            show_archived: false,
            tasks: vec![task],
        };
        XiaoWorkspaceUpdate {
            schema_version: document.schema_version,
            workspace_path: document.workspace_path,
            active_task_id: document.active_task_id,
            show_archived: document.show_archived,
            task_ids: vec![task_id.to_owned()],
            tasks: document.tasks,
        }
    }

    fn create_directory_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .status()
                .unwrap();
            assert!(status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn initialize_git(root: &Path, nested: &Path) {
        fs::create_dir_all(nested).unwrap();
        run(root, &["init"]);
        run(root, &["config", "user.email", "xiao@example.com"]);
        run(root, &["config", "user.name", "Xiao Test"]);
        fs::write(root.join("outside.txt"), "outside baseline\n").unwrap();
        fs::write(nested.join("inside.txt"), "inside baseline\n").unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-m", "initial"]);
    }

    #[test]
    fn managed_cycle_preserves_dirty_main_and_nested_execution_root() {
        let directory = TestDirectory::new("cycle");
        let repository_root = directory.0.join("repository");
        let workspace = repository_root.join("nested").join("workspace");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &workspace);
        fs::write(repository_root.join("outside.txt"), "dirty outside\n").unwrap();
        fs::write(workspace.join("untracked.txt"), "dirty nested\n").unwrap();
        let status_before = git_bytes(&repository_root, &["status", "--porcelain=v1", "-z"]);
        let head_before = git_text(&repository_root, &["rev-parse", "HEAD"]);

        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&workspace, "task-cycle"))
            .unwrap();
        let context = prepare_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task-cycle",
        )
        .unwrap();
        assert_eq!(context.workspace_mode, XiaoWorkspaceMode::ManagedWorktree);
        assert_ne!(context.execution_root, display_path(&workspace));
        assert!(Path::new(&context.execution_root)
            .join("inside.txt")
            .is_file());
        assert!(!Path::new(&context.execution_root)
            .join("outside.txt")
            .exists());
        let managed = context.managed_worktree.as_ref().unwrap();
        assert!(Path::new(&managed.checkout_path)
            .join("outside.txt")
            .is_file());
        fs::write(
            Path::new(&context.execution_root).join("isolated.txt"),
            "isolated\n",
        )
        .unwrap();
        assert_eq!(
            git_bytes(&repository_root, &["status", "--porcelain=v1", "-z"]),
            status_before
        );
        assert_eq!(
            git_text(&repository_root, &["rev-parse", "HEAD"]),
            head_before
        );
        assert_eq!(
            fs::read_to_string(repository_root.join("outside.txt")).unwrap(),
            "dirty outside\n"
        );

        let listed = list_managed_worktrees(&repository, &workspace.to_string_lossy()).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].disk_bytes > 0);
        assert_eq!(listed[0].has_changes, Some(true));
        let local = remove_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task-cycle",
            &managed.id,
            true,
        )
        .unwrap();
        assert_eq!(local.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(!Path::new(&managed.checkout_path).exists());
        assert_eq!(
            git_bytes(&repository_root, &["status", "--porcelain=v1", "-z"]),
            status_before
        );
        assert_eq!(
            git_text(&repository_root, &["rev-parse", "HEAD"]),
            head_before
        );
    }

    #[test]
    fn managed_branches_keep_the_full_ownership_id() {
        let first = managed_branch("task", "019f6d53-3188-7000-8000-000000000001");
        let second = managed_branch("task", "019f6d53-3188-7000-8000-000000000002");
        assert_ne!(first, second);
        assert!(first.ends_with("019f6d53318870008000000000000001"));
    }

    #[test]
    fn setup_failure_compensates_without_touching_the_source_workspace() {
        let directory = TestDirectory::new("setup-compensation");
        let repository_root = directory.0.join("repository");
        let workspace = repository_root.join("empty-nested-workspace");
        let state = directory.0.join("state");
        fs::create_dir_all(&workspace).unwrap();
        run(&repository_root, &["init"]);
        run(
            &repository_root,
            &["config", "user.email", "xiao@example.com"],
        );
        run(&repository_root, &["config", "user.name", "Xiao Test"]);
        fs::write(repository_root.join("tracked.txt"), "preserve\n").unwrap();
        run(&repository_root, &["add", "."]);
        run(&repository_root, &["commit", "-m", "initial"]);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&workspace, "task"))
            .unwrap();

        let error =
            prepare_managed_task_environment(&repository, &display_path(&workspace), "task")
                .unwrap_err();
        assert!(error.contains("execution root"));
        assert!(workspace.is_dir());
        assert_eq!(
            fs::read_to_string(repository_root.join("tracked.txt")).unwrap(),
            "preserve\n"
        );
        let records = repository
            .list_managed_worktree_records(&display_path(&workspace))
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, ManagedWorktreeStatus::Failed);
        assert!(!Path::new(&records[0].checkout_path).exists());
        assert_eq!(
            git_text(&repository_root, &["worktree", "list", "--porcelain"])
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1
        );
    }

    #[test]
    fn unicode_and_long_nested_paths_round_trip() {
        let directory = TestDirectory::new("unicode-long-path");
        let repository_root = directory.0.join("项目-répertoire");
        let workspace = repository_root
            .join("nested-đường-dẫn-abcdefghijklmnopqrstuvwxyz")
            .join("more-层级-abcdefghijklmnopqrstuvwxyz")
            .join("workspace");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &workspace);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&workspace, "task-unicode"))
            .unwrap();

        let managed = prepare_managed_task_environment(
            &repository,
            &display_path(&workspace),
            "task-unicode",
        )
        .unwrap();
        assert!(Path::new(&managed.execution_root)
            .join("inside.txt")
            .is_file());
        let worktree_id = managed.managed_worktree.unwrap().id;
        let local = remove_managed_task_environment(
            &repository,
            &display_path(&workspace),
            "task-unicode",
            &worktree_id,
            true,
        )
        .unwrap();
        assert_eq!(
            local.execution_root,
            display_path(&workspace.canonicalize().unwrap())
        );

        #[cfg(windows)]
        {
            let case_variant = display_path(&workspace).to_uppercase();
            let context =
                resolve_execution_context(&repository, &case_variant, Some("task-unicode"))
                    .unwrap();
            assert_eq!(context.workspace_mode, XiaoWorkspaceMode::Local);
        }
    }

    #[test]
    fn non_git_and_unborn_projects_refuse_isolation_but_keep_local_context() {
        let directory = TestDirectory::new("non-git");
        let workspace = directory.0.join("workspace");
        let state = directory.0.join("state");
        fs::create_dir_all(&workspace).unwrap();
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&workspace, "task"))
            .unwrap();
        let local =
            resolve_execution_context(&repository, &workspace.to_string_lossy(), Some("task"))
                .unwrap();
        assert_eq!(local.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(!local.isolation_available);
        assert!(prepare_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task"
        )
        .is_err());

        run(&workspace, &["init"]);
        assert!(prepare_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task"
        )
        .unwrap_err()
        .contains("at least one Git commit"));
    }

    #[test]
    fn tampered_marker_refuses_cleanup_and_preserves_checkout() {
        let directory = TestDirectory::new("tampered-marker");
        let repository_root = directory.0.join("repository");
        let workspace = repository_root.clone();
        let state = directory.0.join("state");
        initialize_git(&repository_root, &workspace);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&workspace, "task"))
            .unwrap();
        let context =
            prepare_managed_task_environment(&repository, &workspace.to_string_lossy(), "task")
                .unwrap();
        let managed = context.managed_worktree.unwrap();
        let marker_path = Path::new(&managed.checkout_path)
            .parent()
            .unwrap()
            .join("ownership.json");
        let marker_bytes = fs::read(&marker_path).unwrap();
        fs::remove_file(&marker_path).unwrap();
        let missing = remove_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task",
            &managed.id,
            true,
        )
        .unwrap_err();
        assert!(missing.contains("marker"));

        fs::write(&marker_path, b"not json").unwrap();
        let malformed = remove_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task",
            &managed.id,
            true,
        )
        .unwrap_err();
        assert!(malformed.contains("Invalid managed ownership marker"));

        let mut marker: serde_json::Value = serde_json::from_slice(&marker_bytes).unwrap();
        marker["taskId"] = json!("different-task");
        fs::write(&marker_path, serde_json::to_vec_pretty(&marker).unwrap()).unwrap();
        let mismatched = remove_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task",
            &managed.id,
            true,
        )
        .unwrap_err();
        assert!(mismatched.contains("marker"));
        assert!(Path::new(&managed.checkout_path).is_dir());
        assert!(
            find_worktree_evidence(&repository_root, &PathBuf::from(&managed.checkout_path))
                .unwrap()
                .is_some()
        );

        fs::write(&marker_path, marker_bytes).unwrap();
        remove_managed_task_environment(
            &repository,
            &workspace.to_string_lossy(),
            "task",
            &managed.id,
            true,
        )
        .unwrap();
        assert!(!Path::new(&managed.checkout_path).exists());
    }

    #[test]
    fn manual_worktrees_are_unowned_and_never_cleanup_targets() {
        let directory = TestDirectory::new("manual-unowned");
        let repository_root = directory.0.join("repository");
        let manual_checkout = directory.0.join("manual-checkout");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &repository_root);
        crate::git::service::create_worktree(
            &display_path(&repository_root),
            &display_path(&manual_checkout),
            "manual/test",
        )
        .unwrap();
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&repository_root, "task"))
            .unwrap();

        let error = remove_managed_task_environment(
            &repository,
            &display_path(&repository_root),
            "task",
            "not-owned",
            true,
        )
        .unwrap_err();
        assert!(error.contains("no managed worktree"));
        assert!(manual_checkout.is_dir());
        assert!(find_worktree_evidence(&repository_root, &manual_checkout)
            .unwrap()
            .is_some());
        remove_managed_worktree(&repository_root, &manual_checkout).unwrap();
    }

    #[test]
    fn task_bindings_cannot_cross_workspace_boundaries() {
        let directory = TestDirectory::new("cross-workspace");
        let first = directory.0.join("first");
        let second = directory.0.join("second");
        initialize_git(&first, &first);
        initialize_git(&second, &second);
        let repository = XiaoRepository::open(&directory.0.join("state")).unwrap();
        repository
            .save_workspace(task_update(&first, "task-a"))
            .unwrap();
        repository
            .save_workspace(task_update(&second, "task-b"))
            .unwrap();

        let error = resolve_execution_context(&repository, &display_path(&second), Some("task-a"))
            .unwrap_err();
        assert!(error.contains("not found"), "{error}");
        let context =
            resolve_execution_context(&repository, &display_path(&second), Some("task-b")).unwrap();
        assert_eq!(
            context.project_path,
            display_path(&second.canonicalize().unwrap())
        );
    }

    #[test]
    fn replaced_checkout_link_cannot_redirect_cleanup() {
        let directory = TestDirectory::new("checkout-link");
        let repository_root = directory.0.join("repository");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &repository_root);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&repository_root, "task"))
            .unwrap();
        let context =
            prepare_managed_task_environment(&repository, &display_path(&repository_root), "task")
                .unwrap();
        let managed = context.managed_worktree.unwrap();
        let checkout = PathBuf::from(&managed.checkout_path);
        remove_managed_worktree(&repository_root, &checkout).unwrap();
        create_directory_link(&repository_root, &checkout);

        let error = remove_managed_task_environment(
            &repository,
            &display_path(&repository_root),
            "task",
            &managed.id,
            true,
        )
        .unwrap_err();
        assert!(
            error.contains("escaped") || error.contains("does not match"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(repository_root.join("outside.txt")).unwrap(),
            "outside baseline\n"
        );
        fs::remove_dir(&checkout).unwrap();
    }

    #[test]
    fn database_path_outside_managed_root_refuses_cleanup() {
        let directory = TestDirectory::new("outside-root");
        let repository_root = directory.0.join("repository");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &repository_root);
        fs::create_dir_all(state.join("managed-worktrees")).unwrap();
        let outside = directory.0.join("outside-owned");
        let checkout = outside.join("checkout");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("sentinel.txt"), "preserve").unwrap();
        let marker = outside.join("ownership.json");
        fs::write(&marker, "{}").unwrap();

        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&repository_root, "task"))
            .unwrap();
        let binding = repository
            .task_execution_binding(&repository_root.to_string_lossy(), "task")
            .unwrap();
        let id = Uuid::now_v7().to_string();
        repository
            .begin_managed_worktree(NewManagedWorktreeRecord {
                id: id.clone(),
                workspace_id: binding.workspace_id,
                task_id: "task".to_owned(),
                repository_root: display_path(&repository_root.canonicalize().unwrap()),
                repository_common_dir_sha256: "hash".to_owned(),
                checkout_path: display_path(&checkout.canonicalize().unwrap()),
                execution_root: display_path(&checkout.canonicalize().unwrap()),
                branch: format!("xiao/task/{}", &id[..8]),
                base_commit: git_text(&repository_root, &["rev-parse", "HEAD"]),
                owner_marker_path: display_path(&marker.canonicalize().unwrap()),
                created_at: now_millis().unwrap(),
            })
            .unwrap();
        repository
            .activate_managed_worktree(
                &id,
                &display_path(&checkout.canonicalize().unwrap()),
                &display_path(&checkout.canonicalize().unwrap()),
                &display_path(&marker.canonicalize().unwrap()),
            )
            .unwrap();

        let error = remove_managed_task_environment(
            &repository,
            &repository_root.to_string_lossy(),
            "task",
            &id,
            true,
        )
        .unwrap_err();
        assert!(error.contains("escaped"));
        assert_eq!(
            fs::read_to_string(checkout.join("sentinel.txt")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn interrupted_setup_and_cleanup_resume_from_durable_intent() {
        let directory = TestDirectory::new("recovery");
        let project = directory.0.join("repository");
        let state = directory.0.join("state");
        initialize_git(&project, &project);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&project, "task"))
            .unwrap();
        let binding = repository
            .task_execution_binding(&display_path(&project), "task")
            .unwrap();
        let git = inspect_git_repository(&project).unwrap();
        let common_hash = path_sha256(&git.common_dir);
        let managed_root = repository.app_data_dir().join("managed-worktrees");
        fs::create_dir_all(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let id = "interrupted-setup";
        let workspace_key =
            sha256_hex(format!("{}\0{}", binding.workspace_public_id, common_hash).as_bytes());
        let ownership = managed_root.join(&workspace_key[..16]).join(id);
        let checkout = ownership.join("checkout");
        let marker = ownership.join("ownership.json");
        let branch = managed_branch("task", id);
        fs::create_dir_all(ownership.parent().unwrap()).unwrap();
        repository
            .begin_managed_worktree(NewManagedWorktreeRecord {
                id: id.to_owned(),
                workspace_id: binding.workspace_id,
                task_id: "task".to_owned(),
                repository_root: display_path(&git.repository_root),
                repository_common_dir_sha256: common_hash,
                checkout_path: display_path(&checkout),
                execution_root: display_path(&checkout),
                branch: branch.clone(),
                base_commit: git.head.clone(),
                owner_marker_path: display_path(&marker),
                created_at: now_millis().unwrap(),
            })
            .unwrap();
        fs::create_dir(&ownership).unwrap();
        create_managed_worktree(&git, &checkout, &branch).unwrap();

        let managed =
            prepare_managed_task_environment(&repository, &display_path(&project), "task").unwrap();
        assert_eq!(managed.workspace_mode, XiaoWorkspaceMode::ManagedWorktree);
        assert!(marker.exists());

        let record = repository
            .begin_managed_worktree_removal(&display_path(&project), "task", id)
            .unwrap();
        remove_managed_worktree(&git.repository_root, Path::new(&record.checkout_path)).unwrap();
        assert!(!checkout.exists());
        assert!(ownership.exists());

        let local =
            remove_managed_task_environment(&repository, &display_path(&project), "task", id, true)
                .unwrap();
        assert_eq!(local.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(!ownership.exists());
        assert!(project.exists());
    }

    #[test]
    #[ignore = "manual performance baseline for managed worktrees"]
    fn benchmark_managed_worktree_cycle() {
        let directory = TestDirectory::new("benchmark");
        let project = directory.0.join("repository");
        initialize_git(&project, &project);
        let repository = XiaoRepository::open(&directory.0.join("state")).unwrap();
        repository
            .save_workspace(task_update(&project, "task"))
            .unwrap();

        let setup_started = std::time::Instant::now();
        let managed =
            prepare_managed_task_environment(&repository, &display_path(&project), "task").unwrap();
        let setup_elapsed = setup_started.elapsed();
        let worktree_id = managed.managed_worktree.unwrap().id;
        let cleanup_started = std::time::Instant::now();
        remove_managed_task_environment(
            &repository,
            &display_path(&project),
            "task",
            &worktree_id,
            true,
        )
        .unwrap();
        let cleanup_elapsed = cleanup_started.elapsed();
        eprintln!(
            "managed_worktree_benchmark setup_ms={} cleanup_ms={}",
            setup_elapsed.as_millis(),
            cleanup_elapsed.as_millis()
        );
        assert!(setup_elapsed < std::time::Duration::from_secs(5));
        assert!(cleanup_elapsed < std::time::Duration::from_secs(3));
    }

    #[test]
    #[ignore = "process-kill safety probe; run explicitly for M2 release validation"]
    fn managed_worktree_crash_recovery_probe() {
        if let Ok(phase) = std::env::var("XIAO_TEST_WORKTREE_CRASH_PHASE") {
            let root = PathBuf::from(std::env::var("XIAO_TEST_WORKTREE_CRASH_ROOT").unwrap());
            let project = root.join("repository");
            let repository = XiaoRepository::open(&root.join("state")).unwrap();
            if phase == "after-git-add" {
                let _ =
                    prepare_managed_task_environment(&repository, &display_path(&project), "task");
            } else if phase == "after-git-remove" {
                let worktree_id = std::env::var("XIAO_TEST_WORKTREE_ID").unwrap();
                let _ = remove_managed_task_environment(
                    &repository,
                    &display_path(&project),
                    "task",
                    &worktree_id,
                    true,
                );
            }
            panic!("Crash failpoint `{phase}` was not reached");
        }

        let directory = TestDirectory::new("crash-probe");
        let project = directory.0.join("repository");
        let state = directory.0.join("state");
        initialize_git(&project, &project);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&project, "task"))
            .unwrap();
        let test_name = "execution::service::tests::managed_worktree_crash_recovery_probe";
        let spawn_crash = |phase: &str, worktree_id: Option<&str>| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--ignored", "--exact", test_name, "--nocapture"])
                .env("XIAO_TEST_WORKTREE_CRASH_PHASE", phase)
                .env("XIAO_TEST_WORKTREE_CRASH_ROOT", &directory.0);
            if let Some(worktree_id) = worktree_id {
                command.env("XIAO_TEST_WORKTREE_ID", worktree_id);
            }
            let status = command.status().unwrap();
            assert!(!status.success(), "failpoint child unexpectedly survived");
        };

        spawn_crash("after-git-add", None);
        let preparing = repository
            .list_managed_worktree_records(&display_path(&project))
            .unwrap()
            .into_iter()
            .find(|record| record.status == ManagedWorktreeStatus::Preparing)
            .unwrap();
        assert!(Path::new(&preparing.checkout_path).is_dir());
        assert!(!Path::new(&preparing.owner_marker_path).exists());
        assert_eq!(
            repository
                .task_execution_binding(&display_path(&project), "task")
                .unwrap()
                .workspace_mode,
            XiaoWorkspaceMode::Local,
        );

        let managed =
            prepare_managed_task_environment(&repository, &display_path(&project), "task").unwrap();
        let worktree_id = managed.managed_worktree.unwrap().id;
        spawn_crash("after-git-remove", Some(&worktree_id));
        let removing = repository
            .list_managed_worktree_records(&display_path(&project))
            .unwrap()
            .into_iter()
            .find(|record| record.id == worktree_id)
            .unwrap();
        assert_eq!(removing.status, ManagedWorktreeStatus::Removing);
        assert!(!Path::new(&removing.checkout_path).exists());
        assert!(Path::new(&removing.owner_marker_path).exists());

        let local = remove_managed_task_environment(
            &repository,
            &display_path(&project),
            "task",
            &worktree_id,
            true,
        )
        .unwrap();
        assert_eq!(local.workspace_mode, XiaoWorkspaceMode::Local);
        assert!(repository
            .list_managed_worktree_records(&display_path(&project))
            .unwrap()
            .into_iter()
            .all(|record| record.id != worktree_id));
    }

    #[test]
    fn cleanup_requires_explicit_confirmation() {
        let directory = TestDirectory::new("confirmation");
        let repository_root = directory.0.join("repository");
        let state = directory.0.join("state");
        initialize_git(&repository_root, &repository_root);
        let repository = XiaoRepository::open(&state).unwrap();
        repository
            .save_workspace(task_update(&repository_root, "task"))
            .unwrap();
        let context = prepare_managed_task_environment(
            &repository,
            &repository_root.to_string_lossy(),
            "task",
        )
        .unwrap();
        let managed = context.managed_worktree.unwrap();
        let error = remove_managed_task_environment(
            &repository,
            &repository_root.to_string_lossy(),
            "task",
            &managed.id,
            false,
        )
        .unwrap_err();
        assert!(error.contains("explicit confirmation"));
        assert!(Path::new(&managed.checkout_path).is_dir());
        assert_eq!(
            resolve_execution_context(
                &repository,
                &repository_root.to_string_lossy(),
                Some("task")
            )
            .unwrap()
            .workspace_mode,
            XiaoWorkspaceMode::ManagedWorktree
        );
    }

    fn git_text(root: &Path, arguments: &[&str]) -> String {
        String::from_utf8(git_bytes(root, arguments))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn git_bytes(root: &Path, arguments: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {:?} failed", arguments);
        output.stdout
    }

    fn run(root: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {:?} failed", arguments);
    }
}
