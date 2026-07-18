import { nativeBridge } from "../../../core/bridges/tauri";
import type {
  AgentAttachment,
  CodexThreadSummary,
  ThreadChangeSummary,
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
  status?: unknown;
};

const threadStatus = (value: unknown): CodexThreadSummary["status"] => {
  if (!value || typeof value !== "object") return "notLoaded";
  const type = (value as Record<string, unknown>).type;
  return type === "idle" || type === "systemError" || type === "active" ? type : "notLoaded";
};

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
    status: threadStatus(thread.status),
  };
};

export const listCodexThreads = async (): Promise<CodexThreadSummary[]> => {
  const results: CodexThreadSummary[] = [];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await nativeBridge.listCodexThreadsPage(archived, cursor);
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
  return [...new Map(results.map((thread) => [thread.id, thread])).values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
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
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? [String((part as Record<string, unknown>).text)]
        : [],
    )
    .join("\n\n")
    .trim();
  const attachments = item.content.reduce<AgentAttachment[]>((result, part, index) => {
    if (!part || typeof part !== "object") return result;
    const value = part as Record<string, unknown>;
    if (value.type === "localImage" && typeof value.path === "string") {
      result.push({ id: `${String(item.id)}-${index}`, name: "Image", path: value.path, kind: "image" });
    } else if (value.type === "image" && typeof value.url === "string") {
      result.push({ id: `${String(item.id)}-${index}`, name: "Image", path: value.url, url: value.url, kind: "image" });
    } else if (value.type === "mention" && typeof value.path === "string") {
      result.push({
        id: `${String(item.id)}-${index}`,
        name: typeof value.name === "string" ? value.name : value.path,
        path: value.path,
        kind: "file",
      });
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
          change &&
          typeof change === "object" &&
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

export const listRecentCodexThreads = async (): Promise<CodexThreadSummary[]> => {
  const response = await nativeBridge.listCodexThreadsPage(false, null);
  return (Array.isArray(response.data) ? response.data : []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const summary = threadSummary(row as RawThread, false);
    return summary ? [summary] : [];
  });
};

const firstPageCache = new Map<string, CodexThreadPage>();
const firstPageRequests = new Map<string, Promise<CodexThreadPage>>();

export const readCodexThreadChangeSummary = async (
  threadId: string,
): Promise<ThreadChangeSummary | null> => {
  const response = await nativeBridge.readCodexThreadTurns(threadId, null, 6);
  const turns = Array.isArray(response.data) ? response.data : [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const items = Array.isArray((turn as Record<string, unknown>).items)
      ? ((turn as Record<string, unknown>).items as unknown[])
      : [];
    const files = new Map<string, { additions: number; deletions: number }>();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (value.type !== "fileChange" || !Array.isArray(value.changes)) continue;
      for (const change of value.changes) {
        if (!change || typeof change !== "object") continue;
        const detail = change as Record<string, unknown>;
        if (typeof detail.path !== "string") continue;
        const diff = typeof detail.diff === "string" ? detail.diff : "";
        let additions = 0;
        let deletions = 0;
        for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
          if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
        }
        const previous = files.get(detail.path) ?? { additions: 0, deletions: 0 };
        files.set(detail.path, {
          additions: previous.additions + additions,
          deletions: previous.deletions + deletions,
        });
      }
    }
    if (files.size) {
      return {
        files: files.size,
        additions: [...files.values()].reduce((sum, file) => sum + file.additions, 0),
        deletions: [...files.values()].reduce((sum, file) => sum + file.deletions, 0),
      };
    }
  }
  return null;
};

const fetchCodexThreadTimeline = async (
  threadId: string,
  cursor: string | null = null,
): Promise<CodexThreadPage> => {
  const response = await nativeBridge.readCodexThreadTurns(threadId, cursor);
  const turns = Array.isArray(response.data) ? [...response.data].reverse() : [];
  const timeline = turns.flatMap((rawTurn) => {
    if (!rawTurn || typeof rawTurn !== "object") return [];
    const turn = rawTurn as Record<string, unknown>;
    const turnId = typeof turn.id === "string" ? turn.id : crypto.randomUUID();
    const createdAt = typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now();
    const items = Array.isArray(turn.items)
      ? turn.items.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
        )
      : [];
    const turnDiff = diffForTurn(items);
    const completedSeconds = typeof turn.completedAt === "number"
      ? turn.completedAt
      : typeof turn.updatedAt === "number" ? turn.updatedAt : null;
    const durationMs = completedSeconds ? Math.max(0, completedSeconds * 1_000 - createdAt) : undefined;
    return items.flatMap((item) => {
      if (item.type === "userMessage") {
        const entry = userEntry(item, createdAt, turnId, turnDiff);
        return entry ? [{ ...entry, durationMs }] : [];
      }
      const entry = timelineEntryFromItem(item, createdAt);
      return entry ? [{ ...entry, turnId, durationMs }] : [];
    });
  });
  return {
    timeline,
    nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null,
  };
};

export const peekCodexThreadTimeline = (threadId: string) => firstPageCache.get(threadId) ?? null;

export const prefetchCodexThreadTimeline = (threadId: string): Promise<CodexThreadPage> => {
  const cached = firstPageCache.get(threadId);
  if (cached) return Promise.resolve(cached);
  const pending = firstPageRequests.get(threadId);
  if (pending) return pending;
  const request = fetchCodexThreadTimeline(threadId)
    .then((page) => {
      firstPageCache.set(threadId, page);
      firstPageRequests.delete(threadId);
      return page;
    })
    .catch((reason) => {
      firstPageRequests.delete(threadId);
      throw reason;
    });
  firstPageRequests.set(threadId, request);
  return request;
};

export const readCodexThreadTimeline = (
  threadId: string,
  cursor: string | null = null,
): Promise<CodexThreadPage> => cursor
  ? fetchCodexThreadTimeline(threadId, cursor)
  : prefetchCodexThreadTimeline(threadId);

export const refreshCodexThreadTimeline = async (threadId: string): Promise<CodexThreadPage> => {
  const page = await fetchCodexThreadTimeline(threadId);
  firstPageCache.set(threadId, page);
  return page;
};

export const sameWorkspacePath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLocaleLowerCase() ===
  right.replace(/[\\/]+$/, "").toLocaleLowerCase();
