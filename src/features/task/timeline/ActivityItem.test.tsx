import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { ActivityItem } from "./ActivityItem";
import { statusLabel } from "./LiveTurnStatus";

const renderCompaction = (entry: TimelineEntry) => renderToStaticMarkup(
  <ActivityItem
    entry={entry}
    index={0}
    showReasoningSummaries
    expandToolOutput={false}
    taskId="task-1"
    canFork={false}
    onForkTask={() => undefined}
    onResolveApproval={async () => undefined}
    onReviewChanges={() => undefined}
    canUndo={false}
    undoing={false}
    onUndo={() => undefined}
  />,
);

describe("ActivityItem user message", () => {
  it("shows the fork action only while forking is available", () => {
    const entry: TimelineEntry = {
      id: "user-1",
      kind: "user",
      title: "Try another approach",
      status: "success",
    };
    const renderUser = (canFork: boolean) => renderToStaticMarkup(
      <ActivityItem
        entry={entry}
        index={0}
        showReasoningSummaries
        expandToolOutput={false}
        taskId="task-1"
        canFork={canFork}
        onForkTask={() => undefined}
        onResolveApproval={async () => undefined}
        onReviewChanges={() => undefined}
      />,
    );

    expect(renderUser(true)).toContain("Fork from here");
    expect(renderUser(false)).not.toContain("Fork from here");
  });
});

describe("ActivityItem context compaction", () => {
  it("renders the active compaction animation hook", () => {
    const markup = renderCompaction({
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      createdAt: 1,
      meta: "Context",
      status: "active",
    });

    expect(markup).toContain("activity--context-compaction activity--active");
    expect(markup).toContain("context-compaction__glyph");
    expect(markup).toContain("Compacting context");
    expect(statusLabel([{
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      createdAt: 1,
      meta: "Context",
      status: "active",
    }])).toBe("Compacting context");
  });

  it("settles the same marker into its completed state", () => {
    const markup = renderCompaction({
      id: "compact-1",
      kind: "result",
      title: "Context compacted",
      createdAt: 1,
      meta: "Context",
      status: "success",
    });

    expect(markup).toContain("activity--context-compaction activity--success");
    expect(markup).toContain("context-compaction__state--success");
    expect(markup).toContain("Context compacted");
  });
});
