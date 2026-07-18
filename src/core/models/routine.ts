import type { RunSnapshot, RunStatus } from "./run";
import type { XiaoWorkspaceMode } from "./xiao";

export type RoutineScheduleKind = "one_shot" | "daily";
export type MissedRunPolicy = "skip" | "run_once";
export type RoutineTriggerKind = "automatic" | "manual";
export type RoutineOccurrenceStatus = "reserved" | "dispatched" | "skipped" | "cancelled";

export type RoutineOccurrenceSummary = {
  id: string;
  scheduledFor: number;
  triggerKind: RoutineTriggerKind;
  status: RoutineOccurrenceStatus;
  run: RunSnapshot | null;
};

export type RoutineSummary = {
  id: string;
  workspacePath: string;
  taskId: string;
  title: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  timezone: string;
  scheduledFor: number | null;
  dailyTime: string | null;
  missedRunPolicy: MissedRunPolicy;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  mode: string;
  approvalPolicy: string;
  sandboxMode: string;
  executionEnvironmentId: string;
  executionRoot: string;
  managedWorktreeId: string | null;
  workspaceMode: XiaoWorkspaceMode;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  isolationWarning: string | null;
  lastStatus: RunStatus | null;
  history: RoutineOccurrenceSummary[];
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type CreateRoutineRequest = {
  projectPath: string;
  taskId: string;
  title: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  timezone: string;
  scheduledFor: number | null;
  dailyTime: string | null;
  missedRunPolicy: MissedRunPolicy;
  preferIsolation: boolean;
  dangerousAccessConfirmed: boolean;
  serviceTier: string | null;
};

export type UpdateRoutineRequest = Omit<CreateRoutineRequest, "projectPath" | "taskId"> & {
  routineId: string;
};

export type RoutineUpdateEnvelope = {
  workspacePath: string;
  routine: RoutineSummary | null;
  deletedId: string | null;
};

export type RoutineOpenRunTarget = {
  workspacePath: string;
  taskId: string;
  routineId: string;
  runId: string;
};
