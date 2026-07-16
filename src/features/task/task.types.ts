import type {
  AgentApprovalPolicy,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentPlan,
  AgentSandboxMode,
  TimelineEntry,
} from "../../core/models/agent";

export type TaskGroup = "Active" | "Recent" | "Yesterday" | "This week";

export type WorkbenchTask = {
  id: string;
  title: string;
  meta: string;
  group: TaskGroup;
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  draftText: string;
  followUps: AgentFollowUp[];
  model: string | null;
  reasoningEffort: string | null;
  threadId: string | null;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  goal: AgentGoal | null;
  timeline: TimelineEntry[];
  plan: AgentPlan | null;
  origin?: "xiao" | "codex";
  historyLoaded?: boolean;
  historyCursor?: string | null;
  historyLoadingOlder?: boolean;
};
