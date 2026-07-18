import { useMemo } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, TimelineEntry } from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import { ExplorationGroup } from "./ExplorationGroup";
import { LiveTurnStatus } from "./LiveTurnStatus";

type TaskTimelineProps = {
  timeline: TimelineEntry[];
  runtime: AgentRuntimeState;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  historyLoading: boolean;
  historyHasMore: boolean;
  canFork: boolean;
  onForkTask: (entryId: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  taskId: string;
  onReviewChanges: () => void;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
  historyLoadingOlder: boolean;
  onLoadOlderHistory: () => Promise<void>;
};

type TimelineRow =
  | { kind: "entry"; entry: TimelineEntry; index: number }
  | { kind: "exploration"; entries: TimelineEntry[]; index: number };

export const compactTimelineChanges = (
  timeline: TimelineEntry[],
  hideChangesAfterIndex = Number.POSITIVE_INFINITY,
) => {
  const keys = new Map<number, string>();
  let turnIndex = 0;
  timeline.forEach((entry, index) => {
    if (entry.kind === "user" || entry.kind === "brief") turnIndex += 1;
    keys.set(index, entry.turnId || `turn-${turnIndex}`);
  });
  const groups = new Map<string, Array<{ entry: TimelineEntry; index: number }>>();
  timeline.forEach((entry, index) => {
    if (entry.kind !== "change" || index > hideChangesAfterIndex) return;
    const key = keys.get(index)!;
    groups.set(key, [...(groups.get(key) ?? []), { entry, index }]);
  });
  const lastChangeIndex = new Map([...groups].map(([key, items]) => [key, items.at(-1)!.index]));
  return timeline.flatMap((entry, index) => {
    if (entry.kind !== "change") return [entry];
    if (index > hideChangesAfterIndex) return [];
    const key = keys.get(index)!;
    if (lastChangeIndex.get(key) !== index) return [];
    const items = groups.get(key) ?? [];
    const files = new Map<string, NonNullable<TimelineEntry["files"]>[number]>();
    for (const item of items) for (const file of item.entry.files ?? []) {
      const previous = files.get(file.path);
      files.set(file.path, previous ? {
        ...file,
        additions: previous.additions + file.additions,
        deletions: previous.deletions + file.deletions,
        patch: [previous.patch, file.patch].filter(Boolean).join("\n"),
      } : file);
    }
    return [{
      ...entry,
      id: `changes-${key}`,
      title: `Updated ${files.size} ${files.size === 1 ? "file" : "files"}`,
      files: [...files.values()],
      status: items.some((item) => item.entry.status === "error") ? "error" as const : "success" as const,
    }];
  });
};

export const timelineRows = (timeline: TimelineEntry[]): TimelineRow[] => {
  const rows: TimelineRow[] = [];
  let index = 0;

  while (index < timeline.length) {
    const entry = timeline[index];
    if (!["explore", "command", "thought"].includes(entry.kind)) {
      rows.push({ kind: "entry", entry, index });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < timeline.length && ["explore", "command", "thought"].includes(timeline[end].kind)) {
      end += 1;
    }
    const segment = timeline.slice(index, end);
    const explorationEntries = segment.filter((item) => item.kind === "explore" || item.kind === "command");
    if (!explorationEntries.length) {
      segment.forEach((item, offset) =>
        rows.push({ kind: "entry", entry: item, index: index + offset }),
      );
      index = end;
      continue;
    }

    const lastExplorationId = explorationEntries.at(-1)?.id;
    for (let offset = 0; offset < segment.length; offset += 1) {
      const item = segment[offset];
      if (item.kind === "thought") {
        rows.push({ kind: "entry", entry: item, index: index + offset });
      } else if (item.id === lastExplorationId) {
        rows.push({ kind: "exploration", entries: explorationEntries, index: index + offset });
      }
    }
    index = end;
  }

  return rows;
};

export function TaskTimeline({
  timeline,
  runtime,
  showReasoningSummaries,
  expandToolOutput,
  historyLoading,
  historyHasMore,
  canFork,
  onForkTask,
  taskId,
  onResolveApproval,
  onReviewChanges,
  canUndo,
  undoing,
  onUndo,
  historyLoadingOlder,
  onLoadOlderHistory,
}: TaskTimelineProps) {
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].kind === "user" || timeline[index].kind === "brief") {
      latestUserIndex = index;
      break;
    }
  }
  const displayTimeline = useMemo(
    () => compactTimelineChanges(timeline, taskWorking ? latestUserIndex : undefined),
    [latestUserIndex, taskWorking, timeline],
  );
  const rows = useMemo(() => timelineRows(displayTimeline), [displayTimeline]);
  const latestChangeId = [...displayTimeline].reverse().find((entry) => entry.kind === "change")?.id;
  return (
    <div className="timeline" aria-live="polite">
      {historyLoading ? (
        <div className="timeline__history-loading">Loading earlier task activity…</div>
      ) : null}
      {!historyLoading && historyHasMore ? (
        <button className="timeline__load-earlier" type="button" disabled={historyLoadingOlder} onClick={() => void onLoadOlderHistory()}>
          {historyLoadingOlder ? "Loading earlier activity" : "Show earlier activity"}
          <small>Load from local history</small>
        </button>
      ) : null}
      {!displayTimeline.length && !historyLoading ? (
        <div className="timeline__empty">
          <span className="timeline__empty-mark"><XiaoIcon name="command" size={22} /></span>
          <h2>What are we building?</h2>
          <p>Describe the outcome below. Xiao will keep the work, commands, and changes in this task.</p>
        </div>
      ) : null}
      {rows.map((row) =>
        row.kind === "exploration" ? (
          <ExplorationGroup
            entries={row.entries}
            expandByDefault={expandToolOutput}
            index={row.index}
            key={`exploration-${row.entries.map((entry) => entry.id).join("-")}`}
          />
        ) : (
          <div className="timeline-anchor" id={`timeline-entry-${row.entry.id}`} key={row.entry.id}>
            <ActivityItem
              entry={row.entry}
              index={row.index}
              showReasoningSummaries={showReasoningSummaries}
              expandToolOutput={expandToolOutput}
              taskId={taskId}
              onResolveApproval={onResolveApproval}
              onReviewChanges={onReviewChanges}
              canFork={canFork}
              onForkTask={onForkTask}
              canUndo={canUndo && row.entry.id === latestChangeId}
              undoing={undoing && row.entry.id === latestChangeId}
              onUndo={onUndo}
            />
          </div>
        ),
      )}
      <LiveTurnStatus taskId={taskId} runtime={runtime} timeline={timeline} />
    </div>
  );
}
