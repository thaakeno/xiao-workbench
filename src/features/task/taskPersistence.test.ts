import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../core/models/agent";
import type { XiaoTimelinePage } from "../../core/models/xiao";
import { completeTimelineMetadata, mergeTimelinePage, toXiaoTaskDocument } from "./taskPersistence";
import type { WorkbenchTask } from "./task.types";

const entry = (id: string): TimelineEntry => ({
  id,
  kind: "result",
  title: id,
});

const task = (): WorkbenchTask => ({
  id: "task-1",
  title: "Task",
  meta: "Now",
  group: "Active",
  archived: false,
  pinned: false,
  unread: false,
  createdAt: 1,
  updatedAt: 2,
  draftText: "draft",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: "runtime-thread",
  threadBinding: {
    threadId: "runtime-thread",
    persistence: "ephemeral",
    materialized: false,
    threadSource: "xiao-workbench",
    cliVersion: null,
  },
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  goal: null,
  timeline: [entry("event-3"), entry("event-4")],
  timelineLoaded: true,
  timelineComplete: false,
  timelineStart: 2,
  timelineEntryCount: 4,
  plan: null,
  executionEnvironmentId: "environment-1",
  workspaceMode: "local",
  managedWorktreeId: null,
});

const page = (entries: TimelineEntry[], start: number, total: number, hasMore: boolean): XiaoTimelinePage => ({
  entries,
  start,
  total,
  hasMore,
});

describe("task persistence", () => {
  it("does not serialize the process-local runtime thread as an active session", () => {
    const document = toXiaoTaskDocument(task());

    expect(document.threadId).toBeNull();
    expect(document.threadBinding).toMatchObject({
      threadId: "runtime-thread",
      persistence: "ephemeral",
    });
    expect(document.timelineComplete).toBe(false);
    expect(document.timelineEntryCount).toBe(4);
    expect(document.executionEnvironmentId).toBe("environment-1");
    expect(document.workspaceMode).toBe("local");
    expect(document.managedWorktreeId).toBeNull();
  });

  it("omits an unchanged timeline from metadata-only updates", () => {
    const document = toXiaoTaskDocument(task(), false);

    expect(document.timeline).toEqual([]);
    expect(document.timelineLoaded).toBe(false);
    expect(document.timelineComplete).toBe(false);
    expect(document.timelineEntryCount).toBe(4);
  });

  it("loads the latest bounded page into an unloaded task", () => {
    const unloaded = {
      ...task(),
      timeline: [],
      timelineLoaded: false,
      timelineStart: 4,
    };

    const merged = mergeTimelinePage(
      unloaded,
      page([entry("event-3"), entry("event-4")], 2, 4, true),
    );

    expect(merged.timeline.map((item) => item.id)).toEqual(["event-3", "event-4"]);
    expect(merged.timelineLoaded).toBe(true);
    expect(merged.timelineComplete).toBe(false);
    expect(merged.timelineStart).toBe(2);
  });

  it("prepends an older page in stable order without duplicate IDs", () => {
    const merged = mergeTimelinePage(
      task(),
      page([entry("event-1"), entry("event-2"), entry("event-3")], 0, 4, false),
    );

    expect(merged.timeline.map((item) => item.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
    expect(merged.timelineComplete).toBe(true);
    expect(merged.timelineStart).toBe(0);
  });

  it("marks locally-created timelines as complete", () => {
    const completed = completeTimelineMetadata({ ...task(), timeline: [entry("one")] });

    expect(completed).toMatchObject({
      timelineLoaded: true,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 1,
    });
  });
});
