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
  historyHasMore: boolean;
  historyLoadingOlder: boolean;
  onLoadOlderHistory: () => void;
};

type TimelineRow =
  | { kind: "entry"; entry: TimelineEntry; index: number }
  | { kind: "exploration"; entries: TimelineEntry[]; index: number };

const timelineRows = (timeline: TimelineEntry[]): TimelineRow[] => {
  const rows: TimelineRow[] = [];
  let index = 0;

  while (index < timeline.length) {
    const entry = timeline[index];
    if (entry.kind !== "explore" && entry.kind !== "thought") {
      rows.push({ kind: "entry", entry, index });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < timeline.length && ["explore", "thought"].includes(timeline[end].kind)) {
      end += 1;
    }
    const segment = timeline.slice(index, end);
    const explorationEntries = segment.filter((item) => item.kind === "explore");
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
  taskId,
  onResolveApproval,
  onReviewChanges,
  canUndo,
  undoing,
  onUndo,
  historyHasMore,
  historyLoadingOlder,
  onLoadOlderHistory,
}: TaskTimelineProps) {
  const rows = timelineRows(timeline);
  const latestChangeId = [...timeline].reverse().find((entry) => entry.kind === "change")?.id;
  return (
    <div className="timeline" aria-live="polite">
      {historyHasMore ? (
        <button
          className="timeline__load-older"
          type="button"
          disabled={historyLoadingOlder}
          onClick={onLoadOlderHistory}
        >
          <XiaoIcon className={historyLoadingOlder ? "spin" : undefined} name={historyLoadingOlder ? "pending" : "archive"} size={14} />
          {historyLoadingOlder ? "Loading older messages" : "Load older messages"}
        </button>
      ) : null}
      {!timeline.length ? (
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
          <ActivityItem
            entry={row.entry}
            index={row.index}
            showReasoningSummaries={showReasoningSummaries}
            expandToolOutput={expandToolOutput}
            key={row.entry.id}
            taskId={taskId}
            onResolveApproval={onResolveApproval}
            onReviewChanges={onReviewChanges}
            canUndo={canUndo && row.entry.id === latestChangeId}
            undoing={undoing && row.entry.id === latestChangeId}
            onUndo={onUndo}
          />
        ),
      )}
      <LiveTurnStatus taskId={taskId} runtime={runtime} timeline={timeline} />
    </div>
  );
}
