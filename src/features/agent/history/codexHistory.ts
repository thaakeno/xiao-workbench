import { nativeBridge } from "../../../core/bridges/tauri";
import type {
  AgentAttachment,
  CodexThreadSummary,
  TimelineEntry,
} from "../../../core/models/agent";
import { timelineEntryFromItem } from "../hooks/useAgentRuntime";

type RawThread = {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  turns?: unknown;
};

type ThreadListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

const SOURCE_KINDS = ["cli", "vscode", "appServer"];

const cleanTitle = (name: unknown, preview: unknown) => {
  const named = typeof name === "string" ? name.trim() : "";
  if (named) return named;
  const firstLine = typeof preview === "string" ? preview.trim().split(/\r?\n/, 1)[0] : "";
  if (!firstLine) return "Untitled task";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
};

const threadSummary = (thread: RawThread, archived: boolean): CodexThreadSummary | null => {
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string") return null;
  const createdAt = typeof thread.createdAt === "number" ? thread.createdAt * 1_000 : Date.now();
  const updatedSeconds =
    typeof thread.recencyAt === "number"
      ? thread.recencyAt
      : typeof thread.updatedAt === "number"
        ? thread.updatedAt
        : createdAt / 1_000;
  return {
    id: thread.id,
    title: cleanTitle(thread.name, thread.preview),
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: thread.cwd,
    createdAt,
    updatedAt: updatedSeconds * 1_000,
    archived,
  };
};

const listPage = async (archived: boolean, cursor: string | null) =>
  nativeBridge.agentRequest<ThreadListResponse>("thread/list", {
    archived,
    cursor,
    limit: 100,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds: SOURCE_KINDS,
  });

export const listCodexThreads = async (): Promise<CodexThreadSummary[]> => {
  const results: CodexThreadSummary[] = [];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await listPage(archived, cursor);
      const rows = Array.isArray(response.data) ? response.data : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const summary = threadSummary(row as RawThread, archived);
        if (summary) results.push(summary);
      }
      const next = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    } while (cursor);
  }
  return [...new Map(results.map((thread) => [thread.id, thread])).values()]
    .sort((left, right) => right.updatedAt - left.updatedAt);
};

const userEntry = (
  item: Record<string, unknown>,
  createdAt: number,
  turnId: string,
  turnDiff?: string,
): TimelineEntry | null => {
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .flatMap((part) =>
      part && typeof part === "object" && (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? [String((part as Record<string, unknown>).text)]
        : [],
    )
    .join("\n\n")
    .trim();
  const attachments: AgentAttachment[] = item.content.reduce<AgentAttachment[]>((result, part, index) => {
    if (!part || typeof part !== "object") return result;
    const value = part as Record<string, unknown>;
    if (value.type === "localImage" && typeof value.path === "string") {
      result.push({ id: `${String(item.id)}-${index}`, name: "Image", path: value.path, kind: "image" });
      return result;
    }
    if (value.type === "image" && typeof value.url === "string") {
      result.push({ id: `${String(item.id)}-${index}`, name: "Image", path: value.url, url: value.url, kind: "image" });
      return result;
    }
    if (value.type === "mention" && typeof value.path === "string") {
      result.push({
        id: `${String(item.id)}-${index}`,
        name: typeof value.name === "string" ? value.name : value.path,
        path: value.path,
        kind: "file",
      });
      return result;
    }
    return result;
  }, []);
  if (!text && !attachments.length) return null;
  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    kind: "user",
    title: text || "Attached context",
    createdAt,
    attachments: attachments.length ? attachments : undefined,
    meta: "You",
    status: "success",
    turnId,
    turnDiff,
  };
};

const diffForTurn = (items: Record<string, unknown>[]) => {
  const patches = items.flatMap((item) =>
    item.type === "fileChange" && Array.isArray(item.changes)
      ? item.changes.flatMap((change) =>
          change && typeof change === "object" &&
          typeof (change as Record<string, unknown>).diff === "string"
            ? [String((change as Record<string, unknown>).diff)]
            : [],
        )
      : [],
  );
  return patches.length ? patches.join("\n") : undefined;
};

export type CodexThreadPage = {
  timeline: TimelineEntry[];
  nextCursor: string | null;
};

export const readCodexThreadTimeline = async (
  threadId: string,
  cursor: string | null = null,
): Promise<CodexThreadPage> => {
  const response = await nativeBridge.agentRequest<{ data?: unknown; nextCursor?: unknown }>("thread/turns/list", {
    threadId,
    cursor,
    limit: 24,
    sortDirection: "desc",
    itemsView: "full",
  });
  const turns = Array.isArray(response.data) ? [...response.data].reverse() : [];
  const timeline = turns.flatMap((rawTurn) => {
    if (!rawTurn || typeof rawTurn !== "object") return [];
    const turn = rawTurn as Record<string, unknown>;
    const turnId = typeof turn.id === "string" ? turn.id : crypto.randomUUID();
    const createdAt = typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now();
    const items = Array.isArray(turn.items)
      ? turn.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
    const turnDiff = diffForTurn(items);
    return items.flatMap((item) => {
      if (item.type === "userMessage") {
        const entry = userEntry(item, createdAt, turnId, turnDiff);
        return entry ? [entry] : [];
      }
      const entry = timelineEntryFromItem(item, createdAt);
      return entry ? [{ ...entry, turnId }] : [];
    });
  });
  return {
    timeline,
    nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null,
  };
};

export const sameWorkspacePath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLocaleLowerCase() ===
  right.replace(/[\\/]+$/, "").toLocaleLowerCase();
