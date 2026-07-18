import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type {
  CreateRoutineRequest,
  RoutineSummary,
  RoutineUpdateEnvelope,
  UpdateRoutineRequest,
} from "../../../core/models/routine";
import {
  applyRoutineUpdate,
  applyWorkspaceRoutineUpdate,
  emptyRoutineProjection,
  mergeRoutineList,
  routineProjectionValues,
  upsertRoutine,
} from "../routineProjection";

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function useRoutines(workspacePath: string) {
  const workspaceGeneration = useRef({ path: workspacePath, value: 0 });
  if (workspaceGeneration.current.path !== workspacePath) {
    workspaceGeneration.current = {
      path: workspacePath,
      value: workspaceGeneration.current.value + 1,
    };
  }
  const [projection, setProjection] = useState(emptyRoutineProjection);
  const [loading, setLoading] = useState(isTauriHost);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setProjection(emptyRoutineProjection());
    setError(null);
    setBusyIds(new Set());
    if (!isTauriHost()) {
      setLoading(false);
      return;
    }

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    setLoading(true);
    const initialize = async () => {
      try {
        const removeUpdate = await listen<RoutineUpdateEnvelope>(
          "xiao://routine-update",
          (event) => {
            if (disposed) return;
            const update = event.payload;
            setProjection((current) =>
              applyWorkspaceRoutineUpdate(current, workspacePath, update),
            );
          },
        );
        if (disposed) removeUpdate();
        else unlisteners.push(removeUpdate);

        const removeError = await listen<string>("xiao://routine-service-error", (event) => {
          if (!disposed) setError(event.payload);
        });
        if (disposed) removeError();
        else unlisteners.push(removeError);

        const routines = await nativeBridge.listXiaoRoutines(workspacePath);
        if (disposed) return;
        setProjection((current) => mergeRoutineList(current, routines));
        setLoading(false);
      } catch (reason) {
        if (disposed) return;
        setLoading(false);
        setError(errorMessage(reason));
      }
    };
    void initialize();

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [workspacePath]);

  const runMutation = useCallback(async <T extends RoutineSummary | void>(
    busyId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const generation = workspaceGeneration.current.value;
    setError(null);
    setBusyIds((current) => new Set(current).add(busyId));
    try {
      const result = await operation();
      if (result && workspaceGeneration.current.value === generation) {
        setProjection((current) => upsertRoutine(current, result));
      }
      return result;
    } catch (reason) {
      if (workspaceGeneration.current.value === generation) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (workspaceGeneration.current.value === generation) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(busyId);
          return next;
        });
      }
    }
  }, []);

  const create = useCallback(
    (request: CreateRoutineRequest) =>
      runMutation("create", () => nativeBridge.createXiaoRoutine(request)),
    [runMutation],
  );

  const update = useCallback(
    (request: UpdateRoutineRequest) =>
      runMutation(request.routineId, () => nativeBridge.updateXiaoRoutine(request)),
    [runMutation],
  );

  const setEnabled = useCallback(
    (routineId: string, enabled: boolean) =>
      runMutation(routineId, () => nativeBridge.setXiaoRoutineEnabled(routineId, enabled)),
    [runMutation],
  );

  const runNow = useCallback(
    (routineId: string) =>
      runMutation(
        routineId,
        () => nativeBridge.runXiaoRoutineNow(routineId, crypto.randomUUID()),
      ),
    [runMutation],
  );

  const remove = useCallback(
    async (routineId: string) => {
      const operationWorkspace = workspacePath;
      await runMutation(routineId, () => nativeBridge.deleteXiaoRoutine(routineId));
      if (workspaceGeneration.current.path !== operationWorkspace) return;
      setProjection((current) => applyRoutineUpdate(current, {
        workspacePath,
        routine: null,
        deletedId: routineId,
      }));
    },
    [runMutation, workspacePath],
  );

  const routines = useMemo(() => routineProjectionValues(projection), [projection]);

  return {
    routines,
    loading,
    error,
    busyIds,
    creating: busyIds.has("create"),
    create,
    update,
    setEnabled,
    runNow,
    remove,
    clearError: () => setError(null),
  };
}
