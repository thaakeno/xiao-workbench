import { describe, expect, it } from "vitest";

import type {
  PendingInputSnapshot,
  RunProtocolEnvelope,
  RunSnapshot,
  RunUpdateEnvelope,
} from "../../../core/models/run";
import {
  acceptRunProtocol,
  activePendingInputIdsForRestore,
  activeRunForTask,
  emptyRunProjection,
  latestRunForTask,
  mergeListedRunSnapshots,
  projectRunSnapshots,
  projectRunUpdate,
  runsForTask,
  shouldRestorePendingInput,
} from "./runProjection";

const run = (patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: "run-a",
  workspacePath: "C:/workspace",
  taskId: "task-a",
  idempotencyKey: "key-a",
  parentRunId: null,
  candidateGroupId: null,
  routineOccurrenceId: null,
  status: "queued",
  agentOutcome: "pending",
  verificationOutcome: "not_requested",
  executionEnvironmentId: "environment-a",
  executionRoot: "C:/workspace",
  managedWorktreeId: null,
  prompt: "Do work",
  model: "gpt-test",
  reasoningEffort: "medium",
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
  queuedAt: 10,
  startedAt: null,
  finishedAt: null,
  version: 0,
  ...patch,
});

const update = (
  snapshot: RunSnapshot,
  sequence: number | null = null,
): RunUpdateEnvelope => ({
  snapshot,
  event: sequence == null ? null : {
    runId: snapshot.id,
    sequence,
    timestamp: 20,
    eventType: "run.updated",
    eventKey: `event-${sequence}`,
    safePayload: {},
  },
  pendingInput: null,
});

const protocol = (patch: Partial<RunProtocolEnvelope> = {}): RunProtocolEnvelope => ({
  runId: "run-a",
  taskId: "task-a",
  executionEnvironmentId: "environment-a",
  runtimeGeneration: 2,
  threadId: "thread-a",
  turnId: "turn-a",
  itemId: "item-a",
  sequence: 4,
  message: { method: "item/completed", params: {} },
  turnDiff: null,
  pendingInput: null,
  ...patch,
});

const pendingInput = (
  patch: Partial<PendingInputSnapshot> = {},
): PendingInputSnapshot => ({
  id: "pending-a",
  runId: "run-a",
  runtimeGeneration: 2,
  requestId: "1",
  threadId: "thread-a",
  turnId: "turn-a",
  itemId: "item-a",
  kind: "question",
  safeSummary: {},
  openedAt: 20,
  resolvedAt: null,
  invalidatedAt: null,
  ...patch,
});

describe("native run projection", () => {
  it("keeps the newest snapshot when updates arrive out of order", () => {
    const newest = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 3,
    });
    const projection = projectRunUpdate(
      projectRunUpdate(emptyRunProjection(), update(newest, 3)),
      update(run({ status: "preparing", version: 1 }), 1),
    );

    expect(latestRunForTask(projection, "task-a")).toEqual(newest);
  });

  it("does not let a delayed run list overwrite a newer live update", () => {
    const staleListSnapshot = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    const terminalLiveSnapshot = run({
      status: "completed",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      finishedAt: 30,
      version: 3,
    });
    const afterLiveUpdate = projectRunUpdate(
      emptyRunProjection(),
      update(terminalLiveSnapshot, 3),
    );

    const restored = mergeListedRunSnapshots(afterLiveUpdate, [staleListSnapshot]);

    expect(latestRunForTask(restored, "task-a")).toEqual(terminalLiveSnapshot);
  });

  it("deduplicates persisted protocol sequences but accepts out-of-order uniques", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    let projection = projectRunSnapshots(emptyRunProjection(), [running]);
    const later = acceptRunProtocol(projection, protocol({ sequence: 8 }));
    expect(later.accepted).toBe(true);
    projection = later.projection;

    const earlier = acceptRunProtocol(projection, protocol({ sequence: 4 }));
    expect(earlier.accepted).toBe(true);
    projection = earlier.projection;

    const duplicate = acceptRunProtocol(projection, protocol({ sequence: 8 }));
    expect(duplicate.accepted).toBe(false);
    expect(projection.appliedProtocolSequencesByRun["run-a"]).toEqual([4, 8]);
  });

  it("continues rejecting old duplicate sequences after a long run", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 2,
    });
    let projection = projectRunSnapshots(emptyRunProjection(), [running]);
    for (let sequence = 1; sequence <= 401; sequence += 1) {
      const accepted = acceptRunProtocol(projection, protocol({ sequence }));
      expect(accepted.accepted).toBe(true);
      projection = accepted.projection;
    }

    expect(acceptRunProtocol(projection, protocol({ sequence: 1 })).accepted).toBe(false);
  });

  it("never reopens a settled pending input from stale updates or restore data", () => {
    const running = run({
      status: "running",
      runtimeGeneration: 2,
      threadId: "thread-a",
      turnId: "turn-a",
      version: 3,
    });
    const settled = pendingInput({ resolvedAt: 30 });
    let projection = projectRunUpdate(emptyRunProjection(), {
      ...update(running, 3),
      pendingInput: settled,
    });
    projection = projectRunUpdate(projection, {
      ...update(run({ status: "waiting_for_input", version: 2 }), 2),
      pendingInput: pendingInput(),
    });

    expect(projection.pendingInputsById[settled.id]).toEqual(settled);
    expect(shouldRestorePendingInput(projection, pendingInput())).toBe(false);
  });

  it("merges live pending inputs into restore while excluding settled list rows", () => {
    const settled = pendingInput({ id: "settled", resolvedAt: 30 });
    const live = pendingInput({ id: "live", requestId: "2" });
    let projection = projectRunUpdate(emptyRunProjection(), {
      ...update(run({ version: 3 }), 3),
      pendingInput: settled,
    });
    projection = projectRunUpdate(projection, {
      ...update(run({ version: 3 }), 4),
      pendingInput: live,
    });

    const ids = activePendingInputIdsForRestore(projection, [
      pendingInput({ id: "settled" }),
      pendingInput({ id: "listed", requestId: "3" }),
    ]);

    expect([...ids].sort()).toEqual(["listed", "live"]);
  });

  it("rejects stale generation, task, thread and turn envelopes", () => {
    const projection = projectRunSnapshots(emptyRunProjection(), [run({
      status: "running",
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-new",
      version: 3,
    })]);

    expect(acceptRunProtocol(projection, protocol()).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-old",
    })).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      runtimeGeneration: 3,
      threadId: "thread-other",
      turnId: "turn-new",
    })).accepted).toBe(false);
    expect(acceptRunProtocol(projection, protocol({
      taskId: "task-other",
      runtimeGeneration: 3,
      threadId: "thread-new",
      turnId: "turn-new",
    })).accepted).toBe(false);
  });

  it("keeps the executing run ahead of newer follow-ups and selects the oldest queued run", () => {
    const withRunning = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "running", idempotencyKey: "running", queuedAt: 1, status: "running" }),
      run({ id: "follow-up", idempotencyKey: "follow-up", queuedAt: 2 }),
    ]);
    expect(activeRunForTask(withRunning, "task-a")?.id).toBe("running");

    const queued = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "first", idempotencyKey: "first", queuedAt: 1 }),
      run({ id: "second", idempotencyKey: "second", queuedAt: 2 }),
    ]);
    expect(activeRunForTask(queued, "task-a")?.id).toBe("first");
  });

  it("projects concurrent tasks independently and serializes each task by recency", () => {
    const projection = projectRunSnapshots(emptyRunProjection(), [
      run({ id: "a-old", idempotencyKey: "a-old", queuedAt: 1 }),
      run({ id: "a-new", idempotencyKey: "a-new", queuedAt: 3, status: "running" }),
      run({
        id: "b",
        taskId: "task-b",
        idempotencyKey: "b",
        queuedAt: 2,
        status: "waiting_for_input",
      }),
    ]);

    expect(runsForTask(projection, "task-a").map((item) => item.id)).toEqual(["a-new", "a-old"]);
    expect(activeRunForTask(projection, "task-a")?.id).toBe("a-new");
    expect(activeRunForTask(projection, "task-b")?.id).toBe("b");
  });
});
