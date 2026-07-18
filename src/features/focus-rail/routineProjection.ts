import type { RoutineSummary, RoutineUpdateEnvelope } from "../../core/models/routine";

export type RoutineProjection = {
  byId: Record<string, RoutineSummary>;
  deletedIds: ReadonlySet<string>;
};

export const emptyRoutineProjection = (): RoutineProjection => ({
  byId: {},
  deletedIds: new Set(),
});

const shouldReplaceRoutine = (current: RoutineSummary | undefined, next: RoutineSummary) =>
  !current ||
  next.version > current.version ||
  (next.version === current.version && next.updatedAt >= current.updatedAt);

const preserveNewerRunSnapshots = (
  current: RoutineSummary | undefined,
  next: RoutineSummary,
): RoutineSummary => {
  if (!current) return next;
  const currentOccurrences = new Map(
    current.history.map((occurrence) => [occurrence.id, occurrence]),
  );
  const history = next.history.map((occurrence) => {
    const currentRun = currentOccurrences.get(occurrence.id)?.run;
    if (!currentRun || !occurrence.run || currentRun.version <= occurrence.run.version) {
      return occurrence;
    }
    return { ...occurrence, run: currentRun };
  });
  return {
    ...next,
    history,
    lastStatus: history.find((occurrence) => occurrence.run)?.run?.status ?? next.lastStatus,
  };
};

export const upsertRoutine = (
  projection: RoutineProjection,
  routine: RoutineSummary,
  fromList = false,
): RoutineProjection => {
  if (fromList && projection.deletedIds.has(routine.id)) return projection;
  const current = projection.byId[routine.id];
  if (!shouldReplaceRoutine(current, routine)) return projection;
  const nextRoutine = preserveNewerRunSnapshots(current, routine);
  const deletedIds = new Set(projection.deletedIds);
  if (!fromList) deletedIds.delete(routine.id);
  return {
    byId: { ...projection.byId, [routine.id]: nextRoutine },
    deletedIds,
  };
};

export const mergeRoutineList = (
  projection: RoutineProjection,
  routines: RoutineSummary[],
): RoutineProjection =>
  routines.reduce(
    (current, routine) => upsertRoutine(current, routine, true),
    projection,
  );

const comparableWorkspacePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase();

export const applyRoutineUpdate = (
  projection: RoutineProjection,
  update: RoutineUpdateEnvelope,
): RoutineProjection => {
  if (update.deletedId) {
    const { [update.deletedId]: _deleted, ...byId } = projection.byId;
    const deletedIds = new Set(projection.deletedIds);
    deletedIds.add(update.deletedId);
    return { byId, deletedIds };
  }
  return update.routine ? upsertRoutine(projection, update.routine) : projection;
};

export const applyWorkspaceRoutineUpdate = (
  projection: RoutineProjection,
  workspacePath: string,
  update: RoutineUpdateEnvelope,
): RoutineProjection =>
  update.workspacePath &&
  comparableWorkspacePath(update.workspacePath) !== comparableWorkspacePath(workspacePath)
    ? projection
    : applyRoutineUpdate(projection, update);

export const routineProjectionValues = (projection: RoutineProjection) =>
  Object.values(projection.byId).sort(
    (left, right) =>
      Number(right.enabled) - Number(left.enabled) ||
      right.updatedAt - left.updatedAt ||
      right.id.localeCompare(left.id),
  );
