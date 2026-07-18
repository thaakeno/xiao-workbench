import type { XiaoTaskDocument, XiaoTimelinePage } from "../../core/models/xiao";
import type { WorkbenchTask } from "./task.types";

export const completeTimelineMetadata = <T extends { timeline: unknown[] }>(task: T) => ({
  ...task,
  timelineLoaded: true,
  timelineComplete: true,
  timelineStart: 0,
  timelineEntryCount: task.timeline.length,
});

export const toXiaoTaskDocument = (
  task: WorkbenchTask,
  includeTimeline = true,
): XiaoTaskDocument => {
  const { meta: _meta, group: _group, threadId: _runtimeThreadId, ...document } = task;
  if (!includeTimeline) {
    return {
      ...document,
      threadId: null,
      timeline: [],
      timelineLoaded: false,
      timelineComplete: false,
      timelineStart: task.timelineEntryCount,
      timelineEntryCount: task.timelineEntryCount,
    };
  }
  return {
    ...document,
    threadId: null,
    timelineEntryCount: task.timelineComplete
      ? task.timeline.length
      : task.timelineEntryCount,
  };
};

export const mergeTimelinePage = (
  task: WorkbenchTask,
  page: XiaoTimelinePage,
): WorkbenchTask => {
  const currentEntries = task.timelineLoaded ? task.timeline : [];
  const currentIds = new Set(currentEntries.map((entry) => entry.id));
  const timeline = [
    ...page.entries.filter((entry) => !currentIds.has(entry.id)),
    ...currentEntries,
  ];
  return {
    ...task,
    timeline,
    timelineLoaded: true,
    timelineComplete: !page.hasMore,
    timelineStart: page.start,
    timelineEntryCount: page.total,
  };
};
