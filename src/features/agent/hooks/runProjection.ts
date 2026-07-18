import type {
  PendingInputSnapshot,
  RunProtocolEnvelope,
  RunSnapshot,
  RunStatus,
  RunUpdateEnvelope,
} from "../../../core/models/run";

export type RunProjection = {
  runsById: Record<string, RunSnapshot>;
  runIdsByTask: Record<string, string[]>;
  pendingInputsById: Record<string, PendingInputSnapshot>;
  appliedProtocolSequencesByRun: Record<string, number[]>;
};

export const emptyRunProjection = (): RunProjection => ({
  runsById: {},
  runIdsByTask: {},
  pendingInputsById: {},
  appliedProtocolSequencesByRun: {},
});

const compareRuns = (left: RunSnapshot, right: RunSnapshot) =>
  right.queuedAt - left.queuedAt || right.id.localeCompare(left.id);

const addRunToTask = (
  projection: RunProjection,
  snapshot: RunSnapshot,
): Record<string, string[]> => {
  const current = projection.runIdsByTask[snapshot.taskId] ?? [];
  const ids = current.includes(snapshot.id) ? current : [...current, snapshot.id];
  ids.sort((left, right) => compareRuns(
    left === snapshot.id ? snapshot : projection.runsById[left],
    right === snapshot.id ? snapshot : projection.runsById[right],
  ));
  return { ...projection.runIdsByTask, [snapshot.taskId]: ids };
};

const shouldReplaceSnapshot = (current: RunSnapshot | undefined, next: RunSnapshot) => {
  if (!current) return true;
  if (next.version !== current.version) return next.version > current.version;
  const currentGeneration = current.runtimeGeneration ?? -1;
  const nextGeneration = next.runtimeGeneration ?? -1;
  return nextGeneration >= currentGeneration;
};

const withPendingInput = (
  current: Record<string, PendingInputSnapshot>,
  pending: PendingInputSnapshot | null,
) => {
  if (!pending) return current;
  const existing = current[pending.id];
  const existingSettledAt = existing
    ? Math.max(existing.resolvedAt ?? -1, existing.invalidatedAt ?? -1)
    : -1;
  const nextSettledAt = Math.max(pending.resolvedAt ?? -1, pending.invalidatedAt ?? -1);
  if (existingSettledAt >= 0 && nextSettledAt <= existingSettledAt) return current;
  return { ...current, [pending.id]: pending };
};

export const shouldRestorePendingInput = (
  projection: RunProjection,
  pending: PendingInputSnapshot,
) => {
  const current = projection.pendingInputsById[pending.id];
  return !current || (current.resolvedAt == null && current.invalidatedAt == null);
};

export const activePendingInputIdsForRestore = (
  projection: RunProjection,
  listed: PendingInputSnapshot[],
) => {
  const active = new Set(
    listed
      .filter((pending) => shouldRestorePendingInput(projection, pending))
      .map((pending) => pending.id),
  );
  for (const pending of Object.values(projection.pendingInputsById)) {
    if (pending.resolvedAt == null && pending.invalidatedAt == null) active.add(pending.id);
  }
  return active;
};

const withSequence = (
  current: Record<string, number[]>,
  runId: string,
  sequence: number | null | undefined,
) => {
  if (sequence == null) return current;
  const existing = current[runId] ?? [];
  if (existing.includes(sequence)) return current;
  return {
    ...current,
    [runId]: [...existing, sequence].sort((left, right) => left - right),
  };
};

export const projectRunSnapshots = (
  projection: RunProjection,
  snapshots: RunSnapshot[],
): RunProjection => snapshots.reduce(
  (current, snapshot) => projectRunUpdate(current, {
    snapshot,
    event: null,
    pendingInput: null,
  }),
  projection,
);

export const mergeListedRunSnapshots = (
  current: RunProjection,
  snapshots: RunSnapshot[],
) => projectRunSnapshots(current, snapshots);

export const projectRunUpdate = (
  projection: RunProjection,
  update: RunUpdateEnvelope,
): RunProjection => {
  const current = projection.runsById[update.snapshot.id];
  if (!shouldReplaceSnapshot(current, update.snapshot)) {
    return {
      ...projection,
      pendingInputsById: withPendingInput(projection.pendingInputsById, update.pendingInput),
    };
  }
  const runsById = { ...projection.runsById, [update.snapshot.id]: update.snapshot };
  return {
    ...projection,
    runsById,
    runIdsByTask: addRunToTask({ ...projection, runsById }, update.snapshot),
    pendingInputsById: withPendingInput(projection.pendingInputsById, update.pendingInput),
  };
};

export const acceptRunProtocol = (
  projection: RunProjection,
  envelope: RunProtocolEnvelope,
): { projection: RunProjection; accepted: boolean } => {
  const run = projection.runsById[envelope.runId];
  if (
    !run ||
    run.taskId !== envelope.taskId ||
    run.executionEnvironmentId !== envelope.executionEnvironmentId ||
    run.runtimeGeneration !== envelope.runtimeGeneration ||
    (run.threadId != null && run.threadId !== envelope.threadId) ||
    (run.turnId != null && envelope.turnId != null && run.turnId !== envelope.turnId)
  ) {
    return { projection, accepted: false };
  }
  const applied = projection.appliedProtocolSequencesByRun[envelope.runId] ?? [];
  if (envelope.sequence != null && applied.includes(envelope.sequence)) {
    return { projection, accepted: false };
  }
  return {
    accepted: true,
    projection: {
      ...projection,
      pendingInputsById: withPendingInput(
        projection.pendingInputsById,
        envelope.pendingInput,
      ),
      appliedProtocolSequencesByRun: withSequence(
        projection.appliedProtocolSequencesByRun,
        envelope.runId,
        envelope.sequence,
      ),
    },
  };
};

export const runsForTask = (projection: RunProjection, taskId: string) =>
  (projection.runIdsByTask[taskId] ?? [])
    .flatMap((id) => projection.runsById[id] ? [projection.runsById[id]] : []);

export const latestRunForTask = (projection: RunProjection, taskId: string) =>
  runsForTask(projection, taskId)[0] ?? null;

export const activeRunForTask = (projection: RunProjection, taskId: string) => {
  const active = runsForTask(projection, taskId).filter((run) => runStatusIsActive(run.status));
  return active.find((run) => run.status !== "queued")
    ?? active.filter((run) => run.status === "queued").at(-1)
    ?? null;
};

export const runStatusIsActive = (status: RunStatus) =>
  status === "queued" ||
  status === "preparing" ||
  status === "running" ||
  status === "waiting_for_input" ||
  status === "verifying";
