import { describe, expect, it } from "vitest";

import type { RoutineSummary } from "../../core/models/routine";
import type { RunSnapshot, RunStatus } from "../../core/models/run";
import {
  applyRoutineUpdate,
  applyWorkspaceRoutineUpdate,
  emptyRoutineProjection,
  mergeRoutineList,
  routineProjectionValues,
  upsertRoutine,
} from "./routineProjection";

const run = (version: number, status: RunStatus): RunSnapshot => ({
  id: "run-a",
  workspacePath: "C:/project",
  taskId: "task-a",
  idempotencyKey: "key-a",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: "occurrence-a",
  status,
  agentOutcome: status === "completed" ? "completed" : "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "environment-a",
  executionRoot: "C:/project",
  managedWorktreeId: null,
  prompt: "Review the workspace",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  threadId: null,
  threadSource: null,
  cliVersion: null,
  runtimeGeneration: null,
  turnId: null,
  cancelRequested: false,
  queuedAt: 1,
  startedAt: null,
  finishedAt: null,
  version,
});

const routine = (patch: Partial<RoutineSummary> = {}): RoutineSummary => ({
  id: "routine-a",
  workspacePath: "C:/project",
  taskId: "task-a",
  title: "Daily review",
  prompt: "Review the workspace",
  scheduleKind: "daily",
  timezone: "UTC",
  scheduledFor: null,
  dailyTime: "09:00",
  missedRunPolicy: "run_once",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  executionEnvironmentId: "environment-a",
  executionRoot: "C:/project",
  managedWorktreeId: null,
  workspaceMode: "local",
  enabled: true,
  nextRunAt: 100,
  lastRunAt: null,
  lastError: null,
  isolationWarning: null,
  lastStatus: null,
  history: [],
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("routine projection", () => {
  it("does not let stale snapshots replace newer native state", () => {
    const current = upsertRoutine(emptyRoutineProjection(), routine({ version: 3, enabled: false }));
    const stale = upsertRoutine(current, routine({ version: 2, enabled: true }));
    expect(stale.byId["routine-a"]?.enabled).toBe(false);
    expect(stale.byId["routine-a"]?.version).toBe(3);
  });

  it("preserves live updates that arrive before an initial list", () => {
    const live = upsertRoutine(emptyRoutineProjection(), routine({ version: 4, title: "Live" }));
    const listed = mergeRoutineList(live, [routine({ version: 2, title: "Listed" })]);
    expect(listed.byId["routine-a"]?.title).toBe("Live");
  });

  it("preserves a newer nested run snapshot from a stale list", () => {
    const occurrence = {
      id: "occurrence-a",
      scheduledFor: 100,
      triggerKind: "automatic" as const,
      status: "dispatched" as const,
    };
    const live = upsertRoutine(emptyRoutineProjection(), routine({
      history: [{ ...occurrence, run: run(4, "completed") }],
      lastStatus: "completed",
    }));
    const listed = mergeRoutineList(live, [routine({
      history: [{ ...occurrence, run: run(2, "running") }],
      lastStatus: "running",
    })]);
    expect(listed.byId["routine-a"]?.history[0]?.run?.version).toBe(4);
    expect(listed.byId["routine-a"]?.lastStatus).toBe("completed");
  });

  it("keeps deletion tombstones across a stale list response", () => {
    const current = upsertRoutine(emptyRoutineProjection(), routine());
    const removed = applyRoutineUpdate(current, {
      workspacePath: "C:/project",
      routine: null,
      deletedId: "routine-a",
    });
    const listed = mergeRoutineList(removed, [routine()]);
    expect(listed.byId["routine-a"]).toBeUndefined();
  });

  it("isolates native updates to the active workspace", () => {
    const projection = upsertRoutine(emptyRoutineProjection(), routine());
    const untouched = applyWorkspaceRoutineUpdate(projection, "C:/project", {
      workspacePath: "D:/other",
      routine: routine({ id: "routine-other", workspacePath: "D:/other" }),
      deletedId: null,
    });
    expect(untouched).toBe(projection);
    expect(untouched.byId["routine-other"]).toBeUndefined();
  });

  it("sorts enabled routines before newer disabled routines", () => {
    let projection = upsertRoutine(
      emptyRoutineProjection(),
      routine({ id: "disabled", enabled: false, updatedAt: 10 }),
    );
    projection = upsertRoutine(
      projection,
      routine({ id: "enabled", enabled: true, updatedAt: 1 }),
    );
    expect(routineProjectionValues(projection).map((item) => item.id)).toEqual([
      "enabled",
      "disabled",
    ]);
  });
});
