export type RuntimePhase = "offline" | "starting" | "ready" | "working" | "error";
export type AgentTurnOutcome = "completed" | "failed" | "interrupted";

export type AgentMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type AgentExplorationAction = {
  kind: "command" | "list" | "read" | "search" | "web";
  command: string;
  label: string;
  path?: string;
  query?: string;
};

export type AgentQuestionOption = {
  label: string;
  description: string;
};

export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: AgentQuestionOption[];
};

export type AgentQuestionRequest = {
  requestId: number | string;
  pendingInputId: string;
  runId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AgentQuestion[];
  autoResolutionMs: number | null;
  receivedAt: number;
};

export type AgentApprovalRequestKind = "action" | "permissions";

export type TimelineEntry = {
  id: string;
  kind: "brief" | "thought" | "command" | "explore" | "change" | "result" | "approval" | "user";
  title: string;
  createdAt?: number;
  durationMs?: number;
  body?: string;
  messagePhase?: "commentary" | "final_answer";
  meta?: string;
  status?: "idle" | "active" | "success" | "warning" | "error";
  command?: string;
  exploration?: AgentExplorationAction[];
  files?: Array<{ path: string; additions: number; deletions: number; patch?: string }>;
  attachments?: AgentAttachment[];
  requestId?: number | string;
  pendingInputId?: string;
  runId?: string;
  approvalKind?: AgentApprovalRequestKind;
  approvalPermissions?: Record<string, unknown>;
  turnId?: string;
  turnDiff?: string;
};

export type AgentRuntimeState = {
  phase: RuntimePhase;
  taskId: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStartedAt: number | null;
  error: string | null;
  eventsSeen: number;
};

export type AgentAttachment = {
  id?: string;
  name: string;
  path: string;
  kind: "directory" | "file" | "image" | "review";
  url?: string;
  lineStart?: number;
  lineEnd?: number;
  comment?: string;
  preview?: string;
};

export type AgentFollowUp = {
  id: string;
  prompt: string;
  attachments: AgentAttachment[];
  createdAt: number;
};

export type AgentUndoResult = {
  prompt: string;
  attachments: AgentAttachment[];
};

export type AgentMode = "default" | "plan";
export type AgentApprovalPolicy = "never" | "on-request" | "untrusted";
export type AgentSandboxMode = "danger-full-access" | "read-only" | "workspace-write";

export type AgentGoal = {
  objective: string;
  status: "active" | "paused" | "complete";
};

export type AgentPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type AgentPlan = {
  explanation: string | null;
  steps: AgentPlanStep[];
};

export type RuntimeLogEntry = {
  id: string;
  timestamp: number;
  stream: "system" | "event" | "stdout" | "stderr";
  text: string;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export const normalizeThreadTokenUsage = (
  usage: ThreadTokenUsage | TokenUsageBreakdown | null,
  fallbackContextWindow?: number | null,
): ThreadTokenUsage | null => {
  if (!usage) return null;
  if ("total" in usage && "last" in usage) return usage;
  return {
    total: usage,
    last: usage,
    modelContextWindow: fallbackContextWindow ?? null,
  };
};

export const contextUsedPercent = (
  usage: ThreadTokenUsage | TokenUsageBreakdown | null,
  fallbackContextWindow?: number | null,
) => {
  const normalized = normalizeThreadTokenUsage(usage, fallbackContextWindow);
  if (!normalized) return null;
  const contextWindow = normalized.modelContextWindow ?? fallbackContextWindow;
  if (!contextWindow || contextWindow <= 0) return null;

  return Math.min(100, Math.max(0, Math.round((normalized.last.totalTokens / contextWindow) * 100)));
};

export type CodexUsageDay = TokenUsageBreakdown & {
  date: string;
};

export type CodexUsageSnapshot = {
  days: CodexUsageDay[];
  totals: TokenUsageBreakdown;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
};

export type AgentAccountSummary = {
  authenticated: boolean;
  authMode: string | null;
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
};

export type AgentAccountUsage = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
};

export type AgentRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type AgentRateLimitResetCredit = {
  id: string;
  status: string;
  resetType: string | null;
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
};

export type AgentRateLimits = {
  primary: AgentRateLimitWindow | null;
  secondary: AgentRateLimitWindow | null;
  creditsRemaining: number | null;
  rateLimitReachedType: string | null;
  resetCredits: {
    availableCount: number;
    credits: AgentRateLimitResetCredit[] | null;
  } | null;
  spendControlReached: boolean | null;
  updatedAt: number;
};

export type CodexThreadSummary = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  status: "notLoaded" | "idle" | "systemError" | "active";
};

export type ThreadChangeSummary = {
  files: number;
  additions: number;
  deletions: number;
};

export type AgentThreadTokenUsage = TokenUsageBreakdown & {
  threadId: string;
  model: string | null;
  originator: string | null;
  updatedAt: number;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
};

export type AgentModelSummary = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: AgentReasoningEffortOption[];
  serviceTiers: AgentModelServiceTier[];
  contextWindow?: number | null;
};

export type AgentModelServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type AgentReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type XiaoHistoryItem = {
  role: "user" | "assistant";
  text: string;
};
