import { beforeEach, describe, expect, it } from "vitest";

import type { WorkbenchTask } from "../task/task.types";
import {
  readStartupProjects,
  readStartupTaskState,
  writeStartupProjects,
  writeStartupTaskState,
} from "./startupCache";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  },
  configurable: true,
});

const task = (): WorkbenchTask => ({
  id: "task-a", title: "Cached", meta: "Now", group: "Recent", archived: false,
  pinned: false, unread: false, createdAt: 1, updatedAt: 2, draftText: "draft",
  followUps: [], model: null, reasoningEffort: null, threadId: null, threadBinding: null,
  mode: "default", approvalPolicy: "on-request", sandboxMode: "workspace-write",
  goal: null, timeline: [{ id: "private", kind: "user", title: "not cached" }],
  timelineLoaded: true, timelineComplete: true, timelineStart: 0, timelineEntryCount: 1,
  plan: null, executionEnvironmentId: null, workspaceMode: "local", managedWorktreeId: null,
});

describe("startup cache", () => {
  beforeEach(() => storage.clear());

  it("keeps navigation metadata without duplicating timeline content", () => {
    writeStartupTaskState("D:\\Project", { tasks: [task()], activeTaskId: "task-a", showArchived: false });
    const cached = readStartupTaskState("d:/project/");
    expect(cached?.tasks[0].title).toBe("Cached");
    expect(cached?.tasks[0].timeline).toEqual([]);
    expect(cached?.tasks[0].timelineComplete).toBe(false);
  });

  it("rejects malformed project snapshots", () => {
    storage.set("xiao.startup.projects.v1", JSON.stringify([null, { path: 2 }]));
    expect(readStartupProjects()).toEqual([]);
    writeStartupProjects([{ path: "D:\\Project", name: "Project", updatedAt: 2, taskCount: 1 }]);
    expect(readStartupProjects()).toHaveLength(1);
  });
});
