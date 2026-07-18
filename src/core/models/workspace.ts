import type { XiaoWorkspaceMode } from "./xiao";

export type FileNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: FileNode[];
};

export type GitSummary = {
  branch: string;
  repositoryRoot: string;
  workspaceScoped: boolean;
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
  clean: boolean;
  changes: GitFileChange[];
  changesTruncated: boolean;
};

export type GitBranch = {
  name: string;
  current: boolean;
  remote: boolean;
};

export type GitFileChange = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
  additions: number;
  deletions: number;
  patch: string;
  patchTruncated: boolean;
};

export type ExecutionEnvironmentSummary = {
  id: string;
  kind: "windows" | "wsl";
  label: string;
  availability: "available" | "unavailable";
};

export type ManagedWorktreeStatus = "preparing" | "active" | "removing" | "failed" | "removed";

export type ManagedWorktreeSummary = {
  id: string;
  taskId: string;
  branch: string;
  checkoutPath: string;
  executionRoot: string;
  status: ManagedWorktreeStatus;
  baseCommit: string;
  failureReason: string | null;
  diskBytes: number;
  sizeComplete: boolean;
  hasChanges: boolean | null;
  createdAt: number;
};

export type ExecutionContext = {
  projectPath: string;
  executionRoot: string;
  environment: ExecutionEnvironmentSummary;
  workspaceMode: XiaoWorkspaceMode;
  managedWorktree: ManagedWorktreeSummary | null;
  isolationAvailable: boolean;
  isolationUnavailableReason: string | null;
};

export type WorkspaceSnapshot = {
  name: string;
  path: string;
  execution: ExecutionContext;
  files: FileNode[];
  git: GitSummary | null;
};

export type SystemInfo = {
  platform: string;
  shell: string;
  codexVersion: string | null;
};

export type CodexUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  updateMethod: string | null;
  installationSource: string;
};

export type CodexUpdateResult = {
  previousVersion: string;
  version: string;
  output: string;
};
