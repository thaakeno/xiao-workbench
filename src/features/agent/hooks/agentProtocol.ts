import type {
  AgentApprovalRequestKind,
  AgentAttachment,
  AgentModelSummary,
  TimelineEntry,
} from "../../../core/models/agent";

export const reviewContextText = (attachment: AgentAttachment) => {
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

export const userInput = (prompt: string, attachments: AgentAttachment[]) => [
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
    const label = attachment.kind === "directory" ? "Attached directory" : "Attached file";
    return { type: "text", text: `${label}: ${attachment.path}`, text_elements: [] };
  }),
];

export const fastServiceTier = (model: AgentModelSummary | null | undefined) =>
  model?.serviceTiers.find((tier) => {
    const id = tier.id.trim().toLocaleLowerCase();
    const name = tier.name.trim().toLocaleLowerCase();
    return id === "fast" || id === "priority" || name === "fast";
  }) ?? null;

export const serviceTierForFastMode = (
  model: AgentModelSummary | null | undefined,
  fastMode: boolean,
) => fastMode ? fastServiceTier(model)?.id ?? null : null;

export const permissionGrantFromRequest = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  const request = value as Record<string, unknown>;
  const grant: Record<string, unknown> = {};
  if (request.network && typeof request.network === "object") {
    grant.network = request.network;
  }
  if (request.fileSystem && typeof request.fileSystem === "object") {
    grant.fileSystem = request.fileSystem;
  }
  return grant;
};

export const approvalResponse = (
  kind: AgentApprovalRequestKind | undefined,
  requestedPermissions: Record<string, unknown> | undefined,
  decision: "accept" | "decline",
): Record<string, unknown> => {
  if (kind === "permissions") {
    return {
      permissions: decision === "accept" ? requestedPermissions ?? {} : {},
      scope: "turn",
    };
  }
  return { decision };
};

export const reconcilePendingApprovalEntries = (
  timeline: TimelineEntry[],
  activePendingInputIds: ReadonlySet<string> | null,
  terminalRunId?: string,
): TimelineEntry[] => {
  let changed = false;
  const reconciled = timeline.map((entry) => {
    if (entry.kind !== "approval" || entry.status !== "warning") return entry;
    const terminal = terminalRunId != null && entry.runId === terminalRunId;
    const noLongerPending = activePendingInputIds != null && (
      !entry.pendingInputId || !activePendingInputIds.has(entry.pendingInputId)
    );
    if (!terminal && !noLongerPending) return entry;
    changed = true;
    return { ...entry, status: "error" as const, meta: "Request expired" };
  });
  return changed ? reconciled : timeline;
};

export const mcpElicitationDeclineResponse = (): Record<string, unknown> => ({
  action: "decline",
  content: null,
  _meta: null,
});

export const needsAgentSession = (
  threadId: string | undefined,
  hasRequestedModel: boolean,
  previousRequestedModel: string | null | undefined,
  requestedModel: string | null,
  previousExecutionKey: string | undefined,
  requestedExecutionKey: string,
) =>
  !threadId ||
  !hasRequestedModel ||
  previousRequestedModel !== requestedModel ||
  previousExecutionKey !== requestedExecutionKey;

export const invalidateUndoHistory = (timeline: TimelineEntry[]): TimelineEntry[] => {
  if (!timeline.some((entry) => entry.turnDiff !== undefined)) return timeline;
  return timeline.map((entry) => {
    if (entry.turnDiff === undefined) return entry;
    const next = { ...entry };
    delete next.turnDiff;
    return next;
  });
};

export const latestUndoableTurn = (timeline: TimelineEntry[]): TimelineEntry | null => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.kind !== "user") continue;
    return entry.turnId && entry.turnDiff !== undefined ? entry : null;
  }
  return null;
};

export const threadCompactRequest = (threadId: string) => ({
  method: "thread/compact/start" as const,
  params: { threadId },
});

export const contextCompactionTimelineEntry = (
  item: Record<string, unknown>,
  lifecycle: "started" | "completed",
): TimelineEntry | null => {
  if (item.type !== "contextCompaction" || typeof item.id !== "string") return null;
  const completed = lifecycle === "completed";
  return {
    id: item.id,
    kind: "result",
    title: completed ? "Context compacted" : "Compacting context",
    createdAt: Date.now(),
    meta: "Context",
    status: completed ? "success" : "active",
  };
};
