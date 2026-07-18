import type { AgentMessage, XiaoHistoryItem } from "./agent";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_input"
  | "verifying"
  | "completed"
  | "needs_attention"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunAgentOutcome = "pending" | "completed" | "failed" | "interrupted" | "cancelled";
export type RunVerificationOutcome = "not_requested" | "pending" | "passed" | "failed" | "blocked";

export type RunSnapshot = {
  id: string;
  workspacePath: string;
  taskId: string;
  idempotencyKey: string;
  parentRunId: string | null;
  candidateGroupId: string | null;
  routineOccurrenceId: string | null;
  status: RunStatus;
  agentOutcome: RunAgentOutcome;
  verificationOutcome: RunVerificationOutcome;
  executionEnvironmentId: string;
  executionRoot: string;
  managedWorktreeId: string | null;
  prompt: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  mode: string;
  approvalPolicy: string;
  sandboxMode: string;
  threadId: string | null;
  threadSource: string | null;
  cliVersion: string | null;
  runtimeGeneration: number | null;
  turnId: string | null;
  cancelRequested: boolean;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  version: number;
};

export type RunEventRecord = {
  runId: string;
  sequence: number;
  timestamp: number;
  eventType: string;
  eventKey: string | null;
  safePayload: unknown;
};

export type RunEventPage = {
  events: RunEventRecord[];
  nextSequence: number | null;
};

export type PendingInputKind =
  | "command_approval"
  | "file_approval"
  | "permissions"
  | "question"
  | "mcp_elicitation";

export type PendingInputSnapshot = {
  id: string;
  runId: string;
  runtimeGeneration: number;
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: PendingInputKind;
  safeSummary: unknown;
  openedAt: number;
  resolvedAt: number | null;
  invalidatedAt: number | null;
};

export type RunUpdateEnvelope = {
  snapshot: RunSnapshot;
  event: RunEventRecord | null;
  pendingInput: PendingInputSnapshot | null;
};

export type RunProtocolEnvelope = {
  runId: string;
  taskId: string;
  executionEnvironmentId: string;
  runtimeGeneration: number;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  sequence: number | null;
  message: AgentMessage;
  turnDiff: string | null;
  pendingInput: PendingInputSnapshot | null;
};

export type EnqueueRunRequest = {
  projectPath: string;
  taskId: string;
  idempotencyKey: string;
  prompt: string;
  input: Array<Record<string, unknown>>;
  history: XiaoHistoryItem[];
  serviceTier: string | null;
};
