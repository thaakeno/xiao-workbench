import type {
  AgentApprovalPolicy,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentPlan,
  AgentSandboxMode,
  TimelineEntry,
} from "./agent";

export type XiaoThreadPersistence = "ephemeral" | "persistent" | "legacy-untrusted";
export type XiaoWorkspaceMode = "local" | "managed-worktree";

export type XiaoThreadBinding = {
  threadId: string;
  persistence: XiaoThreadPersistence;
  materialized: boolean;
  threadSource: string | null;
  cliVersion: string | null;
};

export type XiaoTaskDocument = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  draftText?: string;
  followUps?: AgentFollowUp[];
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  model: string | null;
  reasoningEffort: string | null;
  /** Legacy transport field. New writes use threadBinding instead. */
  threadId?: string | null;
  threadBinding?: XiaoThreadBinding | null;
  mode?: AgentMode;
  approvalPolicy?: AgentApprovalPolicy;
  sandboxMode?: AgentSandboxMode;
  goal?: AgentGoal | null;
  timeline: TimelineEntry[];
  timelineLoaded: boolean;
  timelineComplete: boolean;
  timelineStart: number;
  timelineEntryCount: number;
  plan?: AgentPlan | null;
  origin?: "xiao" | "codex";
  historyLoaded?: boolean;
  historyCursor?: string | null;
  historyLoadingOlder?: boolean;
  executionEnvironmentId?: string | null;
  workspaceMode?: XiaoWorkspaceMode;
  managedWorktreeId?: string | null;
};

export type XiaoProjectSummary = {
  path: string;
  name: string;
  updatedAt: number;
  taskCount: number;
  pinned?: boolean;
};

export type XiaoContributionSummary = {
  tasksCompleted: number;
  repositoriesReviewed: number;
  filesModified: number;
  terminalCommandsExecuted: number;
};

export type XiaoWorkspaceDocument = {
  schemaVersion: 1;
  workspacePath: string;
  activeTaskId: string | null;
  showArchived: boolean;
  tasks: XiaoTaskDocument[];
};

export type XiaoWorkspaceUpdate = {
  schemaVersion: 1;
  workspacePath: string;
  activeTaskId: string | null;
  showArchived: boolean;
  taskIds: string[];
  tasks: XiaoTaskDocument[];
};

export type XiaoTimelinePage = {
  entries: TimelineEntry[];
  start: number;
  total: number;
  hasMore: boolean;
};
