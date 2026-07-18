import type { AgentAttachment } from "../../core/models/agent";
import { completeTimelineMetadata } from "./taskPersistence";
import type { WorkbenchTask } from "./task.types";

const forkTitle = (title: string) => {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/);
  if (!match) return `${title} (fork #1)`;
  return `${match[1]} (fork #${Number(match[2]) + 1})`;
};

export const forkTaskFromEntry = (
  source: WorkbenchTask,
  entryId: string,
  identity: { id: string; createdAt: number },
): { task: WorkbenchTask; attachments: AgentAttachment[] } | null => {
  const entryIndex = source.timeline.findIndex((entry) => entry.id === entryId);
  const selectedEntry = source.timeline[entryIndex];
  if (entryIndex < 0 || selectedEntry?.kind !== "user" || !selectedEntry.title.trim()) return null;

  const timeline = source.timeline.slice(0, entryIndex).map((entry) => {
    const copy = { ...entry };
    delete copy.turnDiff;
    return copy;
  });
  const attachments = (selectedEntry.attachments ?? []).map((attachment) => ({ ...attachment }));

  return {
    task: completeTimelineMetadata({
      ...source,
      id: identity.id,
      title: forkTitle(source.title),
      meta: "Draft",
      group: "Active",
      archived: false,
      pinned: false,
      unread: false,
      createdAt: identity.createdAt,
      updatedAt: identity.createdAt,
      draftText: selectedEntry.title,
      followUps: [],
      threadId: null,
      threadBinding: null,
      executionEnvironmentId: null,
      workspaceMode: "local",
      managedWorktreeId: null,
      goal: source.goal ? { ...source.goal } : null,
      timeline,
      plan: null,
    }),
    attachments,
  };
};
