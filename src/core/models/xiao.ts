import type {
  AgentApprovalPolicy,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentPlan,
  AgentSandboxMode,
  TimelineEntry,
} from "./agent";

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
  threadId?: string | null;
  mode?: AgentMode;
  approvalPolicy?: AgentApprovalPolicy;
  sandboxMode?: AgentSandboxMode;
  goal?: AgentGoal | null;
  timeline: TimelineEntry[];
  plan?: AgentPlan | null;
  origin?: "xiao" | "codex";
  historyLoaded?: boolean;
  historyCursor?: string | null;
  historyLoadingOlder?: boolean;
};

export type XiaoProjectSummary = {
  path: string;
  name: string;
  updatedAt: number;
  taskCount?: number;
  pinned?: boolean;
};

export type XiaoWorkspaceDocument = {
  schemaVersion: 1;
  workspacePath: string;
  activeTaskId: string | null;
  showArchived: boolean;
  tasks: XiaoTaskDocument[];
};
