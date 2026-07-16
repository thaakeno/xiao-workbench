import { useLayoutEffect, useState } from "react";

import type {
  AgentApprovalPolicy,
  AgentMode,
  AgentSandboxMode,
} from "../../../core/models/agent";

export type TaskRunDefaults = {
  model: string | null;
  reasoningEffort: string | null;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
};

export type AppPreferences = {
  importCodexHistory: boolean;
  showChatExport: boolean;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  focusNewTasks: boolean;
  wrapCode: boolean;
  notifyCompletions: boolean;
  notifyErrors: boolean;
  notifyApprovals: boolean;
  hiddenModels: string[];
  taskRunDefaults: TaskRunDefaults;
};

const storageKey = "xiao.preferences.v1";

export const defaultTaskRunDefaults: TaskRunDefaults = {
  model: null,
  reasoningEffort: null,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
};

const defaults: AppPreferences = {
  importCodexHistory: true,
  showChatExport: true,
  showReasoningSummaries: true,
  expandToolOutput: false,
  focusNewTasks: true,
  wrapCode: false,
  notifyCompletions: true,
  notifyErrors: true,
  notifyApprovals: true,
  hiddenModels: [],
  taskRunDefaults: defaultTaskRunDefaults,
};

const normalizeTaskRunDefaults = (value: unknown): TaskRunDefaults => {
  const stored = value && typeof value === "object"
    ? value as Partial<TaskRunDefaults>
    : {};
  return {
    model: stored.model === null || typeof stored.model === "string"
      ? stored.model
      : defaultTaskRunDefaults.model,
    reasoningEffort:
      stored.reasoningEffort === null || typeof stored.reasoningEffort === "string"
        ? stored.reasoningEffort
        : defaultTaskRunDefaults.reasoningEffort,
    mode: stored.mode === "plan" || stored.mode === "default"
      ? stored.mode
      : defaultTaskRunDefaults.mode,
    approvalPolicy: ["never", "on-request", "untrusted"].includes(String(stored.approvalPolicy))
      ? stored.approvalPolicy as AgentApprovalPolicy
      : defaultTaskRunDefaults.approvalPolicy,
    sandboxMode: ["danger-full-access", "read-only", "workspace-write"].includes(String(stored.sandboxMode))
      ? stored.sandboxMode as AgentSandboxMode
      : defaultTaskRunDefaults.sandboxMode,
  };
};

export const normalizeAppPreferences = (value: unknown): AppPreferences => {
  if (!value || typeof value !== "object") return defaults;
  const stored = value as Partial<AppPreferences>;
  return {
    importCodexHistory:
      typeof stored.importCodexHistory === "boolean"
        ? stored.importCodexHistory
        : defaults.importCodexHistory,
    showChatExport:
      typeof stored.showChatExport === "boolean" ? stored.showChatExport : defaults.showChatExport,
    showReasoningSummaries:
      typeof stored.showReasoningSummaries === "boolean"
        ? stored.showReasoningSummaries
        : defaults.showReasoningSummaries,
    expandToolOutput:
      typeof stored.expandToolOutput === "boolean" ? stored.expandToolOutput : defaults.expandToolOutput,
    focusNewTasks: typeof stored.focusNewTasks === "boolean" ? stored.focusNewTasks : defaults.focusNewTasks,
    wrapCode: typeof stored.wrapCode === "boolean" ? stored.wrapCode : defaults.wrapCode,
    notifyCompletions:
      typeof stored.notifyCompletions === "boolean" ? stored.notifyCompletions : defaults.notifyCompletions,
    notifyErrors: typeof stored.notifyErrors === "boolean" ? stored.notifyErrors : defaults.notifyErrors,
    notifyApprovals:
      typeof stored.notifyApprovals === "boolean" ? stored.notifyApprovals : defaults.notifyApprovals,
    hiddenModels: Array.isArray(stored.hiddenModels)
      ? stored.hiddenModels.filter((model): model is string => typeof model === "string")
      : [],
    taskRunDefaults: normalizeTaskRunDefaults(stored.taskRunDefaults),
  };
};

const readPreferences = (): AppPreferences => {
  try {
    return normalizeAppPreferences(
      JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as unknown,
    );
  } catch {
    return defaults;
  }
};

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(readPreferences);

  useLayoutEffect(() => {
    document.documentElement.dataset.codeWrap = preferences.wrapCode ? "wrap" : "scroll";
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Preferences remain active for this session if local storage is unavailable.
    }
  }, [preferences]);

  const updatePreferences = (patch: Partial<AppPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  };

  const updateTaskRunDefaults = (patch: Partial<TaskRunDefaults>) => {
    setPreferences((current) => ({
      ...current,
      taskRunDefaults: { ...current.taskRunDefaults, ...patch },
    }));
  };

  return { preferences, updatePreferences, updateTaskRunDefaults };
}
