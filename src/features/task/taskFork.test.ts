import { describe, expect, it } from "vitest";

import type { WorkbenchTask } from "./task.types";
import { forkTaskFromEntry } from "./taskFork";

const sourceTask = (): WorkbenchTask => ({
  id: "source-task",
  title: "Build session controls",
  meta: "Now",
  group: "Active",
  archived: true,
  pinned: true,
  unread: true,
  createdAt: 10,
  updatedAt: 20,
  draftText: "unsent source draft",
  followUps: [{ id: "follow-up", prompt: "Later", attachments: [], createdAt: 30 }],
  model: "gpt-test",
  reasoningEffort: "high",
  threadId: "thread-source",
  threadBinding: {
    threadId: "thread-source",
    persistence: "ephemeral",
    materialized: false,
    threadSource: "xiao-workbench",
    cliVersion: null,
  },
  mode: "plan",
  approvalPolicy: "untrusted",
  sandboxMode: "read-only",
  goal: { objective: "Ship safely", status: "active" },
  timeline: [
    {
      id: "user-1",
      kind: "user",
      title: "Build the first version",
      turnId: "turn-1",
      turnDiff: "patch-one",
      status: "success",
    },
    {
      id: "agent-1",
      kind: "result",
      title: "Agent response",
      body: "First version complete.",
      turnId: "turn-1",
      status: "success",
    },
    {
      id: "user-2",
      kind: "user",
      title: "Try a different interaction",
      turnId: "turn-2",
      turnDiff: "patch-two",
      status: "success",
      attachments: [
        { id: "file-1", name: "App.tsx", path: "src/App.tsx", kind: "file" },
        {
          id: "review-1",
          name: "Review App.tsx",
          path: "src/App.tsx",
          kind: "review",
          lineStart: 10,
          lineEnd: 12,
          comment: "Keep this compact",
        },
      ],
    },
    {
      id: "agent-2",
      kind: "result",
      title: "Agent response",
      body: "Second version complete.",
      turnId: "turn-2",
      status: "success",
    },
  ],
  timelineLoaded: true,
  timelineComplete: true,
  timelineStart: 0,
  timelineEntryCount: 4,
  plan: { explanation: "Current plan", steps: [{ step: "Implement", status: "completed" }] },
  executionEnvironmentId: "environment-source",
  workspaceMode: "managed-worktree",
  managedWorktreeId: "worktree-source",
});

describe("forkTaskFromEntry", () => {
  it("creates an isolated draft from history before the selected prompt", () => {
    const source = sourceTask();
    const fork = forkTaskFromEntry(source, "user-2", {
      id: "fork-task",
      createdAt: 100,
    });

    expect(fork).not.toBeNull();
    expect(fork?.task).toMatchObject({
      id: "fork-task",
      title: "Build session controls (fork #1)",
      meta: "Draft",
      group: "Active",
      archived: false,
      pinned: false,
      unread: false,
      createdAt: 100,
      updatedAt: 100,
      draftText: "Try a different interaction",
      followUps: [],
      model: "gpt-test",
      reasoningEffort: "high",
      threadId: null,
      threadBinding: null,
      timelineLoaded: true,
      timelineComplete: true,
      timelineStart: 0,
      timelineEntryCount: 2,
      executionEnvironmentId: null,
      workspaceMode: "local",
      managedWorktreeId: null,
      mode: "plan",
      approvalPolicy: "untrusted",
      sandboxMode: "read-only",
      goal: { objective: "Ship safely", status: "active" },
      plan: null,
    });
    expect(fork?.task.timeline.map((entry) => entry.id)).toEqual(["user-1", "agent-1"]);
    expect(fork?.task.timeline[0]).not.toHaveProperty("turnDiff");
    expect(source.timeline[0]).toHaveProperty("turnDiff", "patch-one");
    expect(fork?.attachments).toEqual(source.timeline[2].attachments);
    expect(fork?.attachments[0]).not.toBe(source.timeline[2].attachments?.[0]);
  });

  it("increments an existing fork suffix", () => {
    const source = sourceTask();
    source.title = "Build session controls (fork #2)";

    expect(forkTaskFromEntry(source, "user-1", { id: "fork", createdAt: 100 })?.task.title)
      .toBe("Build session controls (fork #3)");
  });

  it("rejects missing and non-user timeline entries", () => {
    const source = sourceTask();

    expect(forkTaskFromEntry(source, "agent-1", { id: "fork", createdAt: 100 })).toBeNull();
    expect(forkTaskFromEntry(source, "missing", { id: "fork", createdAt: 100 })).toBeNull();
  });
});
