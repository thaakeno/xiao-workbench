use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub branch: String,
    pub repository_root: String,
    pub workspace_scoped: bool,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub untracked: usize,
    pub clean: bool,
    pub changes: Vec<GitFileChange>,
    pub changes_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: GitFileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub patch: String,
    pub patch_truncated: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
    Untracked,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct GitRepositoryIdentity {
    pub repository_root: PathBuf,
    pub common_dir: PathBuf,
    pub workspace_relative: PathBuf,
    pub head: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GitWorktreeEvidence {
    pub path: PathBuf,
    pub branch: String,
    pub head: String,
}
