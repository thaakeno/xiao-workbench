import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type {
  AgentAccountSummary,
  AgentAccountUsage,
  AgentAttachment,
  AgentApprovalPolicy,
  AgentGoal,
  AgentMessage,
  AgentMode,
  AgentModelSummary,
  AgentPlan,
  AgentQuestionRequest,
  AgentRateLimits,
  AgentRuntimeState,
  AgentSandboxMode,
  AgentTurnOutcome,
  AgentUndoResult,
  RuntimeLogEntry,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TimelineEntry,
  XiaoHistoryItem,
} from "../../../core/models/agent";
import { useCodexUsage } from "../../profile/hooks/useCodexUsage";
import {
  approvalResponse,
  contextCompactionTimelineEntry,
  mcpElicitationDeclineResponse,
  needsAgentSession,
  permissionGrantFromRequest,
  threadCompactRequest,
} from "./agentProtocol";

const MAX_RUNTIME_LOGS = 240;
const RATE_LIMIT_SNAPSHOT_KEY = "xiao.rate-limit-snapshot.v1";
const MAX_PERSISTED_TOOL_OUTPUT = 32_000;
const MAX_PERSISTED_PATCH = 40_000;
const PLAN_PROGRESS_INSTRUCTIONS =
  "When you publish a task plan with update_plan, keep it current throughout execution. " +
  "As soon as a step finishes, mark it completed and set the next step to in_progress before continuing. " +
  "Do not wait until the final response to batch plan status changes.";

type TurnStartResponse = { turn?: { id?: string } };

const initialRuntime: AgentRuntimeState = {
  phase: "offline",
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 0,
};

const readMessageThreadId = (message: AgentMessage) => {
  const id = message.params?.threadId;
  return typeof id === "string" ? id : null;
};

const readItem = (message: AgentMessage) => {
  const item = message.params?.item;
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
};

const readItemId = (message: AgentMessage) => {
  const id = message.params?.itemId;
  return typeof id === "string" ? id : null;
};

const readExplorationActions = (item: Record<string, unknown>) => {
  if (!Array.isArray(item.commandActions) || !item.commandActions.length) return null;
  const fallbackCommand = typeof item.command === "string" ? item.command : "";
  const actions: NonNullable<TimelineEntry["exploration"]> = [];

  for (const rawAction of item.commandActions) {
    if (!rawAction || typeof rawAction !== "object") return null;
    const action = rawAction as Record<string, unknown>;
    const command = typeof action.command === "string" ? action.command : fallbackCommand;
    const path = typeof action.path === "string" ? action.path : undefined;

    if (action.type === "read") {
      const name = typeof action.name === "string" ? action.name : undefined;
      actions.push({
        kind: "read",
        command,
        label: name || path?.split(/[\\/]/).filter(Boolean).at(-1) || "file",
        path,
      });
      continue;
    }
    if (action.type === "listFiles") {
      actions.push({ kind: "list", command, label: path || "workspace", path });
      continue;
    }
    if (action.type === "search") {
      const query = typeof action.query === "string" ? action.query : undefined;
      actions.push({ kind: "search", command, label: query || path || "workspace", path, query });
      continue;
    }

    // Mixed or unknown command actions stay visible as a normal command.
    return null;
  }

  return actions.length ? actions : null;
};

const readQuestionRequest = (
  message: AgentMessage,
  taskId: string,
): AgentQuestionRequest | null => {
  if (message.id == null || !Array.isArray(message.params?.questions)) return null;
  const questions = message.params.questions.flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object") return [];
    const question = rawQuestion as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      typeof question.header !== "string" ||
      typeof question.question !== "string"
    ) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (!rawOption || typeof rawOption !== "object") return [];
          const option = rawOption as Record<string, unknown>;
          return typeof option.label === "string" && typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [];
        })
      : [];
    return [{
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    }];
  });
  if (!questions.length) return null;

  const autoResolutionMs = message.params.autoResolutionMs;
  return {
    requestId: message.id,
    taskId,
    threadId: typeof message.params.threadId === "string" ? message.params.threadId : "",
    turnId: typeof message.params.turnId === "string" ? message.params.turnId : "",
    itemId: typeof message.params.itemId === "string" ? message.params.itemId : "",
    questions,
    autoResolutionMs:
      typeof autoResolutionMs === "number" && autoResolutionMs >= 0 ? autoResolutionMs : null,
    receivedAt: Date.now(),
  };
};

const countDiffLines = (diff: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
};

const boundedPersistedText = (value: unknown, limit: number) => {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[Output truncated by Xiao]`;
};

const readTokenUsage = (value: unknown): TokenUsageBreakdown | null => {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const fields: Array<keyof TokenUsageBreakdown> = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ];
  if (!fields.every((field) => typeof usage[field] === "number" && usage[field] >= 0)) {
    return null;
  }
  return Object.fromEntries(fields.map((field) => [field, usage[field]])) as TokenUsageBreakdown;
};

export const timelineEntryFromItem = (
  item: Record<string, unknown>,
  createdAt = Date.now(),
): TimelineEntry | null => {
  const contextCompaction = contextCompactionTimelineEntry(item, "completed");
  if (contextCompaction) return contextCompaction;

  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  if (item.type === "agentMessage" && typeof item.text === "string") {
    return {
      id,
      kind: "result",
      title: "Agent response",
      createdAt,
      body: item.text,
      meta: "Xiao",
      status: "success",
    };
  }

  if (item.type === "plan" && typeof item.text === "string") {
    return {
      id,
      kind: "thought",
      title: "Plan",
      createdAt,
      body: item.text,
      meta: "Plan",
      status: "success",
    };
  }

  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string").join("\n\n")
      : "";
    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string").join("\n\n")
      : "";
    return {
      id,
      kind: "thought",
      title: "Reasoning complete",
      createdAt,
      body: summary || content || undefined,
      meta: "Xiao",
      status: "success",
    };
  }

  if (item.type === "commandExecution") {
    const commandStatus = typeof item.status === "string" ? item.status : "inProgress";
    const failed = commandStatus === "failed" || commandStatus === "declined";
    const exploration = readExplorationActions(item);
    if (exploration) {
      return {
        id,
        kind: "explore",
        createdAt,
        title: commandStatus === "inProgress" ? "Exploring workspace" : failed ? "Exploration failed" : "Explored workspace",
        command: typeof item.command === "string" ? item.command : undefined,
        body: boundedPersistedText(item.aggregatedOutput, MAX_PERSISTED_TOOL_OUTPUT),
        meta: typeof item.cwd === "string" ? item.cwd : "Workspace",
        status: commandStatus === "inProgress" ? "active" : failed ? "error" : "success",
        exploration,
      };
    }
    return {
      id,
      kind: "command",
      createdAt,
      title:
        commandStatus === "inProgress"
          ? "Xiao is running a command"
          : failed
            ? "Command did not complete"
            : "Command completed",
      command: typeof item.command === "string" ? item.command : "Running command",
      body: boundedPersistedText(item.aggregatedOutput, MAX_PERSISTED_TOOL_OUTPUT),
      meta: typeof item.cwd === "string" ? item.cwd : "Workspace",
      status: commandStatus === "inProgress" ? "active" : failed ? "error" : "success",
    };
  }

  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const files = item.changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const value = change as Record<string, unknown>;
      if (typeof value.path !== "string") return [];
      const patch = boundedPersistedText(value.diff, MAX_PERSISTED_PATCH);
      const stats = countDiffLines(patch ?? "");
      return [{ path: value.path, ...stats, patch }];
    });
    if (!files.length) return null;
    const failed = item.status === "failed" || item.status === "declined";
    return {
      id,
      kind: "change",
      createdAt,
      title: failed
        ? `Could not update ${files.length} ${files.length === 1 ? "file" : "files"}`
        : `Updated ${files.length} ${files.length === 1 ? "file" : "files"}`,
      meta: "Workspace changes",
      status: failed ? "error" : "success",
      files,
    };
  }

  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const failed = item.status === "failed";
    const error =
      typeof item.error === "string"
        ? item.error
        : item.error &&
            typeof item.error === "object" &&
            typeof (item.error as Record<string, unknown>).message === "string"
          ? String((item.error as Record<string, unknown>).message)
          : null;
    return {
      id,
      kind: "command",
      createdAt,
      title: `${server} · ${tool}`,
      body:
        error
          ? error
          : item.result == null
            ? undefined
            : JSON.stringify(item.result, null, 2).slice(0, 8_000),
      meta: "Plugin tool",
      status: failed ? "error" : item.status === "inProgress" ? "active" : "success",
    };
  }

  if (item.type === "webSearch") {
    return {
      id,
      kind: "result",
      createdAt,
      title: typeof item.query === "string" ? `Searched: ${item.query}` : "Web search",
      meta: "Browser tool",
      status: "success",
    };
  }

  if (item.type === "collabAgentToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "agent";
    const status = typeof item.status === "string" ? item.status : "inProgress";
    const labels: Record<string, string> = {
      spawnAgent: "Delegated an agent task",
      sendInput: "Sent context to an agent",
      resumeAgent: "Resumed an agent task",
      wait: "Waiting for agent results",
      closeAgent: "Closed an agent task",
    };
    return {
      id,
      kind: "command",
      createdAt,
      title: labels[tool] ?? "Agent collaboration",
      body: typeof item.prompt === "string" ? item.prompt : undefined,
      meta: typeof item.model === "string" ? `Subagent · ${item.model}` : "Subagent",
      status: status === "inProgress" ? "active" : status === "failed" ? "error" : "success",
    };
  }

  return null;
};

const reviewContextText = (attachment: AgentAttachment) => {
  const start = attachment.lineStart;
  const end = attachment.lineEnd ?? start;
  const lines = start ? `:${start}${end && end !== start ? `-${end}` : ""}` : "";
  return [
    `[Review comment on ${attachment.path}${lines}]`,
    attachment.preview,
    attachment.comment ? `Comment: ${attachment.comment}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
};

const historyFromTimeline = (timeline: TimelineEntry[]): XiaoHistoryItem[] =>
  timeline.flatMap<XiaoHistoryItem>((entry) => {
    if (entry.kind === "user" && entry.title.trim()) {
      const reviews = entry.attachments?.filter((attachment) => attachment.kind === "review") ?? [];
      return [{
        role: "user" as const,
        text: [entry.title, ...reviews.map(reviewContextText)].filter(Boolean).join("\n\n"),
      }];
    }
    if (entry.kind === "result" && entry.body?.trim()) {
      return [{ role: "assistant" as const, text: entry.body }];
    }
    return [];
  });

const userInput = (prompt: string, attachments: AgentAttachment[]) => [
  { type: "text", text: prompt, text_elements: [] },
  ...attachments.map((attachment) => {
    if (attachment.kind === "review") {
      return { type: "text", text: reviewContextText(attachment), text_elements: [] };
    }
    if (attachment.kind === "image" && attachment.url) {
      return { type: "image", url: attachment.url };
    }
    if (attachment.kind === "image") {
      return { type: "localImage", path: attachment.path };
    }
    return { type: "mention", name: attachment.name, path: attachment.path };
  }),
];

const sandboxPolicyForTurn = (mode: AgentSandboxMode, workspacePath: string) => {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly" };
  return {
    type: "workspaceWrite",
    writableRoots: [workspacePath],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
};

export const titleFromPrompt = (prompt: string) => {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 56) return singleLine;
  const shortened = singleLine.slice(0, 56).replace(/\s+\S*$/, "").trimEnd();
  return `${shortened || singleLine.slice(0, 56)}…`;
};

export function useAgentRuntime(
  workspacePath: string,
  activeTaskId: string,
  activeTaskTitle: string,
  activeTaskThreadId: string | null,
  activeTaskTimeline: TimelineEntry[],
  activeTaskModel: string | null,
  activeTaskReasoningEffort: string | null,
  activeTaskMode: AgentMode,
  activeTaskApprovalPolicy: AgentApprovalPolicy,
  activeTaskSandboxMode: AgentSandboxMode,
  activeTaskGoal: AgentGoal | null,
  onTimelineChange: (taskId: string, timeline: TimelineEntry[]) => void,
  onPlanChange: (taskId: string, plan: AgentPlan | null) => void,
  onTaskTitleChange: (taskId: string, title: string) => void,
  onTaskThreadChange: (taskId: string, threadId: string) => void,
  onTaskGoalChange: (taskId: string, goal: AgentGoal | null) => void,
  onTaskFinished: (taskId: string, outcome: AgentTurnOutcome) => void,
  onWorkspaceChange: () => void,
  autoConnect = true,
) {
  const [runtime, setRuntime] = useState<AgentRuntimeState>(initialRuntime);
  const [account, setAccount] = useState<AgentAccountSummary | null>(null);
  const [accountUsage, setAccountUsage] = useState<AgentAccountUsage | null>(null);
  const [rateLimits, setRateLimits] = useState<AgentRateLimits | null>(() => {
    try { return JSON.parse(window.localStorage.getItem(RATE_LIMIT_SNAPSHOT_KEY) ?? "null"); }
    catch { return null; }
  });
  const [models, setModels] = useState<AgentModelSummary[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [threadUsage, setThreadUsage] = useState<Record<string, ThreadTokenUsage>>({});
  const [questionRequest, setQuestionRequest] = useState<AgentQuestionRequest | null>(null);
  const [compactingTaskId, setCompactingTaskId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [listenersReady, setListenersReady] = useState(!isTauriHost());
  const { usage, recordUsage } = useCodexUsage();
  const activeTaskIdRef = useRef(activeTaskId);
  const sessionIds = useRef(new Map<string, string>());
  const sessionModels = useRef(new Map<string, string | null>());
  const sessionRequestedModels = useRef(new Map<string, string | null>());
  const syncedGoals = useRef(new Map<string, string>());
  const threadTasks = useRef(new Map<string, string>());
  const liveAgentEntries = useRef(new Map<string, string>());
  const activeThinkingEntries = useRef(new Map<string, string>());
  const reasoningEntries = useRef(new Map<string, string>());
  const reasoningChannels = useRef(new Map<string, "summary" | "content">());
  const autoTitledTasks = useRef(new Set<string>());
  const workingTaskId = useRef<string | null>(null);
  const activeTurnIds = useRef(new Map<string, string>());
  const activeTurnDiffs = useRef(new Map<string, string>());
  const pendingUserEntries = useRef(new Map<string, string>());
  const turnCheckpoints = useRef(new Map<string, { token: string; workspacePath: string }>());
  const taskApprovalPolicies = useRef(new Map<string, AgentApprovalPolicy>());
  const autoResolvingRequests = useRef(new Set<string>());
  const reconnectAttempt = useRef(0);
  const runtimeStopError = useRef<string | null>(null);
  const compactingTasks = useRef(new Set<string>());
  const undoingRef = useRef(false);
  const timelineCache = useRef(new Map<string, TimelineEntry[]>());
  const onTimelineChangeRef = useRef(onTimelineChange);
  const onPlanChangeRef = useRef(onPlanChange);
  const onTaskTitleChangeRef = useRef(onTaskTitleChange);
  const onTaskThreadChangeRef = useRef(onTaskThreadChange);
  const onTaskGoalChangeRef = useRef(onTaskGoalChange);
  const onTaskFinishedRef = useRef(onTaskFinished);
  const onWorkspaceChangeRef = useRef(onWorkspaceChange);

  useEffect(() => {
    onTimelineChangeRef.current = onTimelineChange;
  }, [onTimelineChange]);

  useEffect(() => {
    onPlanChangeRef.current = onPlanChange;
  }, [onPlanChange]);

  useEffect(() => {
    onTaskTitleChangeRef.current = onTaskTitleChange;
  }, [onTaskTitleChange]);

  useEffect(() => {
    onTaskThreadChangeRef.current = onTaskThreadChange;
  }, [onTaskThreadChange]);

  useEffect(() => {
    onTaskGoalChangeRef.current = onTaskGoalChange;
  }, [onTaskGoalChange]);

  useEffect(() => {
    onTaskFinishedRef.current = onTaskFinished;
  }, [onTaskFinished]);

  useEffect(() => {
    onWorkspaceChangeRef.current = onWorkspaceChange;
  }, [onWorkspaceChange]);

  useEffect(() => () => {
    const checkpoints = [...turnCheckpoints.current.values()];
    turnCheckpoints.current.clear();
    checkpoints.forEach((checkpoint) => {
      void nativeBridge.discardGitCheckpoint(checkpoint.token).catch(() => undefined);
    });
  }, []);

  const appendRuntimeLog = useCallback(
    (stream: RuntimeLogEntry["stream"], text: string) => {
      const cleanText = text.trimEnd();
      if (!cleanText) return;
      const entry: RuntimeLogEntry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        stream,
        text: cleanText.slice(0, 8_000),
      };
      setRuntimeLogs((current) => [...current, entry].slice(-MAX_RUNTIME_LOGS));
    },
    [],
  );

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
    timelineCache.current.set(activeTaskId, activeTaskTimeline);
    taskApprovalPolicies.current.set(activeTaskId, activeTaskApprovalPolicy);
    setRuntime((current) => ({
      ...current,
      threadId:
        current.phase === "working"
          ? current.threadId
          : sessionIds.current.get(activeTaskId) ?? null,
    }));
  }, [activeTaskApprovalPolicy, activeTaskId, activeTaskTimeline]);

  const updateTimeline = useCallback(
    (taskId: string, update: (current: TimelineEntry[]) => TimelineEntry[]) => {
      const current = timelineCache.current.get(taskId) ?? [];
      let next = update(current);
      const turnId = activeTurnIds.current.get(taskId);
      if (turnId) {
        const existingIds = new Set(current.map((entry) => entry.id));
        next = next.map((entry) =>
          existingIds.has(entry.id) || entry.turnId ? entry : { ...entry, turnId },
        );
      }
      timelineCache.current.set(taskId, next);
      onTimelineChangeRef.current(taskId, next);
    },
    [],
  );

  const settleThinking = useCallback(
    (taskId: string) => {
      const entryId = activeThinkingEntries.current.get(taskId);
      if (!entryId) return;
      activeThinkingEntries.current.delete(taskId);
      updateTimeline(taskId, (current) =>
        current.flatMap((entry) => {
          if (entry.id !== entryId) return [entry];
          if (!entry.body?.trim()) return [];
          return [{ ...entry, title: "Reasoning complete", meta: "Xiao", status: "success" }];
        }),
      );
    },
    [updateTimeline],
  );

  const declineWithoutPrompt = useCallback(
    async (
      taskId: string,
      requestId: number | string,
      approvalKind: TimelineEntry["approvalKind"] = "action",
      entryId?: string,
    ) => {
      const requestKey = String(requestId);
      if (autoResolvingRequests.current.has(requestKey)) return true;
      autoResolvingRequests.current.add(requestKey);
      if (entryId) {
        updateTimeline(taskId, (current) => current.map((entry) =>
          entry.id === entryId
            ? { ...entry, status: "active", meta: "Declining under Never ask" }
            : entry,
        ));
      }
      try {
        await nativeBridge.replyToAgent(
          requestId,
          approvalResponse(approvalKind, undefined, "decline"),
        );
        if (entryId) {
          updateTimeline(taskId, (current) => current.map((entry) =>
            entry.id === entryId
              ? { ...entry, status: "error", meta: "Declined by Never ask" }
              : entry,
          ));
        }
        return true;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (entryId) {
          updateTimeline(taskId, (current) => current.map((entry) =>
            entry.id === entryId
              ? { ...entry, status: "warning", meta: "Automatic decline failed - decide manually" }
              : entry,
          ));
        }
        setRuntime((current) => ({ ...current, error: message }));
        return false;
      } finally {
        autoResolvingRequests.current.delete(requestKey);
      }
    },
    [updateTimeline],
  );

  const refreshAccountUsage = useCallback(async () => {
    const [usageResult, limitsResult] = await Promise.allSettled([
      nativeBridge.readAgentUsage(),
      nativeBridge.agentRequest<Record<string, unknown>>("account/rateLimits/read", null),
    ]);
    setAccountUsage(usageResult.status === "fulfilled" ? usageResult.value : null);
    if (limitsResult.status !== "fulfilled") {
      return;
    }
    const snapshot = limitsResult.value.rateLimits;
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    const value = snapshot as Record<string, unknown>;
    const readWindow = (raw: unknown): AgentRateLimits["primary"] => {
      if (!raw || typeof raw !== "object") return null;
      const window = raw as Record<string, unknown>;
      if (typeof window.usedPercent !== "number") return null;
      return {
        usedPercent: window.usedPercent,
        windowDurationMins:
          typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
        resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
      };
    };
    const credits = value.credits;
    const balance = credits && typeof credits === "object"
      ? (credits as Record<string, unknown>).balance
      : null;
    const parsedBalance = typeof balance === "string" ? Number(balance) : null;
    const nextLimits: AgentRateLimits = {
      primary: readWindow(value.primary),
      secondary: readWindow(value.secondary),
      creditsRemaining: parsedBalance != null && Number.isFinite(parsedBalance) ? parsedBalance : null,
      updatedAt: Date.now(),
    };
    setRateLimits(nextLimits);
    try { window.localStorage.setItem(RATE_LIMIT_SNAPSHOT_KEY, JSON.stringify(nextLimits)); }
    catch { /* Live state remains available. */ }
  }, []);

  useEffect(() => {
    if (!isTauriHost() || (runtime.phase !== "ready" && runtime.phase !== "working")) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshAccountUsage();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshAccountUsage, runtime.phase]);

  const refreshRuntimeIdentity = useCallback(async () => {
    try {
      const [nextAccount, nextModels] = await Promise.all([
        nativeBridge.readAgentAccount(),
        nativeBridge.listAgentModels(),
      ]);
      setAccount(nextAccount);
      setModels(nextModels);
      void refreshAccountUsage();
      setRuntime((current) => ({
        ...current,
        error:
          !nextAccount.authenticated && nextAccount.requiresOpenaiAuth
            ? "Sign in with Codex CLI, then reconnect Xiao."
            : null,
      }));
    } catch (reason) {
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [refreshAccountUsage]);

  const resolveTaskId = useCallback((message: AgentMessage) => {
    const threadId = readMessageThreadId(message);
    if (threadId) {
      const taskId = threadTasks.current.get(threadId);
      if (taskId) return taskId;
    }
    return workingTaskId.current ?? activeTaskIdRef.current;
  }, []);

  const sendTurn = useCallback(async (
    threadId: string,
    prompt: string,
    attachments: AgentAttachment[],
    taskId: string,
    reasoningEffort: string | null,
    mode: AgentMode,
    model: string | null,
    approvalPolicy: AgentApprovalPolicy,
    sandboxMode: AgentSandboxMode,
    turnWorkspacePath: string,
  ) => {
    taskApprovalPolicies.current.set(taskId, approvalPolicy);
    const params: Record<string, unknown> = {
      threadId,
      input: userInput(prompt, attachments),
      effort: reasoningEffort,
      approvalPolicy,
      sandboxPolicy: sandboxPolicyForTurn(sandboxMode, turnWorkspacePath),
    };
    if (mode !== "plan") {
      params.additionalContext = {
        "xiao.plan-progress": {
          kind: "application",
          value: PLAN_PROGRESS_INSTRUCTIONS,
        },
      };
    }
    if (mode === "plan" && model) {
      params.collaborationMode = {
        mode: "plan",
        settings: {
          model,
          reasoning_effort: reasoningEffort,
          developer_instructions: null,
        },
      };
    }
    const staleCheckpoint = turnCheckpoints.current.get(taskId);
    if (staleCheckpoint) {
      turnCheckpoints.current.delete(taskId);
      void nativeBridge.discardGitCheckpoint(staleCheckpoint.token).catch(() => undefined);
    }
    try {
      const checkpoint = await nativeBridge.createGitCheckpoint(turnWorkspacePath);
      turnCheckpoints.current.set(taskId, { token: checkpoint, workspacePath: turnWorkspacePath });
    } catch (reason) {
      appendRuntimeLog(
        "stderr",
        `Undo checkpoint unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    workingTaskId.current = taskId;
    setRuntime((current) => ({
      ...current,
      phase: "working",
      taskId,
      threadId: activeTaskIdRef.current === taskId ? threadId : current.threadId,
      turnStartedAt: current.turnStartedAt ?? Date.now(),
      error: null,
    }));
    let response: TurnStartResponse;
    try {
      response = await nativeBridge.agentRequest<TurnStartResponse>("turn/start", params);
    } catch (reason) {
      const checkpoint = turnCheckpoints.current.get(taskId);
      turnCheckpoints.current.delete(taskId);
      if (checkpoint) void nativeBridge.discardGitCheckpoint(checkpoint.token).catch(() => undefined);
      throw reason;
    }
    const turnId = response.turn?.id;
    if (turnId) {
      activeTurnIds.current.set(taskId, turnId);
      const pendingEntryId = pendingUserEntries.current.get(taskId);
      if (pendingEntryId) {
        updateTimeline(taskId, (current) => current.map((entry) =>
          entry.id === pendingEntryId ? { ...entry, turnId } : entry,
        ));
      }
      setRuntime((current) => ({ ...current, turnId }));
    }
    return turnId ?? null;
  }, [appendRuntimeLog, updateTimeline]);

  const handleMessage = useCallback(
    async (message: AgentMessage) => {
      setRuntime((current) => ({ ...current, eventsSeen: current.eventsSeen + 1 }));

      const outputDelta =
        message.method === "item/commandExecution/outputDelta" &&
        typeof message.params?.delta === "string"
          ? message.params.delta
          : null;
      if (outputDelta) appendRuntimeLog("stdout", outputDelta);
      else if (message.method) appendRuntimeLog("event", message.method);
      else if (message.id != null) {
        appendRuntimeLog(message.error ? "stderr" : "event", `response ${String(message.id)}`);
      }

      if (message.method === "account/rateLimits/updated") {
        void refreshAccountUsage();
        return;
      }

      if (message.method === "serverRequest/resolved") {
        const requestId = message.params?.requestId;
        setQuestionRequest((current) =>
          current && requestId != null && String(current.requestId) === String(requestId)
            ? null
            : current,
        );
        return;
      }

      if (message.id === 0) {
        if (message.error) {
          const error = message.error.message || "Codex initialization failed.";
          reconnectAttempt.current += 1;
          runtimeStopError.current = error;
          setRuntime((current) => ({
            ...current,
            phase: "error",
            taskId: null,
            turnStartedAt: null,
            error,
          }));
          void nativeBridge.stopAgent().catch(() => {
            runtimeStopError.current = null;
          });
          return;
        }
        if (message.result) {
          reconnectAttempt.current = 0;
          setRuntime((current) => ({
            ...current,
            phase: "ready",
            taskId: null,
            turnStartedAt: null,
            error: null,
          }));
          void refreshRuntimeIdentity();
          return;
        }
      }

      const taskId = resolveTaskId(message);

      if (message.method === "item/tool/requestUserInput") {
        const request = readQuestionRequest(message, taskId);
        if (request) {
          setQuestionRequest(request);
        } else {
          setRuntime((current) => ({
            ...current,
            error: "Codex sent an invalid question request.",
          }));
        }
        return;
      }

      if (message.method === "mcpServer/elicitation/request" && message.id != null) {
        const serverName = typeof message.params?.serverName === "string"
          ? message.params.serverName
          : "MCP server";
        const requestMessage = typeof message.params?.message === "string"
          ? message.params.message
          : "The MCP server requested interactive input that Xiao cannot collect yet.";
        try {
          await nativeBridge.replyToAgent(message.id, mcpElicitationDeclineResponse());
          const entryId = `elicitation-${String(message.id)}`;
          updateTimeline(taskId, (current) =>
            current.some((entry) => entry.id === entryId)
              ? current
              : [
                  ...current,
                  {
                    id: entryId,
                    kind: "approval",
                    title: "MCP input request declined",
                    createdAt: Date.now(),
                    body: [
                      requestMessage,
                      "Interactive MCP elicitation is not available in Xiao yet, so this request was declined instead of leaving the turn blocked.",
                    ].join("\n\n"),
                    meta: serverName,
                    status: "error",
                  },
                ],
          );
        } catch (reason) {
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
        return;
      }

      if (message.method === "turn/started") {
        const turn = message.params?.turn;
        const turnId =
          turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
            ? String((turn as Record<string, unknown>).id)
            : null;
        const threadId = readMessageThreadId(message);
        if (turnId) {
          activeTurnIds.current.set(taskId, turnId);
          const pendingEntryId = pendingUserEntries.current.get(taskId);
          if (pendingEntryId) {
            updateTimeline(taskId, (current) => current.map((entry) =>
              entry.id === pendingEntryId ? { ...entry, turnId } : entry,
            ));
          }
        }
        setRuntime((current) => ({
          ...current,
          phase: "working",
          taskId,
          threadId: threadId ?? current.threadId,
          turnId,
        }));
      }

      if (
        message.method === "turn/diff/updated" &&
        typeof message.params?.turnId === "string" &&
        typeof message.params.diff === "string"
      ) {
        activeTurnDiffs.current.set(message.params.turnId, message.params.diff);
      }

      if (message.method === "thread/name/updated") {
        const threadId = readMessageThreadId(message);
        const threadName = message.params?.threadName;
        const namedTaskId = threadId ? threadTasks.current.get(threadId) : null;
        if (
          namedTaskId &&
          autoTitledTasks.current.has(namedTaskId) &&
          typeof threadName === "string" &&
          threadName.trim()
        ) {
          onTaskTitleChangeRef.current(namedTaskId, threadName.trim());
          autoTitledTasks.current.delete(namedTaskId);
        }
      }

      if (
        (message.method === "item/reasoning/summaryTextDelta" ||
          message.method === "item/reasoning/textDelta") &&
        typeof message.params?.delta === "string"
      ) {
        const itemId = readItemId(message);
        const channel = message.method === "item/reasoning/summaryTextDelta" ? "summary" : "content";
        const previousChannel = itemId ? reasoningChannels.current.get(itemId) : undefined;
        if (previousChannel === "summary" && channel === "content") return;
        const replaceContent = previousChannel === "content" && channel === "summary";
        if (itemId) reasoningChannels.current.set(itemId, channel);
        let entryId = itemId ? reasoningEntries.current.get(itemId) : undefined;
        if (!entryId) {
          entryId = itemId ?? activeThinkingEntries.current.get(taskId) ?? crypto.randomUUID();
          activeThinkingEntries.current.set(taskId, entryId);
          if (itemId) reasoningEntries.current.set(itemId, entryId);
        }
        const delta = message.params.delta;
        updateTimeline(taskId, (current) => {
          if (!current.some((entry) => entry.id === entryId)) {
            return [
              ...current,
              {
                 id: entryId,
                 kind: "thought",
                 title: "Thinking",
                 createdAt: Date.now(),
                 body: delta,
                meta: "Live reasoning",
                status: "active",
              },
            ];
          }
          return current.map((entry) =>
            entry.id === entryId
              ? {
                  ...entry,
                  title: "Thinking",
                  body: replaceContent ? delta : `${entry.body ?? ""}${delta}`,
                  meta: "Live reasoning",
                  status: "active",
                }
              : entry,
          );
        });
        return;
      }

      if (
        message.method === "item/commandExecution/outputDelta" &&
        typeof message.params?.delta === "string"
      ) {
        const itemId = readItemId(message);
        if (itemId) {
          const delta = message.params.delta;
          updateTimeline(taskId, (current) =>
            current.map((entry) =>
              entry.id === itemId
                ? { ...entry, body: `${entry.body ?? ""}${delta}`.slice(-8_000) }
                : entry,
            ),
          );
        }
        return;
      }

      if (message.method === "thread/tokenUsage/updated") {
        const threadId = readMessageThreadId(message);
        const tokenUsage = message.params?.tokenUsage;
        const tokenUsageValue =
          tokenUsage && typeof tokenUsage === "object"
            ? tokenUsage as Record<string, unknown>
            : null;
        const total =
          tokenUsageValue ? readTokenUsage(tokenUsageValue.total) : null;
        const last =
          tokenUsageValue ? readTokenUsage(tokenUsageValue.last) : null;
        const rawContextWindow = tokenUsageValue?.modelContextWindow;
        const modelContextWindow =
          typeof rawContextWindow === "number" && Number.isFinite(rawContextWindow) && rawContextWindow > 0
            ? rawContextWindow
            : null;
        if (threadId && total) {
          recordUsage(threadId, total);
          setThreadUsage((current) => ({
            ...current,
            [threadId]: {
              total,
              last: last ?? current[threadId]?.last ?? total,
              modelContextWindow: modelContextWindow ?? current[threadId]?.modelContextWindow ?? null,
            },
          }));
        }
      }

      if (message.method === "turn/plan/updated" && Array.isArray(message.params?.plan)) {
        const steps = message.params.plan.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          if (
            typeof value.step !== "string" ||
            !["pending", "inProgress", "completed"].includes(String(value.status))
          ) {
            return [];
          }
          return [{
            step: value.step,
            status: value.status as "pending" | "inProgress" | "completed",
          }];
        });
        onPlanChangeRef.current(taskId, {
          explanation:
            typeof message.params.explanation === "string"
              ? message.params.explanation
              : null,
          steps,
        });
      }

      if (message.method === "item/agentMessage/delta") {
        const delta = message.params?.delta;
        if (typeof delta !== "string") return;
        settleThinking(taskId);
        const liveEntryId = liveAgentEntries.current.get(taskId);
        if (!liveEntryId) {
          const itemId = message.params?.itemId;
          const id = typeof itemId === "string" ? itemId : crypto.randomUUID();
          liveAgentEntries.current.set(taskId, id);
          updateTimeline(taskId, (current) => [
            ...current,
            {
               id,
               kind: "result",
               title: "Agent response",
               createdAt: Date.now(),
               body: delta,
              meta: "Streaming",
              status: "active",
            },
          ]);
          return;
        }

        updateTimeline(taskId, (current) =>
          current.map((entry) =>
            entry.id === liveEntryId
              ? { ...entry, body: `${entry.body ?? ""}${delta}` }
              : entry,
          ),
        );
      }

      if (message.method === "item/started") {
        const item = readItem(message);
        if (!item) return;
        if (item.type === "contextCompaction") {
          const entry = contextCompactionTimelineEntry(item, "started");
          if (entry) {
            updateTimeline(taskId, (current) =>
              current.some((currentEntry) => currentEntry.id === entry.id)
                ? current.map((currentEntry) => currentEntry.id === entry.id ? entry : currentEntry)
                : [...current, entry],
            );
          }
          return;
        }
        if (item.type === "reasoning") {
          const itemId = typeof item.id === "string" ? item.id : crypto.randomUUID();
          const entryId = reasoningEntries.current.get(itemId) ?? itemId;
          activeThinkingEntries.current.set(taskId, entryId);
          reasoningEntries.current.set(itemId, entryId);
          updateTimeline(taskId, (current) =>
            current.some((entry) => entry.id === entryId)
              ? current.map((entry) =>
                  entry.id === entryId
                    ? { ...entry, title: "Thinking", meta: "Live reasoning", status: "active" }
                    : entry,
                )
              : [
                  ...current,
                  {
                     id: entryId,
                     kind: "thought",
                     title: "Thinking",
                     createdAt: Date.now(),
                     meta: "Live reasoning",
                    status: "active",
                  },
                ],
          );
          return;
        }
        if (item.type === "commandExecution" || item.type === "collabAgentToolCall") {
          settleThinking(taskId);
          const entry = timelineEntryFromItem(item);
          if (entry) updateTimeline(taskId, (current) => [...current, entry]);
        }
      }

      if (message.method === "item/completed") {
        const item = readItem(message);
        if (!item || item.type === "userMessage") return;
        const entry = timelineEntryFromItem(item);
        if (!entry) return;

        if (item.type === "reasoning" && !entry.body?.trim()) {
          if (typeof item.id === "string") {
            reasoningEntries.current.delete(item.id);
            reasoningChannels.current.delete(item.id);
          }
          settleThinking(taskId);
          return;
        }

        const reasoningEntryId =
          item.type === "reasoning" && typeof item.id === "string"
            ? reasoningEntries.current.get(item.id)
            : null;
        const liveEntryId =
          item.type === "agentMessage" ? liveAgentEntries.current.get(taskId) : null;
        const completedEntry = reasoningEntryId
          ? { ...entry, id: reasoningEntryId }
          : liveEntryId
            ? { ...entry, id: liveEntryId }
            : entry;
        if (item.type === "agentMessage") liveAgentEntries.current.delete(taskId);
        if (item.type === "reasoning") {
          if (typeof item.id === "string") {
            reasoningEntries.current.delete(item.id);
            reasoningChannels.current.delete(item.id);
          }
          activeThinkingEntries.current.delete(taskId);
        }
        if (item.type === "fileChange") onWorkspaceChangeRef.current();
        updateTimeline(taskId, (current) =>
          current.some((currentEntry) => currentEntry.id === completedEntry.id)
            ? current.map((currentEntry) =>
                currentEntry.id === completedEntry.id
                  ? { ...completedEntry, body: completedEntry.body ?? currentEntry.body }
                  : currentEntry,
              )
            : [...current, completedEntry],
        );
      }

      if (
        (message.method === "item/commandExecution/requestApproval" ||
          message.method === "item/fileChange/requestApproval" ||
          message.method === "item/permissions/requestApproval") &&
        message.id != null
      ) {
        const fileApproval = message.method === "item/fileChange/requestApproval";
        const permissionApproval = message.method === "item/permissions/requestApproval";
        const approvalKind = permissionApproval ? "permissions" : "action";
        const requestedPermissions = permissionApproval
          ? permissionGrantFromRequest(message.params?.permissions)
          : undefined;
        const approvalEntry: TimelineEntry = {
          id: `approval-${String(message.id)}`,
          kind: "approval",
          title: permissionApproval
            ? "Additional permissions requested"
            : fileApproval
              ? "File change permission requested"
              : "Command permission requested",
          createdAt: Date.now(),
          body:
            typeof message.params?.reason === "string"
              ? message.params.reason
              : permissionApproval
                ? "Codex requested additional network or filesystem access for this turn."
                : "Xiao wants to run an action outside the current permission boundary.",
          command:
            typeof message.params?.command === "string"
              ? message.params.command
              : undefined,
          requestId: message.id,
          approvalKind,
          approvalPermissions: requestedPermissions,
          turnId: typeof message.params?.turnId === "string" ? message.params.turnId : undefined,
          meta: "Waiting for your decision",
          status: "warning",
        };
        if (taskApprovalPolicies.current.get(taskId) === "never") {
          void declineWithoutPrompt(taskId, message.id, approvalKind).then((declined) => {
            if (declined) return;
            updateTimeline(taskId, (current) =>
              current.some((entry) => entry.id === approvalEntry.id)
                ? current
                : [...current, { ...approvalEntry, meta: "Automatic decline failed - decide manually" }],
            );
          });
        } else {
          updateTimeline(taskId, (current) => [...current, approvalEntry]);
        }
      }

      if (message.method === "turn/completed") {
        const value = message.params?.turn;
        const turn = value && typeof value === "object" ? value as Record<string, unknown> : null;
        const status = turn?.status;
        const hasFinalStatus = status === "completed" || status === "failed" || status === "interrupted";
        const outcome: AgentTurnOutcome = hasFinalStatus ? status : "failed";
        const manualCompaction = compactingTasks.current.delete(taskId);
        if (manualCompaction) {
          setCompactingTaskId((current) => current === taskId ? null : current);
        } else {
          onPlanChangeRef.current(taskId, null);
        }
        const errorValue = turn?.error;
        const errorMessage = outcome === "failed"
          ? errorValue &&
              typeof errorValue === "object" &&
              typeof (errorValue as Record<string, unknown>).message === "string"
            ? String((errorValue as Record<string, unknown>).message)
            : hasFinalStatus
              ? "Agent turn failed."
              : "Agent turn ended without a valid final status."
          : null;
        const completedTurnId = typeof turn?.id === "string"
          ? turn.id
          : activeTurnIds.current.get(taskId) ?? null;
        const protocolTurnDiff = completedTurnId
          ? activeTurnDiffs.current.get(completedTurnId)
          : undefined;
        const checkpoint = turnCheckpoints.current.get(taskId);
        turnCheckpoints.current.delete(taskId);
        let checkpointTurnDiff: string | undefined;
        if (checkpoint) {
          try {
            checkpointTurnDiff = await nativeBridge.finishGitCheckpoint(
              checkpoint.workspacePath,
              checkpoint.token,
            );
          } catch (reason) {
            appendRuntimeLog(
              "stderr",
              `Could not finalize undo checkpoint: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          }
        }
        const completedTurnDiff = checkpointTurnDiff ?? protocolTurnDiff;
        const pendingEntryId = pendingUserEntries.current.get(taskId);
        settleThinking(taskId);
        liveAgentEntries.current.delete(taskId);
        if (workingTaskId.current === taskId) workingTaskId.current = null;
        setQuestionRequest((current) => current?.taskId === taskId ? null : current);
        setRuntime((current) => ({
          ...current,
          phase: "ready",
          taskId: null,
          threadId: sessionIds.current.get(activeTaskIdRef.current) ?? null,
          turnId: null,
          turnStartedAt: null,
          error: errorMessage,
        }));
        if (!manualCompaction) onTaskFinishedRef.current(taskId, outcome);
        void refreshAccountUsage();
        updateTimeline(taskId, (current) => {
          const settledStatus: TimelineEntry["status"] =
            outcome === "completed" ? "success" : outcome === "failed" ? "error" : "warning";
          const settled = current.map((entry) => {
            const settledEntry = entry.status === "active"
              ? { ...entry, status: settledStatus }
              : entry;
            if (
              completedTurnId &&
              settledEntry.kind === "user" &&
              (settledEntry.turnId === completedTurnId || settledEntry.id === pendingEntryId)
            ) {
              return { ...settledEntry, turnId: completedTurnId, turnDiff: completedTurnDiff };
            }
            return settledEntry;
          });
          if (!errorMessage) return settled;
          const errorTurnId = completedTurnId ?? crypto.randomUUID();
          const errorId = `turn-error-${errorTurnId}`;
          if (settled.some((entry) => entry.id === errorId)) return settled;
          return [
            ...settled,
            {
              id: errorId,
              kind: "result",
              title: "Turn failed",
              createdAt: Date.now(),
              body: errorMessage,
              meta: "Xiao",
              status: "error",
              turnId: completedTurnId ?? undefined,
            },
          ];
        });
        pendingUserEntries.current.delete(taskId);
        activeTurnIds.current.delete(taskId);
        if (completedTurnId) activeTurnDiffs.current.delete(completedTurnId);
      }
    },
    [
      appendRuntimeLog,
      declineWithoutPrompt,
      recordUsage,
      refreshAccountUsage,
      refreshRuntimeIdentity,
      resolveTaskId,
      settleThinking,
      updateTimeline,
    ],
  );

  useEffect(() => {
    if (!isTauriHost()) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const addCleanup = (cleanup: () => void) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };

    const attachListeners = async () => {
      try {
        addCleanup(
          await listen<AgentMessage>("agent://message", (event) => {
            if (!disposed) void handleMessage(event.payload);
          }),
        );
        addCleanup(
          await listen<string>("agent://stderr", (event) => {
            if (!disposed && event.payload.trim()) {
              appendRuntimeLog("stderr", event.payload);
            }
          }),
        );
        addCleanup(
           await listen("agent://stopped", () => {
             if (!disposed) {
               const stopError = runtimeStopError.current;
               runtimeStopError.current = null;
               if (!stopError) reconnectAttempt.current += 1;
                sessionIds.current.clear();
               sessionModels.current.clear();
               sessionRequestedModels.current.clear();
              threadTasks.current.clear();
              liveAgentEntries.current.clear();
              activeThinkingEntries.current.clear();
               reasoningEntries.current.clear();
               reasoningChannels.current.clear();
               compactingTasks.current.clear();
               workingTaskId.current = null;
               appendRuntimeLog("system", "Agent runtime stopped.");
              setAccount(null);
               setAccountUsage(null);
               setRateLimits(null);
               setModels([]);
                setThreadUsage({});
                setQuestionRequest(null);
               setCompactingTaskId(null);
               setRuntime(stopError ? { ...initialRuntime, phase: "error", error: stopError } : initialRuntime);
             }
          }),
        );
        if (!disposed) setListenersReady(true);
      } catch (reason) {
        cleanups.splice(0).forEach((cleanup) => cleanup());
        if (!disposed) {
          setRuntime((current) => ({
            ...current,
            phase: "error",
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      setListenersReady(false);
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [appendRuntimeLog, handleMessage]);

  const connect = useCallback(async () => {
    if (!isTauriHost()) {
      setRuntime((current) => ({
        ...current,
        phase: "error",
        error: "Run npm run tauri dev to connect the native agent runtime.",
      }));
      return;
    }

    setRuntime((current) => ({ ...current, phase: "starting", error: null }));
    appendRuntimeLog("system", "Starting Codex app-server.");
    try {
      const result = await nativeBridge.startAgent();
      appendRuntimeLog("system", `Codex ${result.version} connected.`);
      if (result.alreadyRunning) {
        reconnectAttempt.current = 0;
        setRuntime((current) => ({ ...current, phase: "ready", error: null }));
        await refreshRuntimeIdentity();
      }
    } catch (reason) {
      reconnectAttempt.current += 1;
      setRuntime((current) => ({
        ...current,
        phase: "error",
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [appendRuntimeLog, refreshRuntimeIdentity]);

  useEffect(() => {
    if (
      !isTauriHost() ||
      !autoConnect ||
      !listenersReady ||
      (runtime.phase !== "offline" && runtime.phase !== "error")
    ) {
      return;
    }
    const delay =
      runtime.phase === "offline" && reconnectAttempt.current === 0
        ? 0
        : Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt.current, 5));
    const timer = window.setTimeout(() => void connect(), delay);
    return () => window.clearTimeout(timer);
  }, [autoConnect, connect, listenersReady, runtime.phase]);

  const submit = useCallback(
    async (prompt: string, attachments: AgentAttachment[]) => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt) return false;
      if (
        runtime.phase === "working" &&
        workingTaskId.current === activeTaskId &&
        runtime.threadId &&
        runtime.turnId
      ) {
        const userEntryId = crypto.randomUUID();
        updateTimeline(activeTaskId, (current) => [
          ...current,
          {
            id: userEntryId,
            kind: "user",
            title: cleanPrompt,
            createdAt: Date.now(),
            attachments: attachments.length ? attachments : undefined,
            meta: "Steered",
            status: "active",
            turnId: runtime.turnId ?? undefined,
          },
        ]);
        try {
          await nativeBridge.agentRequest("turn/steer", {
            threadId: runtime.threadId,
            expectedTurnId: runtime.turnId,
            input: userInput(cleanPrompt, attachments),
          });
          updateTimeline(activeTaskId, (current) =>
            current.map((entry) =>
              entry.id === userEntryId ? { ...entry, status: "success" } : entry,
            ),
          );
          return true;
        } catch (reason) {
          updateTimeline(activeTaskId, (current) =>
            current.filter((entry) => entry.id !== userEntryId),
          );
          setRuntime((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
          return false;
        }
      }
      if (runtime.phase !== "ready") {
        setRuntime((current) => ({
          ...current,
          error: "Connect Xiao before starting a task.",
        }));
        return false;
      }

      const currentTimeline = timelineCache.current.get(activeTaskId) ?? activeTaskTimeline;
      const userEntryId = crypto.randomUUID();
      updateTimeline(activeTaskId, (current) => [
        ...current,
        {
          id: userEntryId,
          kind: "user",
          title: cleanPrompt,
          createdAt: Date.now(),
          attachments: attachments.length ? attachments : undefined,
          meta: "You",
          status: "active",
        },
      ]);
      pendingUserEntries.current.set(activeTaskId, userEntryId);
      workingTaskId.current = activeTaskId;
      setRuntime((current) => ({
        ...current,
        phase: "working",
        taskId: activeTaskId,
        turnStartedAt: Date.now(),
        error: null,
      }));
      let threadId = sessionIds.current.get(activeTaskId) ?? activeTaskThreadId ?? undefined;

      try {
        const needsSession = needsAgentSession(
          threadId,
          sessionRequestedModels.current.has(activeTaskId),
          sessionRequestedModels.current.get(activeTaskId),
          activeTaskModel,
        );
        if (needsSession) {
          const session = await nativeBridge.startXiaoSession(
            workspacePath,
            activeTaskModel,
            historyFromTimeline(currentTimeline),
            threadId ?? null,
            activeTaskApprovalPolicy,
            activeTaskSandboxMode,
          );
          threadId = session.threadId;
          sessionIds.current.set(activeTaskId, threadId);
          sessionModels.current.set(activeTaskId, session.model);
          sessionRequestedModels.current.set(activeTaskId, activeTaskModel);
          threadTasks.current.set(threadId, activeTaskId);
          onTaskThreadChangeRef.current(activeTaskId, threadId);
        }
        if (!threadId) throw new Error("Codex did not return a thread id.");
        if (
          activeTaskGoal &&
          syncedGoals.current.get(activeTaskId) !== `${activeTaskGoal.status}:${activeTaskGoal.objective}`
        ) {
          await nativeBridge.agentRequest("thread/goal/set", {
            threadId,
            objective: activeTaskGoal.objective,
            status: activeTaskGoal.status,
          });
          syncedGoals.current.set(
            activeTaskId,
            `${activeTaskGoal.status}:${activeTaskGoal.objective}`,
          );
        }
        const turnId = await sendTurn(
          threadId,
          cleanPrompt,
          attachments,
          activeTaskId,
          activeTaskReasoningEffort,
          activeTaskMode,
          sessionModels.current.get(activeTaskId) ?? activeTaskModel,
          activeTaskApprovalPolicy,
          activeTaskSandboxMode,
          workspacePath,
        );
        if (activeTaskTitle === "New task") {
          autoTitledTasks.current.add(activeTaskId);
          onTaskTitleChangeRef.current(activeTaskId, titleFromPrompt(cleanPrompt));
        }
        updateTimeline(activeTaskId, (current) =>
          current.map((entry) =>
            entry.id === userEntryId
              ? { ...entry, status: "success", turnId: turnId ?? entry.turnId }
              : entry,
          ),
        );
        return true;
      } catch (reason) {
        pendingUserEntries.current.delete(activeTaskId);
        const failedTurnId = activeTurnIds.current.get(activeTaskId);
        activeTurnIds.current.delete(activeTaskId);
        if (failedTurnId) activeTurnDiffs.current.delete(failedTurnId);
        updateTimeline(activeTaskId, (current) =>
          current.filter((entry) => entry.id !== userEntryId),
        );
        workingTaskId.current = null;
        setRuntime((current) => ({
          ...current,
          phase: "ready",
          taskId: null,
          turnId: null,
          turnStartedAt: null,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [
      activeTaskId,
      activeTaskApprovalPolicy,
      activeTaskGoal,
      activeTaskMode,
      activeTaskModel,
      activeTaskReasoningEffort,
      activeTaskSandboxMode,
      activeTaskTitle,
      activeTaskThreadId,
      activeTaskTimeline,
      runtime.phase,
      sendTurn,
      updateTimeline,
      workspacePath,
    ],
  );

  const compact = useCallback(async () => {
    const threadId = sessionIds.current.get(activeTaskId);
    if (runtime.phase !== "ready" || !threadId || compactingTasks.current.size > 0) {
      return false;
    }

    compactingTasks.current.add(activeTaskId);
    setCompactingTaskId(activeTaskId);
    workingTaskId.current = activeTaskId;
    setRuntime((current) => ({
      ...current,
      phase: "working",
      taskId: activeTaskId,
      threadId,
      turnId: null,
      turnStartedAt: Date.now(),
      error: null,
    }));

    const request = threadCompactRequest(threadId);
    try {
      await nativeBridge.agentRequest(request.method, request.params);
      return true;
    } catch (reason) {
      compactingTasks.current.delete(activeTaskId);
      setCompactingTaskId((current) => current === activeTaskId ? null : current);
      if (workingTaskId.current === activeTaskId) workingTaskId.current = null;
      const failure = reason instanceof Error ? reason.message : String(reason);
      setRuntime((current) => ({
        ...current,
        phase: current.taskId === activeTaskId ? "ready" : current.phase,
        taskId: current.taskId === activeTaskId ? null : current.taskId,
        turnId: current.taskId === activeTaskId ? null : current.turnId,
        turnStartedAt: current.taskId === activeTaskId ? null : current.turnStartedAt,
        error: `Could not compact context: ${failure}`,
      }));
      return false;
    }
  }, [activeTaskId, runtime.phase]);

  const interrupt = useCallback(async () => {
    if (runtime.taskId !== activeTaskId || !runtime.threadId || !runtime.turnId) return;
    try {
      await nativeBridge.agentRequest("turn/interrupt", {
        threadId: runtime.threadId,
        turnId: runtime.turnId,
      });
    } catch (reason) {
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [activeTaskId, runtime.taskId, runtime.threadId, runtime.turnId]);

  const setApprovalPolicy = useCallback(
    async (approvalPolicy: AgentApprovalPolicy) => {
      taskApprovalPolicies.current.set(activeTaskId, approvalPolicy);
      if (approvalPolicy === "never") {
        const activeTurnId = activeTurnIds.current.get(activeTaskId);
        const pendingApprovals = (timelineCache.current.get(activeTaskId) ?? [])
          .filter((entry) =>
            entry.kind === "approval" &&
            entry.status === "warning" &&
            entry.requestId != null &&
            activeTurnId != null &&
            entry.turnId === activeTurnId,
          );
        pendingApprovals.forEach((entry) => {
          void declineWithoutPrompt(activeTaskId, entry.requestId!, entry.approvalKind, entry.id);
        });
      }

      const threadId = sessionIds.current.get(activeTaskId);
      if (!threadId) return true;
      try {
        await nativeBridge.agentRequest("thread/settings/update", {
          threadId,
          approvalPolicy,
        });
        setRuntime((current) => ({ ...current, error: null }));
        return true;
      } catch (reason) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [activeTaskId, declineWithoutPrompt],
  );

  const undoLastTurn = useCallback(async (): Promise<AgentUndoResult | null> => {
    const timeline = timelineCache.current.get(activeTaskId) ?? activeTaskTimeline;
    const target = [...timeline].reverse().find(
      (entry) => entry.kind === "user" && entry.turnId && entry.turnDiff?.trim(),
    );
    const threadId = sessionIds.current.get(activeTaskId);
    if (undoingRef.current || runtime.phase !== "ready" || !target?.turnId || !threadId) {
      return null;
    }

    const turnEntries = timeline.filter((entry) => entry.turnId === target.turnId);
    const prompt = turnEntries
      .filter((entry) => entry.kind === "user")
      .map((entry) => entry.title.trim())
      .filter(Boolean)
      .join("\n\n");
    const attachments = [...new Map(
      turnEntries
        .flatMap((entry) => entry.attachments ?? [])
        .map((attachment) => [`${attachment.kind}:${attachment.path}`, attachment] as const),
    ).values()];
    const patch = target.turnDiff ?? "";
    let patchReverted = false;
    let stage: "check" | "files" | "history" = "check";

    undoingRef.current = true;
    setUndoing(true);
    setRuntime((current) => ({ ...current, error: null }));
    try {
      if (patch.trim()) {
        await nativeBridge.applyGitPatch(workspacePath, patch, true, true);
        stage = "files";
        await nativeBridge.applyGitPatch(workspacePath, patch, true, false);
        patchReverted = true;
      }

      stage = "history";
      await nativeBridge.agentRequest("thread/rollback", { threadId, numTurns: 1 });

      const firstTurnIndex = timeline.findIndex((entry) => entry.turnId === target.turnId);
      const remaining = firstTurnIndex < 0
        ? timeline.filter((entry) => entry.turnId !== target.turnId)
        : timeline.slice(0, firstTurnIndex);
      updateTimeline(activeTaskId, () => remaining);
      onPlanChangeRef.current(activeTaskId, null);
      if (!remaining.some((entry) => entry.kind === "user")) {
        autoTitledTasks.current.delete(activeTaskId);
        onTaskTitleChangeRef.current(activeTaskId, "New task");
      }
      onWorkspaceChangeRef.current();
      setRuntime((current) => ({ ...current, error: null }));
      return { prompt, attachments };
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : String(reason);
      let message = stage === "check"
        ? `Cannot undo safely because the workspace changed after this turn: ${failure}`
        : stage === "files"
          ? `Could not revert the turn's file changes: ${failure}`
          : `Could not rollback the Codex turn: ${failure}`;

      if (patchReverted) {
        try {
          await nativeBridge.applyGitPatch(workspacePath, patch, false, true);
          await nativeBridge.applyGitPatch(workspacePath, patch, false, false);
          message += " Xiao restored the workspace changes.";
        } catch (restoreReason) {
          const restoreFailure = restoreReason instanceof Error
            ? restoreReason.message
            : String(restoreReason);
          message += ` The history was not rolled back, and the workspace patch could not be restored: ${restoreFailure}`;
        }
        onWorkspaceChangeRef.current();
      }
      setRuntime((current) => ({ ...current, error: message }));
      return null;
    } finally {
      undoingRef.current = false;
      setUndoing(false);
    }
  }, [
    activeTaskId,
    activeTaskTimeline,
    runtime.phase,
    updateTimeline,
    workspacePath,
  ]);

  const setGoal = useCallback(
    async (objective: string, status: AgentGoal["status"] = "active") => {
      const cleanObjective = objective.trim();
      if (!cleanObjective) return false;
      const goal = { objective: cleanObjective, status } satisfies AgentGoal;
      const threadId = sessionIds.current.get(activeTaskId);
      if (!threadId) {
        onTaskGoalChangeRef.current(activeTaskId, goal);
        return true;
      }
      try {
        await nativeBridge.agentRequest("thread/goal/set", {
          threadId,
          objective: cleanObjective,
          status,
        });
        syncedGoals.current.set(activeTaskId, `${status}:${cleanObjective}`);
        onTaskGoalChangeRef.current(activeTaskId, goal);
        return true;
      } catch (reason) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [activeTaskId],
  );

  const clearGoal = useCallback(async () => {
    const threadId = sessionIds.current.get(activeTaskId);
    if (!threadId) {
      onTaskGoalChangeRef.current(activeTaskId, null);
      syncedGoals.current.delete(activeTaskId);
      return true;
    }
    try {
      await nativeBridge.agentRequest("thread/goal/clear", { threadId });
      onTaskGoalChangeRef.current(activeTaskId, null);
      syncedGoals.current.delete(activeTaskId);
      return true;
    } catch (reason) {
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
      return false;
    }
  }, [activeTaskId]);

  const resolveApproval = useCallback(
    async (
      taskId: string,
      entryId: string,
      requestId: number | string,
      decision: "accept" | "decline",
    ) => {
      updateTimeline(taskId, (current) =>
        current.map((entry) =>
          entry.id === entryId
            ? {
                ...entry,
                status: "active",
                meta: "Submitting decision",
              }
            : entry,
        ),
      );
      try {
        const approval = (timelineCache.current.get(taskId) ?? []).find(
          (entry) => entry.id === entryId,
        );
        await nativeBridge.replyToAgent(
          requestId,
          approvalResponse(approval?.approvalKind, approval?.approvalPermissions, decision),
        );
        updateTimeline(taskId, (current) =>
          current.map((entry) =>
            entry.id === entryId
              ? {
                  ...entry,
                  status: decision === "accept" ? "success" : "error",
                  meta: decision === "accept" ? "Approved" : "Declined",
                }
              : entry,
          ),
        );
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        updateTimeline(taskId, (current) =>
          current.map((entry) =>
            entry.id === entryId
              ? { ...entry, status: "warning", meta: "Decision failed - try again" }
              : entry,
          ),
        );
        setRuntime((current) => ({ ...current, error: message }));
      }
    },
    [updateTimeline],
  );

  const resolveQuestion = useCallback(
    async (requestId: number | string, answers: Record<string, string[]>) => {
      try {
        await nativeBridge.replyToAgent(requestId, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([questionId, values]) => [
              questionId,
              { answers: values },
            ]),
          ),
        });
        setQuestionRequest((current) =>
          current && String(current.requestId) === String(requestId) ? null : current,
        );
        setRuntime((current) => ({ ...current, error: null }));
        return true;
      } catch (reason) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [],
  );

  const activeThreadId = sessionIds.current.get(activeTaskId) ?? activeTaskThreadId ?? null;
  const compacting = compactingTaskId === activeTaskId;
  const canCompact = runtime.phase === "ready" && Boolean(activeThreadId) && compactingTaskId === null;
  const canUndo = runtime.phase === "ready" && Boolean(
    activeThreadId &&
    [...activeTaskTimeline].reverse().some(
      (entry) => entry.kind === "user" && entry.turnId && entry.turnDiff?.trim(),
    ),
  );

  return {
    runtime,
    account,
    accountUsage,
    rateLimits,
    models,
    timeline: activeTaskTimeline,
    runtimeLogs,
    questionRequest,
    contextUsage: activeThreadId ? threadUsage[activeThreadId] ?? null : null,
    hasThread: Boolean(activeThreadId),
    canCompact,
    compacting,
    canUndo,
    undoing,
    usage,
    connect,
    submit,
    compact,
    interrupt,
    setApprovalPolicy,
    undoLastTurn,
    setGoal,
    clearGoal,
    resolveQuestion,
    resolveApproval,
  };
}
