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
  AgentModelSummary,
  AgentPlan,
  AgentQuestionRequest,
  AgentRuntimeState,
  AgentTurnOutcome,
  AgentUndoResult,
  RuntimeLogEntry,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TimelineEntry,
  XiaoHistoryItem,
} from "../../../core/models/agent";
import type {
  PendingInputSnapshot,
  RunEventRecord,
  RunProtocolEnvelope,
  RunStatus,
  RunUpdateEnvelope,
} from "../../../core/models/run";
import { useCodexUsage } from "../../profile/hooks/useCodexUsage";
import {
  approvalResponse,
  contextCompactionTimelineEntry,
  invalidateUndoHistory,
  latestUndoableTurn,
  permissionGrantFromRequest,
  reconcilePendingApprovalEntries,
  reviewContextText,
  serviceTierForFastMode,
  threadCompactRequest,
  userInput,
} from "./agentProtocol";
import {
  acceptRunProtocol,
  activePendingInputIdsForRestore,
  activeRunForTask,
  emptyRunProjection,
  latestRunForTask,
  mergeListedRunSnapshots,
  projectRunSnapshots,
  projectRunUpdate,
  runStatusIsActive,
  shouldRestorePendingInput,
  type RunProjection,
} from "./runProjection";

const MAX_RUNTIME_LOGS = 240;
type RuntimeMessageEnvelope = {
  environmentId: string;
  generation: number;
  message: AgentMessage;
};
type RuntimeDiagnosticEnvelope = {
  environmentId: string;
  generation: number;
  message: string;
};
type RuntimeStoppedEnvelope = { environmentId: string; generation: number };

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
  pendingInputId: string,
  runId: string,
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
    pendingInputId,
    runId,
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

const messageFromPendingInput = (pending: PendingInputSnapshot): AgentMessage => {
  let requestId: number | string = pending.requestId;
  try {
    const parsed = JSON.parse(pending.requestId) as unknown;
    if (typeof parsed === "number" || typeof parsed === "string") requestId = parsed;
  } catch {
    // Keep the canonical string when an older row is not JSON encoded.
  }
  const method = pending.kind === "command_approval"
    ? "item/commandExecution/requestApproval"
    : pending.kind === "file_approval"
      ? "item/fileChange/requestApproval"
      : pending.kind === "permissions"
        ? "item/permissions/requestApproval"
        : pending.kind === "question"
          ? "item/tool/requestUserInput"
          : "mcpServer/elicitation/request";
  const summary = pending.safeSummary && typeof pending.safeSummary === "object"
    ? pending.safeSummary as Record<string, unknown>
    : {};
  return {
    id: requestId,
    method,
    params: {
      ...summary,
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: pending.itemId,
    },
  };
};

const messageFromRunEvent = (event: RunEventRecord): AgentMessage | null => {
  if (!event.safePayload || typeof event.safePayload !== "object") return null;
  if (event.eventType.startsWith("agent.")) return event.safePayload as AgentMessage;
  const protocol = (event.safePayload as Record<string, unknown>).protocol;
  return protocol && typeof protocol === "object" ? protocol as AgentMessage : null;
};

const timelineStatusForRun = (status: RunStatus): TimelineEntry["status"] => {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "interrupted" || status === "needs_attention") return "warning";
  return "active";
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
        body: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
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
      body: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      meta: typeof item.cwd === "string" ? item.cwd : "Workspace",
      status: commandStatus === "inProgress" ? "active" : failed ? "error" : "success",
    };
  }

  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const files = item.changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const value = change as Record<string, unknown>;
      if (typeof value.path !== "string") return [];
      const patch = typeof value.diff === "string" ? value.diff : undefined;
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
  activeTaskTimeline: TimelineEntry[],
  activeTaskTimelineComplete: boolean,
  activeTaskModel: string | null,
  fastMode: boolean,
  activeTaskApprovalPolicy: AgentApprovalPolicy,
  onTimelineChange: (taskId: string, timeline: TimelineEntry[]) => void,
  onPlanChange: (taskId: string, plan: AgentPlan | null) => void,
  onTaskTitleChange: (taskId: string, title: string) => void,
  onTaskGoalChange: (taskId: string, goal: AgentGoal | null) => void,
  onTaskFinished: (taskId: string, outcome: AgentTurnOutcome) => void,
  onWorkspaceChange: () => void,
  autoConnect = true,
) {
  const [runtime, setRuntime] = useState<AgentRuntimeState>(initialRuntime);
  const [account, setAccount] = useState<AgentAccountSummary | null>(null);
  const [accountUsage, setAccountUsage] = useState<AgentAccountUsage | null>(null);
  const [models, setModels] = useState<AgentModelSummary[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [threadUsage, setThreadUsage] = useState<Record<string, ThreadTokenUsage>>({});
  const [questionRequest, setQuestionRequest] = useState<AgentQuestionRequest | null>(null);
  const [compactingTaskId, setCompactingTaskId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [listenersReady, setListenersReady] = useState(!isTauriHost());
  const [runProjection, setRunProjection] = useState<RunProjection>(emptyRunProjection);
  const { usage, recordUsage } = useCodexUsage();
  const activeTaskIdRef = useRef(activeTaskId);
  const activeTimelineReadyRef = useRef(activeTaskTimelineComplete);
  const questionRequestRef = useRef<AgentQuestionRequest | null>(null);
  const runProjectionRef = useRef<RunProjection>(emptyRunProjection());
  const activeEnvironmentIdRef = useRef<string | null>(null);
  const activeGenerationRef = useRef<number | null>(null);
  const finishedRunIds = useRef(new Set<string>());
  const replayedPendingInputs = useRef(new Set<string>());
  const sessionIds = useRef(new Map<string, string>());
  const syncedGoals = useRef(new Map<string, string>());
  const threadTasks = useRef(new Map<string, string>());
  const liveAgentEntries = useRef(new Map<string, string>());
  const activeThinkingEntries = useRef(new Map<string, string>());
  const reasoningEntries = useRef(new Map<string, string>());
  const reasoningChannels = useRef(new Map<string, "summary" | "content">());
  const autoTitledTasks = useRef(new Set<string>());
  const activeTurnIds = useRef(new Map<string, string>());
  const activeTurnDiffs = useRef(new Map<string, string>());
  const pendingUserEntries = useRef(new Map<string, string>());
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
  const onTaskGoalChangeRef = useRef(onTaskGoalChange);
  const onTaskFinishedRef = useRef(onTaskFinished);
  const onWorkspaceChangeRef = useRef(onWorkspaceChange);

  useEffect(() => {
    onTimelineChangeRef.current = onTimelineChange;
  }, [onTimelineChange]);

  useEffect(() => {
    questionRequestRef.current = questionRequest;
  }, [questionRequest]);

  useEffect(() => {
    onPlanChangeRef.current = onPlanChange;
  }, [onPlanChange]);

  useEffect(() => {
    onTaskTitleChangeRef.current = onTaskTitleChange;
  }, [onTaskTitleChange]);

  useEffect(() => {
    onTaskGoalChangeRef.current = onTaskGoalChange;
  }, [onTaskGoalChange]);

  useEffect(() => {
    onTaskFinishedRef.current = onTaskFinished;
  }, [onTaskFinished]);

  useEffect(() => {
    onWorkspaceChangeRef.current = onWorkspaceChange;
  }, [onWorkspaceChange]);

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
    activeTimelineReadyRef.current = activeTaskTimelineComplete;
    timelineCache.current.set(activeTaskId, activeTaskTimeline);
    taskApprovalPolicies.current.set(activeTaskId, activeTaskApprovalPolicy);
    setQuestionRequest((current) => current?.taskId === activeTaskId ? current : null);
    setRuntime((current) => ({
      ...current,
      threadId:
        current.phase === "working"
          ? current.threadId
          : sessionIds.current.get(activeTaskId) ?? null,
    }));
  }, [
    activeTaskApprovalPolicy,
    activeTaskId,
    activeTaskTimeline,
    activeTaskTimelineComplete,
  ]);

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
        const pendingInputId = (timelineCache.current.get(taskId) ?? []).find(
          (entry) => entry.id === entryId || String(entry.requestId) === String(requestId),
        )?.pendingInputId;
        if (!pendingInputId) throw new Error("The native approval request is no longer active.");
        await nativeBridge.resolveXiaoRunInput(
          pendingInputId,
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
    try {
      setAccountUsage(await nativeBridge.readAgentUsage(workspacePath, activeTaskIdRef.current));
    } catch {
      setAccountUsage(null);
    }
  }, [workspacePath]);

  const refreshRuntimeIdentity = useCallback(async () => {
    try {
      const [nextAccount, nextModels] = await Promise.all([
        nativeBridge.readAgentAccount(workspacePath, activeTaskIdRef.current),
        nativeBridge.listAgentModels(workspacePath, activeTaskIdRef.current),
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
  }, [refreshAccountUsage, workspacePath]);

  const resolveTaskId = useCallback((message: AgentMessage) => {
    const threadId = readMessageThreadId(message);
    if (threadId) {
      const taskId = threadTasks.current.get(threadId);
      if (taskId) return taskId;
    }
    return activeTaskIdRef.current;
  }, []);

  const handleMessage = useCallback(
    async (
      message: AgentMessage,
      route?: {
        taskId: string;
        runId: string;
        pendingInput: PendingInputSnapshot | null;
        turnDiff?: string | null;
        replayed?: boolean;
      },
    ) => {
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
          void nativeBridge.stopAgent(workspacePath, activeTaskIdRef.current).catch(() => {
            runtimeStopError.current = null;
          });
          return;
        }
        if (message.result) {
          reconnectAttempt.current = 0;
          const activeRun = activeRunForTask(
            runProjectionRef.current,
            activeTaskIdRef.current,
          );
          setRuntime((current) => activeRun
            ? {
                ...current,
                phase: "working",
                taskId: activeRun.taskId,
                threadId: activeRun.threadId,
                turnId: activeRun.turnId,
                turnStartedAt: activeRun.startedAt,
                error: null,
              }
            : {
                ...current,
                phase: "ready",
                taskId: null,
                turnStartedAt: null,
                error: null,
              });
          void refreshRuntimeIdentity();
          return;
        }
      }

      const taskId = route?.taskId ?? resolveTaskId(message);

      if (message.method === "item/tool/requestUserInput") {
        const pendingInput = route?.pendingInput;
        const request = pendingInput
          ? readQuestionRequest(message, taskId, pendingInput.id, route.runId)
          : null;
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
        const entryId = `elicitation-${route?.pendingInput?.id ?? String(message.id)}`;
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
                    "Interactive MCP elicitation is not available in Xiao yet, so the native run service declined this request.",
                  ].join("\n\n"),
                  meta: serverName,
                  status: "error",
                },
              ],
        );
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
          const pendingEntryId = route
            ? runProjectionRef.current.runsById[route.runId]?.idempotencyKey
            : pendingUserEntries.current.get(taskId);
          if (pendingEntryId) {
            updateTimeline(taskId, (current) => current.map((entry) =>
              entry.id === pendingEntryId ? { ...entry, turnId } : entry,
            ));
          }
        }
        if (!route || taskId === activeTaskIdRef.current) {
          setRuntime((current) => ({
            ...current,
            phase: "working",
            taskId,
            threadId: threadId ?? current.threadId,
            turnId,
          }));
        }
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
          if (entry) {
            updateTimeline(taskId, (current) =>
              current.some((currentEntry) => currentEntry.id === entry.id)
                ? current
                : [...current, entry],
            );
          }
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
        updateTimeline(taskId, (current) => {
          const timeline = item.type === "contextCompaction"
            ? invalidateUndoHistory(current)
            : current;
          return timeline.some((currentEntry) => currentEntry.id === completedEntry.id)
            ? timeline.map((currentEntry) => {
                if (currentEntry.id !== completedEntry.id) return currentEntry;
                const streamedBody = currentEntry.body;
                const completedBody = completedEntry.body;
                const preserveStreamedBody =
                  (item.type === "agentMessage" || item.type === "reasoning") &&
                  streamedBody != null &&
                  (completedBody == null || streamedBody.length > completedBody.length);
                return {
                  ...completedEntry,
                  body: preserveStreamedBody ? streamedBody : completedBody ?? streamedBody,
                };
              })
            : [...timeline, completedEntry];
        });
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
          id: `approval-${route?.pendingInput?.id ?? String(message.id)}`,
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
          pendingInputId: route?.pendingInput?.id,
          runId: route?.runId,
          approvalKind,
          approvalPermissions: requestedPermissions,
          turnId: typeof message.params?.turnId === "string" ? message.params.turnId : undefined,
          meta: "Waiting for your decision",
          status: "warning",
        };
        if (taskApprovalPolicies.current.get(taskId) === "never") {
          updateTimeline(taskId, (current) => [
            ...current,
            { ...approvalEntry, status: "error", meta: "Declined by Never ask" },
          ]);
        } else {
          updateTimeline(taskId, (current) =>
            current.some((entry) => entry.id === approvalEntry.id)
              ? current
              : [...current, approvalEntry],
          );
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
          if (outcome === "completed") {
            updateTimeline(taskId, invalidateUndoHistory);
          }
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
        const completedTurnDiff = route?.turnDiff ?? (completedTurnId
          ? activeTurnDiffs.current.get(completedTurnId)
          : undefined);
        const pendingEntryId = route
          ? runProjectionRef.current.runsById[route.runId]?.idempotencyKey
          : pendingUserEntries.current.get(taskId);
        settleThinking(taskId);
        liveAgentEntries.current.delete(taskId);
        setQuestionRequest((current) => current?.taskId === taskId ? null : current);
        if (!route) {
          setRuntime((current) => ({
            ...current,
            phase: "ready",
            taskId: null,
            threadId: sessionIds.current.get(activeTaskIdRef.current) ?? null,
            turnId: null,
            turnStartedAt: null,
            error: errorMessage,
          }));
        } else if (errorMessage && !route?.replayed) {
          setRuntime((current) => ({ ...current, error: errorMessage }));
        }
        if (
          !manualCompaction &&
          !route?.replayed &&
          (!route || !finishedRunIds.current.has(route.runId))
        ) {
          if (route) finishedRunIds.current.add(route.runId);
          onTaskFinishedRef.current(taskId, outcome);
        }
        if (!route?.replayed) void refreshAccountUsage();
        updateTimeline(taskId, (current) => {
          const settledStatus: TimelineEntry["status"] =
            outcome === "completed" ? "success" : outcome === "failed" ? "error" : "warning";
          const settled = current.map((entry) => {
            const belongsToCompletedRun = !route ||
              entry.runId === route.runId ||
              (completedTurnId != null && entry.turnId === completedTurnId) ||
              entry.id === pendingEntryId;
            const settledEntry = entry.status === "active" && belongsToCompletedRun
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
        if (pendingUserEntries.current.get(taskId) === pendingEntryId) {
          pendingUserEntries.current.delete(taskId);
        }
        activeTurnIds.current.delete(taskId);
        if (completedTurnId) activeTurnDiffs.current.delete(completedTurnId);
      }
    },
    [
      appendRuntimeLog,
      recordUsage,
      refreshAccountUsage,
      refreshRuntimeIdentity,
      resolveTaskId,
      settleThinking,
      updateTimeline,
      workspacePath,
    ],
  );

  const publishRunProjection = useCallback((next: RunProjection) => {
    runProjectionRef.current = next;
    setRunProjection(next);
    const activeRun = activeRunForTask(next, activeTaskIdRef.current);
    if (activeRun) {
      activeEnvironmentIdRef.current = activeRun.executionEnvironmentId;
      activeGenerationRef.current = activeRun.runtimeGeneration;
      if (activeRun.threadId) {
        sessionIds.current.set(activeRun.taskId, activeRun.threadId);
        threadTasks.current.set(activeRun.threadId, activeRun.taskId);
      }
      if (activeRun.turnId) activeTurnIds.current.set(activeRun.taskId, activeRun.turnId);
      setRuntime((current) => ({
        ...current,
        phase: "working",
        taskId: activeRun.taskId,
        threadId: activeRun.threadId,
        turnId: activeRun.turnId,
        turnStartedAt: activeRun.startedAt,
        error: null,
      }));
    } else {
      activeTurnIds.current.delete(activeTaskIdRef.current);
      setRuntime((current) =>
        current.phase === "offline" || current.phase === "starting" || current.phase === "error"
          ? current
          : {
              ...current,
              phase: "ready",
              taskId: null,
              threadId: sessionIds.current.get(activeTaskIdRef.current) ?? null,
              turnId: null,
              turnStartedAt: null,
            },
      );
    }
  }, []);

  useEffect(() => {
    publishRunProjection(runProjectionRef.current);
  }, [activeTaskId, publishRunProjection]);

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
          await listen<RunUpdateEnvelope>("xiao://run-update", (event) => {
            if (disposed || event.payload.snapshot.workspacePath !== workspacePath) return;
            const next = projectRunUpdate(runProjectionRef.current, event.payload);
            publishRunProjection(next);
            const pending = event.payload.pendingInput;
            if (pending?.resolvedAt != null || pending?.invalidatedAt != null) {
              setQuestionRequest((current) =>
                current?.pendingInputId === pending.id ? null : current,
              );
            }
            const run = event.payload.snapshot;
            if (
              run.status === "completed" ||
              run.status === "failed" ||
              run.status === "cancelled" ||
              run.status === "interrupted"
            ) {
              setQuestionRequest((current) => current?.runId === run.id ? null : current);
              const outcome: AgentTurnOutcome = run.status === "completed"
                ? "completed"
                : run.status === "failed"
                  ? "failed"
                  : "interrupted";
              if (
                run.taskId === activeTaskIdRef.current &&
                activeTimelineReadyRef.current
              ) {
                const status = timelineStatusForRun(run.status);
                updateTimeline(run.taskId, (current) => {
                  const settled = current.map((entry) =>
                    entry.status === "active" &&
                    (entry.runId === run.id || (run.turnId && entry.turnId === run.turnId))
                      ? { ...entry, status }
                      : entry,
                  );
                  return reconcilePendingApprovalEntries(settled, null, run.id);
                });
              }
              if (!finishedRunIds.current.has(run.id)) {
                finishedRunIds.current.add(run.id);
                onTaskFinishedRef.current(run.taskId, outcome);
              }
            }
          }),
        );
        addCleanup(
          await listen<RunProtocolEnvelope>("xiao://run-protocol", (event) => {
            if (
              disposed ||
              event.payload.taskId !== activeTaskIdRef.current ||
              !activeTimelineReadyRef.current
            ) return;
            const accepted = acceptRunProtocol(runProjectionRef.current, event.payload);
            if (!accepted.accepted) return;
            publishRunProjection(accepted.projection);
            void handleMessage(event.payload.message, {
              taskId: event.payload.taskId,
              runId: event.payload.runId,
              pendingInput: event.payload.pendingInput,
              turnDiff: event.payload.turnDiff,
            });
          }),
        );
        addCleanup(
          await listen<RuntimeMessageEnvelope>("agent://runtime-message", (event) => {
            const activeEnvironmentId = activeEnvironmentIdRef.current;
            const activeGeneration = activeGenerationRef.current;
            if (
              !disposed &&
              (!activeEnvironmentId || event.payload.environmentId === activeEnvironmentId) &&
              (activeGeneration == null || event.payload.generation === activeGeneration) &&
              (event.payload.message.id === 0 || compactingTasks.current.size > 0)
            ) {
              void handleMessage(event.payload.message);
            }
          }),
        );
        addCleanup(
          await listen<RuntimeDiagnosticEnvelope>("agent://runtime-stderr", (event) => {
            if (
              !disposed &&
              event.payload.message.trim() &&
              (!activeEnvironmentIdRef.current ||
                event.payload.environmentId === activeEnvironmentIdRef.current)
            ) {
              appendRuntimeLog("stderr", event.payload.message);
            }
          }),
        );
        addCleanup(
          await listen<RuntimeStoppedEnvelope>("agent://runtime-stopped", (event) => {
            if (
              disposed ||
              (activeEnvironmentIdRef.current &&
                event.payload.environmentId !== activeEnvironmentIdRef.current)
            ) return;
            const stopError = runtimeStopError.current;
            runtimeStopError.current = null;
            if (!stopError) reconnectAttempt.current += 1;
            activeGenerationRef.current = null;
            sessionIds.current.clear();
            threadTasks.current.clear();
            liveAgentEntries.current.clear();
            activeThinkingEntries.current.clear();
            reasoningEntries.current.clear();
            reasoningChannels.current.clear();
            compactingTasks.current.clear();
            syncedGoals.current.clear();
            appendRuntimeLog("system", "Agent runtime stopped.");
            setAccount(null);
            setAccountUsage(null);
            setModels([]);
            setThreadUsage({});
            setQuestionRequest(null);
            setCompactingTaskId(null);
            setRuntime(
              stopError
                ? { ...initialRuntime, phase: "error", error: stopError }
                : initialRuntime,
            );
          }),
        );
        addCleanup(
          await listen<string>("xiao://run-service-error", (event) => {
            if (!disposed) {
              appendRuntimeLog("stderr", event.payload);
              setRuntime((current) => ({ ...current, error: event.payload }));
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
  }, [appendRuntimeLog, handleMessage, publishRunProjection, workspacePath]);

  useEffect(() => {
    if (!isTauriHost() || !listenersReady) return;
    let cancelled = false;
    replayedPendingInputs.current.clear();
    finishedRunIds.current.clear();
    const empty = emptyRunProjection();
    publishRunProjection(empty);
    void nativeBridge.listXiaoRuns(workspacePath, null, 100).then((runs) => {
      if (cancelled) return;
      for (const run of runs) {
        if (run.threadId && runStatusIsActive(run.status)) {
          sessionIds.current.set(run.taskId, run.threadId);
          threadTasks.current.set(run.threadId, run.taskId);
          if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
        }
      }
      publishRunProjection(mergeListedRunSnapshots(runProjectionRef.current, runs));
    }).catch((reason) => {
      if (!cancelled) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    });
    return () => { cancelled = true; };
  }, [listenersReady, publishRunProjection, workspacePath]);

  useEffect(() => {
    if (!isTauriHost() || !listenersReady || !activeTaskTimelineComplete) return;
    let cancelled = false;
    replayedPendingInputs.current.clear();
    const restore = async () => {
      const [runs, pendingInputs] = await Promise.all([
        nativeBridge.listXiaoRuns(workspacePath, activeTaskId, 50),
        nativeBridge.listXiaoPendingInputs(workspacePath, activeTaskId),
      ]);
      if (cancelled) return;
      publishRunProjection(projectRunSnapshots(runProjectionRef.current, runs));
      const orderedRuns = [...runs].sort(
        (left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id),
      );
      const activePendingInputIds = activePendingInputIdsForRestore(
        runProjectionRef.current,
        pendingInputs,
      );
      updateTimeline(activeTaskId, (current) => {
        let next = current;
        for (const run of orderedRuns) {
          const status = timelineStatusForRun(run.status);
          const existing = next.find(
            (entry) => entry.id === run.idempotencyKey || entry.runId === run.id,
          );
          if (existing) {
            next = next.map((entry) =>
              entry.id === existing.id
                ? {
                    ...entry,
                    runId: run.id,
                    status,
                    turnId: run.turnId ?? entry.turnId,
                    meta: run.status === "queued" ? "Queued" : "You",
                  }
                : entry,
            );
            continue;
          }
          next = [
            ...next,
            {
              id: run.idempotencyKey,
              runId: run.id,
              kind: "user",
              title: run.prompt,
              createdAt: run.queuedAt,
              meta: run.status === "queued" ? "Queued" : "You",
              status,
              turnId: run.turnId ?? undefined,
            },
          ];
        }
        return reconcilePendingApprovalEntries(next, activePendingInputIds);
      });

      for (const run of orderedRuns) {
        if (cancelled) return;
        if (run.runtimeGeneration == null || !run.threadId) continue;
        if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
        const page = await nativeBridge.loadXiaoRunEvents(run.id, null, 200);
        for (const event of page.events) {
          if (cancelled) return;
          const message = messageFromRunEvent(event);
          if (!message) continue;
          const envelope: RunProtocolEnvelope = {
            runId: run.id,
            taskId: run.taskId,
            executionEnvironmentId: run.executionEnvironmentId,
            runtimeGeneration: run.runtimeGeneration,
            threadId: run.threadId,
            turnId: run.turnId,
            itemId: null,
            sequence: event.sequence,
            message,
            turnDiff: null,
            pendingInput: null,
          };
          const accepted = acceptRunProtocol(runProjectionRef.current, envelope);
          if (!accepted.accepted) continue;
          publishRunProjection(accepted.projection);
          if (run.turnId) activeTurnIds.current.set(run.taskId, run.turnId);
          await handleMessage(message, {
            taskId: run.taskId,
            runId: run.id,
            pendingInput: null,
            replayed: true,
          });
        }
      }

      for (const pending of pendingInputs) {
        if (
          cancelled ||
          replayedPendingInputs.current.has(pending.id) ||
          !shouldRestorePendingInput(runProjectionRef.current, pending)
        ) continue;
        const run = runs.find((item) => item.id === pending.runId);
        if (!run) continue;
        replayedPendingInputs.current.add(pending.id);
        await handleMessage(messageFromPendingInput(pending), {
          taskId: run.taskId,
          runId: run.id,
          pendingInput: pending,
        });
      }
    };
    void restore().catch((reason) => {
      if (!cancelled) {
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    });
    return () => { cancelled = true; };
  }, [
    activeTaskId,
    activeTaskTimelineComplete,
    handleMessage,
    listenersReady,
    publishRunProjection,
    updateTimeline,
    workspacePath,
  ]);

  const connect = useCallback(async () => {
    if (!isTauriHost()) {
      setRuntime((current) => ({
        ...current,
        phase: "error",
        error: "Run npm run tauri dev to connect the native agent runtime.",
      }));
      return;
    }

    activeEnvironmentIdRef.current = null;
    activeGenerationRef.current = null;
    setRuntime((current) => ({ ...current, phase: "starting", error: null }));
    appendRuntimeLog("system", "Starting Codex app-server.");
    try {
      const result = await nativeBridge.startAgent(workspacePath, activeTaskIdRef.current);
      activeEnvironmentIdRef.current = result.environmentId;
      activeGenerationRef.current = result.generation;
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
  }, [appendRuntimeLog, refreshRuntimeIdentity, workspacePath]);

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
    async (
      prompt: string,
      attachments: AgentAttachment[],
      idempotencyKey: string = crypto.randomUUID(),
    ) => {
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt || !isTauriHost()) return false;
      const currentTimeline = timelineCache.current.get(activeTaskId) ?? activeTaskTimeline;
      const userEntryId = idempotencyKey;
      const existingUserEntry = currentTimeline.some((entry) => entry.id === userEntryId);
      updateTimeline(activeTaskId, (current) =>
        current.some((entry) => entry.id === userEntryId)
          ? current
          : [
              ...current,
              {
                id: userEntryId,
                kind: "user",
                title: cleanPrompt,
                createdAt: Date.now(),
                attachments: attachments.length ? attachments : undefined,
                meta: "Queued",
                status: "active",
              },
            ],
      );
      pendingUserEntries.current.set(activeTaskId, userEntryId);
      const requestedModel = activeTaskModel
        ? models.find((model) => model.model === activeTaskModel)
        : models.find((model) => model.isDefault);
      try {
        const run = await nativeBridge.enqueueXiaoRun({
          projectPath: workspacePath,
          taskId: activeTaskId,
          idempotencyKey: userEntryId,
          prompt: cleanPrompt,
          input: userInput(cleanPrompt, attachments),
          history: historyFromTimeline(currentTimeline),
          serviceTier: serviceTierForFastMode(requestedModel, fastMode),
        });
        if (activeTaskTitle === "New task") {
          autoTitledTasks.current.add(activeTaskId);
          onTaskTitleChangeRef.current(activeTaskId, titleFromPrompt(cleanPrompt));
        }
        updateTimeline(activeTaskId, (current) =>
          current.map((entry) =>
            entry.id === userEntryId
              ? { ...entry, runId: run.id, meta: "Queued", status: "active" }
              : entry,
          ),
        );
        return true;
      } catch (reason) {
        pendingUserEntries.current.delete(activeTaskId);
        if (!existingUserEntry) {
          updateTimeline(activeTaskId, (current) =>
            current.filter((entry) => entry.id !== userEntryId),
          );
        }
        setRuntime((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [
      activeTaskId,
      activeTaskModel,
      activeTaskTimeline,
      activeTaskTitle,
      fastMode,
      models,
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
      await nativeBridge.agentRequest(
        request.method,
        request.params,
        { projectPath: workspacePath, taskId: activeTaskId },
      );
      return true;
    } catch (reason) {
      compactingTasks.current.delete(activeTaskId);
      setCompactingTaskId((current) => current === activeTaskId ? null : current);
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
  }, [activeTaskId, runtime.phase, workspacePath]);

  const interrupt = useCallback(async () => {
    const activeRun = activeRunForTask(runProjectionRef.current, activeTaskId);
    if (!activeRun) return;
    try {
      const snapshot = await nativeBridge.cancelXiaoRun(activeRun.id);
      publishRunProjection(projectRunUpdate(runProjectionRef.current, {
        snapshot,
        event: null,
        pendingInput: null,
      }));
    } catch (reason) {
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [activeTaskId, publishRunProjection]);

  const retryRun = useCallback(async (runId: string) => {
    try {
      const snapshot = await nativeBridge.retryXiaoRun(runId, `retry:${runId}`);
      publishRunProjection(projectRunUpdate(runProjectionRef.current, {
        snapshot,
        event: null,
        pendingInput: null,
      }));
      return true;
    } catch (reason) {
      setRuntime((current) => ({
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
      return false;
    }
  }, [publishRunProjection]);

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
        await nativeBridge.agentRequest(
          "thread/settings/update",
          { threadId, approvalPolicy },
          { projectPath: workspacePath, taskId: activeTaskId },
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
    [activeTaskId, declineWithoutPrompt, workspacePath],
  );

  const undoLastTurn = useCallback(async (): Promise<AgentUndoResult | null> => {
    const timeline = timelineCache.current.get(activeTaskId) ?? activeTaskTimeline;
    const target = latestUndoableTurn(timeline);
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
        await nativeBridge.applyGitPatch(workspacePath, activeTaskId, patch, true, true);
        stage = "files";
        await nativeBridge.applyGitPatch(workspacePath, activeTaskId, patch, true, false);
        patchReverted = true;
      }

      stage = "history";
      await nativeBridge.agentRequest(
        "thread/rollback",
        { threadId, numTurns: 1 },
        { projectPath: workspacePath, taskId: activeTaskId },
      );

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
          await nativeBridge.applyGitPatch(workspacePath, activeTaskId, patch, false, true);
          await nativeBridge.applyGitPatch(workspacePath, activeTaskId, patch, false, false);
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
        await nativeBridge.agentRequest(
          "thread/goal/set",
          { threadId, objective: cleanObjective, status },
          { projectPath: workspacePath, taskId: activeTaskId },
        );
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
    [activeTaskId, workspacePath],
  );

  const clearGoal = useCallback(async () => {
    const threadId = sessionIds.current.get(activeTaskId);
    if (!threadId) {
      onTaskGoalChangeRef.current(activeTaskId, null);
      syncedGoals.current.delete(activeTaskId);
      return true;
    }
    try {
      await nativeBridge.agentRequest(
        "thread/goal/clear",
        { threadId },
        { projectPath: workspacePath, taskId: activeTaskId },
      );
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
  }, [activeTaskId, workspacePath]);

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
        if (!approval?.pendingInputId) {
          throw new Error(`Approval ${String(requestId)} is no longer active.`);
        }
        await nativeBridge.resolveXiaoRunInput(
          approval.pendingInputId,
          approvalResponse(approval.approvalKind, approval.approvalPermissions, decision),
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
        const request = questionRequestRef.current;
        if (!request || String(request.requestId) !== String(requestId)) {
          throw new Error("This question is no longer attached to a live Xiao run.");
        }
        await nativeBridge.resolveXiaoRunInput(request.pendingInputId, {
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

  const activeThreadId = sessionIds.current.get(activeTaskId) ?? null;
  const activeRun = activeRunForTask(runProjection, activeTaskId);
  const latestRun = latestRunForTask(runProjection, activeTaskId);
  const compacting = compactingTaskId === activeTaskId;
  const canCompact = runtime.phase === "ready" && Boolean(activeThreadId) && compactingTaskId === null;
  const canUndo = runtime.phase === "ready" && Boolean(
    activeThreadId && latestUndoableTurn(activeTaskTimeline),
  );

  return {
    runtime,
    account,
    accountUsage,
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
    activeRun,
    latestRun,
    hasActiveRuns: Object.values(runProjection.runsById).some((run) =>
      runStatusIsActive(run.status)
    ),
    workingTaskIds: [...new Set(
      Object.values(runProjection.runsById)
        .filter((run) => runStatusIsActive(run.status))
        .map((run) => run.taskId),
    )],
    isTaskWorking: (taskId: string) => Boolean(activeRunForTask(runProjection, taskId)),
    connect,
    submit,
    compact,
    interrupt,
    retryRun,
    setApprovalPolicy,
    undoLastTurn,
    setGoal,
    clearGoal,
    resolveQuestion,
    resolveApproval,
  };
}
