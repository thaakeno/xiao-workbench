use serde::Serialize;

use crate::execution::models::ExecutionContext;
use crate::git::models::GitSummary;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Directory,
    File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub name: String,
    pub path: String,
    pub execution: ExecutionContext,
    pub files: Vec<FileNode>,
    pub git: Option<GitSummary>,
}
