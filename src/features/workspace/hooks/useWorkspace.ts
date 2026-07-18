import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type { SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";

const browserSystem: SystemInfo = {
  platform: "Browser preview",
  shell: "Native bridge unavailable",
  codexVersion: null,
};

const browserWorkspace: WorkspaceSnapshot = {
  name: "Browser preview",
  path: "Native workspace unavailable",
  execution: {
    projectPath: "Native workspace unavailable",
    executionRoot: "Native workspace unavailable",
    environment: {
      id: "browser-preview",
      kind: "windows",
      label: "Browser preview",
      availability: "unavailable",
    },
    workspaceMode: "local",
    managedWorktree: null,
    isolationAvailable: false,
    isolationUnavailableReason: "Managed worktrees require the native Xiao app.",
  },
  files: [],
  git: null,
};

export function useWorkspace(path?: string, taskId?: string | null) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(browserWorkspace);
  const [system, setSystem] = useState<SystemInfo>(browserSystem);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const requestedPath = useRef(path);
  const requestedTaskId = useRef(taskId);

  useLayoutEffect(() => {
    requestedPath.current = path;
    requestedTaskId.current = taskId;
  }, [path, taskId]);

  const refresh = useCallback(async () => {
    if (requestedPath.current !== path || requestedTaskId.current !== taskId) return;
    const requestId = ++refreshId.current;
    const isCurrentRequest = () =>
      requestId === refreshId.current &&
      requestedPath.current === path &&
      requestedTaskId.current === taskId;
    if (!isTauriHost()) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [nextWorkspace, nextSystem] = await Promise.all([
        nativeBridge.getWorkspace(path, taskId),
        nativeBridge.getSystemInfo(),
      ]);
      if (!isCurrentRequest()) return;
      setWorkspace(nextWorkspace);
      setSystem(nextSystem);
    } catch (reason) {
      if (!isCurrentRequest()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [path, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadDirectory = useCallback(
    (relativePath: string) => {
      if (!isTauriHost()) {
        return Promise.reject(new Error("File browsing requires the native Xiao app."));
      }
      return nativeBridge.listWorkspaceFiles(workspace.path, taskId ?? null, relativePath);
    },
    [taskId, workspace.path],
  );

  return { workspace, system, loading, error, refresh, loadDirectory };
}
