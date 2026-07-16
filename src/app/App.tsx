import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriHost, nativeBridge } from "../core/bridges/tauri";
import type {
  AgentAttachment,
  AgentGoal,
  AgentPlan,
  AgentThreadTokenUsage,
  AgentTurnOutcome,
  CodexThreadSummary,
  TimelineEntry,
} from "../core/models/agent";
import type { XiaoProjectSummary, XiaoWorkspaceDocument } from "../core/models/xiao";
import { titleFromPrompt, useAgentRuntime } from "../features/agent/hooks/useAgentRuntime";
import {
  listCodexThreads,
  readCodexThreadTimeline,
  sameWorkspacePath,
} from "../features/agent/history/codexHistory";
import { CommandMenu } from "../features/command-menu/components/CommandMenu";
import { FocusRail } from "../features/focus-rail/components/FocusRail";
import type { ScheduledTask } from "../features/focus-rail/components/SchedulePanel";
import type { FocusView } from "../features/focus-rail/focus-rail.types";
import { ProfilePage } from "../features/profile/components/ProfilePage";
import { useLocalProfile } from "../features/profile/hooks/useLocalProfile";
import {
  SettingsPage,
  type ArchivedTaskItem,
} from "../features/settings/components/SettingsPage";
import {
  useAppPreferences,
  type TaskRunDefaults,
} from "../features/settings/hooks/useAppPreferences";
import { useCodexUpdate } from "../features/settings/hooks/useCodexUpdate";
import { useTheme } from "../features/settings/hooks/useTheme";
import { AppShell } from "../features/shell/components/AppShell";
import { GlobalContextMenu } from "../features/shell/components/GlobalContextMenu";
import { Sidebar } from "../features/shell/components/Sidebar";
import { TitleBar } from "../features/shell/components/TitleBar";
import type { AppPage } from "../features/shell/shell.types";
import type { TaskGroup, WorkbenchTask } from "../features/task/task.types";
import { TaskWorkspace } from "../features/task/workspace/TaskWorkspace";
import { useWorkspace } from "../features/workspace/hooks/useWorkspace";

type StoredTaskState = {
  tasks: WorkbenchTask[];
  activeTaskId: string | null;
  showArchived: boolean;
};

type ProjectPreference = {
  name?: string;
  pinned?: boolean;
  hidden?: boolean;
};

type ProjectPreferences = Record<string, ProjectPreference>;

const projectPreferencesStorageKey = "xiao.projects.v1";
const activeProjectStorageKey = "xiao.active-project.v1";
const projectSnapshotStorageKey = "xiao.project-snapshot.v1";
const codexThreadSnapshotStorageKey = "xiao.codex-thread-snapshot.v1";
const usageSnapshotStorageKey = "xiao.usage-snapshot.v1";
const scheduleStorageKey = (workspacePath: string) => `xiao.schedules.v1:${workspacePath}`;
const projectPathKey = (path: string) => path.replace(/[\\/]+$/, "").toLocaleLowerCase();
const readSnapshot = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
};
const writeSnapshot = (key: string, value: unknown) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* A fresh native refresh will still populate the view. */ }
};

const readActiveProjectPath = () => {
  try { return window.localStorage.getItem(activeProjectStorageKey) || undefined; }
  catch { return undefined; }
};

const readScheduledTasks = (workspacePath: string): ScheduledTask[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(scheduleStorageKey(workspacePath)) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ScheduledTask => {
          if (!item || typeof item !== "object") return false;
          const task = item as Partial<ScheduledTask>;
          return typeof task.id === "string" && typeof task.prompt === "string" &&
            typeof task.runAt === "number" && ["pending", "running", "completed", "failed"].includes(task.status ?? "");
        }).map((task) => task.status === "running" ? { ...task, status: "failed" as const } : task)
      : [];
  } catch { return []; }
};

const readProjectPreferences = (): ProjectPreferences => {
  try {
    const stored = window.localStorage.getItem(projectPreferencesStorageKey);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProjectPreferences)
      : {};
  } catch {
    return {};
  }
};

const writeProjectPreferences = (preferences: ProjectPreferences) => {
  try {
    window.localStorage.setItem(projectPreferencesStorageKey, JSON.stringify(preferences));
  } catch {
    // Desktop webviews and browser previews can run with storage disabled.
  }
};

const applyProjectPreferences = (
  projects: XiaoProjectSummary[],
  preferences: ProjectPreferences,
): XiaoProjectSummary[] =>
  projects
    .filter((project) => !preferences[project.path]?.hidden)
    .map((project) => {
      const preference = preferences[project.path];
      const customName = preference?.name?.trim();
      return {
        ...project,
        name: customName || project.name,
        pinned: Boolean(preference?.pinned),
      };
    })
    .sort(
      (left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
        right.updatedAt - left.updatedAt,
    );

const taskGroups = new Set<TaskGroup>(["Active", "Recent", "Yesterday", "This week"]);
const taskDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const createDraftTask = (defaults: TaskRunDefaults): WorkbenchTask => {
  const createdAt = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New task",
    meta: "Draft",
    group: "Active",
    archived: false,
    pinned: false,
    unread: false,
    createdAt,
    updatedAt: createdAt,
    draftText: "",
    followUps: [],
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    threadId: null,
    mode: defaults.mode,
    approvalPolicy: defaults.approvalPolicy,
    sandboxMode: defaults.sandboxMode,
    goal: null,
    timeline: [],
    plan: null,
    origin: "xiao",
    historyLoaded: true,
    historyCursor: null,
    historyLoadingOlder: false,
  };
};

const defaultTaskState = (): StoredTaskState => {
  return { tasks: [], activeTaskId: null, showArchived: false };
};

const ensureValidActiveTask = (state: StoredTaskState): StoredTaskState => {
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId);
  if (activeTask && !activeTask.archived) return { ...state, showArchived: false };

  const liveTask = state.tasks.find((task) => !task.archived);
  if (liveTask) return { ...state, activeTaskId: liveTask.id, showArchived: false };

  return { ...state, activeTaskId: null, showArchived: false };
};

const taskMeta = (updatedAt: number) => {
  const elapsed = Math.max(0, Date.now() - updatedAt);
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return "Yesterday";
  return taskDateFormatter.format(new Date(updatedAt));
};

const taskGroup = (updatedAt: number, active: boolean): TaskGroup => {
  if (active) return "Active";
  const elapsed = Math.max(0, Date.now() - updatedAt);
  if (elapsed < 86_400_000) return "Recent";
  if (elapsed < 172_800_000) return "Yesterday";
  return "This week";
};

type StoredWorkbenchTask = Omit<
  WorkbenchTask,
  "approvalPolicy" | "draftText" | "followUps" | "goal" | "mode" | "plan" | "reasoningEffort" | "sandboxMode" | "threadId"
> & {
  draftText?: string;
  followUps?: WorkbenchTask["followUps"];
  reasoningEffort?: string | null;
  plan?: AgentPlan | null;
  threadId?: string | null;
  mode?: "default" | "plan";
  approvalPolicy?: "never" | "on-request" | "untrusted";
  sandboxMode?: "danger-full-access" | "read-only" | "workspace-write";
  goal?: AgentGoal | null;
};

const isAgentGoal = (value: unknown): value is AgentGoal => {
  if (!value || typeof value !== "object") return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.objective === "string" &&
    ["active", "paused", "complete"].includes(String(goal.status))
  );
};

const isAgentPlan = (value: unknown): value is AgentPlan => {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    (plan.explanation === null || typeof plan.explanation === "string") &&
    Array.isArray(plan.steps) &&
    plan.steps.every((item) => {
      if (!item || typeof item !== "object") return false;
      const step = item as Record<string, unknown>;
      return (
        typeof step.step === "string" &&
        ["pending", "inProgress", "completed"].includes(String(step.status))
      );
    })
  );
};

const activeAgentPlan = (plan: AgentPlan | null | undefined) =>
  plan?.steps.length && plan.steps.every((step) => step.status === "completed")
    ? null
    : plan ?? null;

const isAgentAttachment = (value: unknown): value is AgentAttachment => {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.name === "string" &&
    typeof attachment.path === "string" &&
    ["directory", "file", "image", "review"].includes(String(attachment.kind))
  );
};

const isAgentFollowUp = (value: unknown): value is WorkbenchTask["followUps"][number] => {
  if (!value || typeof value !== "object") return false;
  const followUp = value as Record<string, unknown>;
  return (
    typeof followUp.id === "string" &&
    typeof followUp.prompt === "string" &&
    typeof followUp.createdAt === "number" &&
    Array.isArray(followUp.attachments) &&
    followUp.attachments.every(isAgentAttachment)
  );
};

const isWorkbenchTask = (value: unknown): value is StoredWorkbenchTask => {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.meta === "string" &&
    taskGroups.has(task.group as TaskGroup) &&
    typeof task.archived === "boolean" &&
    typeof task.pinned === "boolean" &&
    (task.unread === undefined || typeof task.unread === "boolean") &&
    typeof task.createdAt === "number" &&
    typeof task.updatedAt === "number" &&
    (task.draftText === undefined || typeof task.draftText === "string") &&
    (task.followUps === undefined ||
      (Array.isArray(task.followUps) && task.followUps.every(isAgentFollowUp))) &&
    (task.model === null || typeof task.model === "string") &&
    (task.reasoningEffort === undefined ||
      task.reasoningEffort === null ||
      typeof task.reasoningEffort === "string") &&
    (task.threadId === undefined || task.threadId === null || typeof task.threadId === "string") &&
    (task.mode === undefined || task.mode === "default" || task.mode === "plan") &&
    (task.approvalPolicy === undefined ||
      ["never", "on-request", "untrusted"].includes(String(task.approvalPolicy))) &&
    (task.sandboxMode === undefined ||
      ["danger-full-access", "read-only", "workspace-write"].includes(String(task.sandboxMode))) &&
    (task.goal === undefined || task.goal === null || isAgentGoal(task.goal)) &&
    (task.plan === undefined || task.plan === null || isAgentPlan(task.plan)) &&
    Array.isArray(task.timeline)
  );
};

const isLegacyEmptyDraft = (task: StoredWorkbenchTask) =>
  task.title === "New task" &&
  !task.archived &&
  !task.pinned &&
  !task.unread &&
  task.model === null &&
  (task.reasoningEffort === undefined || task.reasoningEffort === null) &&
  (task.threadId === undefined || task.threadId === null) &&
  (task.mode === undefined || task.mode === "default") &&
  (task.approvalPolicy === undefined || task.approvalPolicy === "on-request") &&
  (task.sandboxMode === undefined || task.sandboxMode === "workspace-write") &&
  (task.goal === undefined || task.goal === null) &&
  (task.draftText === undefined || !task.draftText.trim()) &&
  (task.followUps === undefined || task.followUps.length === 0) &&
  task.timeline.length === 0 &&
  (task.plan === undefined || task.plan === null);

const taskStorageKey = (workspacePath: string) => `xiao.tasks.v2:${workspacePath}`;
const retiredFixtureTaskIds = new Set([
  "workbench-shell",
  "agent-protocol",
  "workspace-boundaries",
  "diff-experience",
]);

const readBrowserTaskState = (workspacePath: string): StoredTaskState => {
  try {
    const stored = window.localStorage.getItem(taskStorageKey(workspacePath));
    if (!stored) return defaultTaskState();
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (
      !Array.isArray(parsed.tasks) ||
      !parsed.tasks.every(isWorkbenchTask)
    ) {
      return defaultTaskState();
    }
    const tasks: WorkbenchTask[] = parsed.tasks
      .filter((task) => !retiredFixtureTaskIds.has(task.id) && !isLegacyEmptyDraft(task))
      .map((task) => ({
        ...task,
        draftText: task.draftText ?? "",
        followUps: task.followUps ?? [],
        reasoningEffort: task.reasoningEffort ?? null,
        threadId: task.threadId ?? null,
        mode: task.mode ?? "default",
        approvalPolicy: task.approvalPolicy ?? "on-request",
        sandboxMode: task.sandboxMode ?? "workspace-write",
        goal: task.goal ?? null,
        plan: activeAgentPlan(task.plan),
        unread: task.unread ?? false,
      }));
    const activeTaskId =
      typeof parsed.activeTaskId === "string" &&
      tasks.some((task) => task.id === parsed.activeTaskId)
        ? parsed.activeTaskId
        : null;
    return {
      tasks,
      activeTaskId,
      showArchived: false,
    };
  } catch {
    return defaultTaskState();
  }
};

const stateFromDocument = (document: XiaoWorkspaceDocument): StoredTaskState => ({
  activeTaskId: document.activeTaskId,
  showArchived: false,
  tasks: document.tasks.map((task) => ({
    ...task,
    draftText: task.draftText ?? "",
    followUps: task.followUps ?? [],
    threadId: task.threadId ?? null,
    mode: task.mode ?? "default",
    approvalPolicy: task.approvalPolicy ?? "on-request",
    sandboxMode: task.sandboxMode ?? "workspace-write",
    goal: task.goal ?? null,
    plan: activeAgentPlan(task.plan),
    unread: task.unread ?? false,
    meta: taskMeta(task.updatedAt),
    group: taskGroup(task.updatedAt, task.id === document.activeTaskId && !task.archived),
  })),
});

const documentFromState = (
  workspacePath: string,
  state: StoredTaskState,
): XiaoWorkspaceDocument => {
  const localTasks = state.tasks.filter((task) => task.origin !== "codex");
  return {
    schemaVersion: 1,
    workspacePath,
    activeTaskId: localTasks.some((task) => task.id === state.activeTaskId)
      ? state.activeTaskId
      : null,
    showArchived: state.showArchived,
    tasks: localTasks.map(({ meta: _meta, group: _group, ...task }) => task),
  };
};

const taskFromCodexThread = (thread: CodexThreadSummary): WorkbenchTask => ({
  id: `codex:${thread.id}`,
  title: thread.title,
  meta: taskMeta(thread.updatedAt),
  group: taskGroup(thread.updatedAt, false),
  archived: thread.archived,
  pinned: false,
  unread: false,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  draftText: "",
  followUps: [],
  model: null,
  reasoningEffort: null,
  threadId: thread.id,
  mode: "default",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  goal: null,
  timeline: [],
  plan: null,
  origin: "codex",
  historyLoaded: false,
  historyCursor: null,
  historyLoadingOlder: false,
});

const mergeCodexTasks = (
  current: WorkbenchTask[],
  threads: CodexThreadSummary[],
): WorkbenchTask[] => {
  const threadIds = new Set(threads.map((thread) => thread.id));
  const retained = current.filter(
    (task) => task.origin !== "codex" || (task.threadId != null && threadIds.has(task.threadId)),
  );
  for (const thread of threads) {
    const index = retained.findIndex((task) => task.threadId === thread.id);
    if (index < 0) {
      retained.push(taskFromCodexThread(thread));
      continue;
    }
    const existing = retained[index];
    retained[index] = {
      ...existing,
      title: existing.origin === "codex" ? thread.title : existing.title,
      archived: thread.archived,
      createdAt: thread.createdAt,
      updatedAt: Math.max(existing.updatedAt, thread.updatedAt),
      meta: taskMeta(Math.max(existing.updatedAt, thread.updatedAt)),
    };
  }
  return retained.sort(
    (left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt,
  );
};

const mergeProject = (
  projects: XiaoProjectSummary[],
  project: XiaoProjectSummary,
): XiaoProjectSummary[] => {
  const next = projects.filter((item) => item.path !== project.path);
  return [project, ...next].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      right.updatedAt - left.updatedAt,
  );
};

export function App() {
  const { profile, saveProfile } = useLocalProfile();
  const [activeProjectPath, setActiveProjectPath] = useState<string | undefined>(readActiveProjectPath);
  const {
    workspace,
    system,
    loading,
    error: workspaceError,
    refresh,
    loadDirectory,
  } = useWorkspace(activeProjectPath);
  const { theme, setTheme } = useTheme();
  const { preferences, updatePreferences, updateTaskRunDefaults } = useAppPreferences();
  const codexUpdate = useCodexUpdate();
  const [initialTaskState] = useState(defaultTaskState);
  const [activePage, setActivePage] = useState<AppPage>("tasks");
  const [focusView, setFocusView] = useState<FocusView>("changes");
  const [focusPanelOpen, setFocusPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 760px)").matches,
  );
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [taskWorkspacePath, setTaskWorkspacePath] = useState("");
  const [taskStateReady, setTaskStateReady] = useState(!isTauriHost());
  const [taskLoadError, setTaskLoadError] = useState<string | null>(null);
  const [taskSaveError, setTaskSaveError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkbenchTask[]>(initialTaskState.tasks);
  const [activeTaskId, setActiveTaskId] = useState(initialTaskState.activeTaskId);
  const [draftTask, setDraftTask] = useState(() => createDraftTask(preferences.taskRunDefaults));
  const [openTaskIds, setOpenTaskIds] = useState<string[]>(
    initialTaskState.activeTaskId ? [initialTaskState.activeTaskId] : [],
  );
  const [draftTabOpen, setDraftTabOpen] = useState(initialTaskState.activeTaskId === null);
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(
    readProjectPreferences,
  );
  const projectPreferencesRef = useRef(projectPreferences);
  const archivedRefreshId = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestTaskStateRef = useRef<{ path: string; state: StoredTaskState } | null>(null);
  const focusedLaunchTaskRef = useRef<string | null>(null);
  const notifiedRuntimeErrorRef = useRef<string | null>(null);
  const notifiedApprovalRef = useRef<string | null>(null);
  const notifiedQuestionRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<XiaoProjectSummary[]>(() =>
    readSnapshot(projectSnapshotStorageKey, []),
  );
  const managedProjectPathsRef = useRef(new Set<string>());
  const [codexThreads, setCodexThreads] = useState<CodexThreadSummary[]>(() =>
    readSnapshot(codexThreadSnapshotStorageKey, []),
  );
  const [threadTokenUsage, setThreadTokenUsage] = useState<AgentThreadTokenUsage[]>(() =>
    readSnapshot(usageSnapshotStorageKey, []),
  );
  const codexHistoryRefreshRef = useRef(0);
  const loadingCodexThreadsRef = useRef(new Set<string>());
  const pendingCodexThreadRef = useRef<string | null>(null);
  const openProjectWithoutTaskRef = useRef(false);
  const [archivedTasks, setArchivedTasks] = useState<ArchivedTaskItem[]>([]);
  const [archivedTasksLoading, setArchivedTasksLoading] = useState(false);
  const [archivedTasksError, setArchivedTasksError] = useState<string | null>(null);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [reviewContextByTask, setReviewContextByTask] = useState<Record<string, AgentAttachment[]>>({});
  const [restoredAttachmentsByTask, setRestoredAttachmentsByTask] = useState<Record<string, AgentAttachment[]>>({});
  const [scheduleWorkspacePath, setScheduleWorkspacePath] = useState("");
  const [pendingScheduledPrompt, setPendingScheduledPrompt] = useState<{ id: string; taskId: string; prompt: string } | null>(null);
  const scheduleSubmittingRef = useRef<string | null>(null);
  const [sendingFollowUpId, setSendingFollowUpId] = useState<string | null>(null);
  const [failedFollowUpId, setFailedFollowUpId] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeTask = selectedTask ?? draftTask;
  const taskStateError = taskLoadError ?? taskSaveError;
  const pendingReviewContext = reviewContextByTask[activeTask.id] ?? [];
  const focusedLaunch =
    taskStateReady &&
    taskWorkspacePath === workspace.path &&
    activePage === "tasks" &&
    selectedTask != null &&
    !selectedTask.archived &&
    activeTask.timeline.length === 0;
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebarOnNarrow = useCallback(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!focusedLaunch || !preferences.focusNewTasks) return;
    const taskKey = `${workspace.path}\u0000${activeTask.id}`;
    if (focusedLaunchTaskRef.current === taskKey) return;
    focusedLaunchTaskRef.current = taskKey;
    setSidebarOpen(false);
    setFocusPanelOpen(false);
  }, [activeTask.id, focusedLaunch, preferences.focusNewTasks, workspace.path]);

  const enqueueDocumentSave = useCallback((document: XiaoWorkspaceDocument) => {
    const operation = saveQueueRef.current
      .catch(() => undefined)
      .then(() => nativeBridge.saveXiaoWorkspace(document));
    saveQueueRef.current = operation;
    return operation;
  }, []);

  const persistTaskState = useCallback(
    (path: string, state: StoredTaskState) => {
      const operation = isTauriHost()
        ? enqueueDocumentSave(documentFromState(path, state))
        : new Promise<void>((resolve, reject) => {
            try {
              window.localStorage.setItem(taskStorageKey(path), JSON.stringify(state));
              resolve();
            } catch (reason) {
              reject(reason);
            }
          });

      void operation.then(() => setTaskSaveError(null)).catch((reason) => {
        setTaskSaveError(reason instanceof Error ? reason.message : String(reason));
      });
      return operation;
    },
    [enqueueDocumentSave],
  );

  useEffect(() => {
    if (!isTauriHost() || loading || activeProjectPath) return;
    setActiveProjectPath(workspace.path);
  }, [activeProjectPath, loading, workspace.path]);

  useEffect(() => {
    if (!activeProjectPath) return;
    try { window.localStorage.setItem(activeProjectStorageKey, activeProjectPath); }
    catch { /* The current session still keeps the selected project. */ }
  }, [activeProjectPath]);

  useEffect(() => {
    if (!isTauriHost()) return;
    void nativeBridge
      .listXiaoProjects()
      .then((items) => {
        const visibleItems = items.filter((project) =>
          project.taskCount == null || project.taskCount > 0 ||
          sameWorkspacePath(project.path, activeProjectPath ?? ""),
        );
        visibleItems.forEach((project) =>
          managedProjectPathsRef.current.add(projectPathKey(project.path)),
        );
        setProjects((current) => {
          const next = applyProjectPreferences(
            current.reduce((merged, project) => mergeProject(merged, project), visibleItems),
            projectPreferencesRef.current,
          );
          writeSnapshot(projectSnapshotStorageKey, next);
          return next;
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (loading || taskWorkspacePath === workspace.path) return;
    let cancelled = false;
    setTaskStateReady(false);
    setTaskLoadError(null);

    const loadState = async () => {
      try {
        const loadedState = isTauriHost()
          ? await nativeBridge
              .loadXiaoWorkspace(workspace.path)
              .then((document) => (document ? stateFromDocument(document) : defaultTaskState()))
          : readBrowserTaskState(workspace.path);
        const workspaceThreads = preferences.importCodexHistory
          ? codexThreads.filter((thread) => sameWorkspacePath(thread.cwd, workspace.path))
          : [];
        const nextState = ensureValidActiveTask({
          ...loadedState,
          tasks: mergeCodexTasks(loadedState.tasks, workspaceThreads),
        });
        if (cancelled) return;
        const pendingThreadId = pendingCodexThreadRef.current;
        const pendingTaskId = pendingThreadId ? `codex:${pendingThreadId}` : null;
        setTasks(nextState.tasks);
        setActiveTaskId(openProjectWithoutTaskRef.current ? null :
          pendingTaskId && nextState.tasks.some((task) => task.id === pendingTaskId)
            ? pendingTaskId
            : nextState.activeTaskId,
        );
        pendingCodexThreadRef.current = null;
        openProjectWithoutTaskRef.current = false;
        const nextDraft = createDraftTask(preferences.taskRunDefaults);
        setDraftTask(nextDraft);
        setOpenTaskIds(nextState.activeTaskId ? [nextState.activeTaskId] : []);
        setDraftTabOpen(nextState.activeTaskId === null);
        setTaskWorkspacePath(workspace.path);
        setRestoredAttachmentsByTask({});
        setSendingFollowUpId(null);
        setFailedFollowUpId(null);
        setTaskStateReady(true);
        if (managedProjectPathsRef.current.has(projectPathKey(workspace.path))) {
          setProjects((current) =>
            applyProjectPreferences(
              mergeProject(current, {
              path: workspace.path,
              name: workspace.name,
              updatedAt:
                Math.max(0, ...nextState.tasks.map((task) => task.updatedAt)) ||
                current.find((project) => project.path === workspace.path)?.updatedAt ||
                Date.now(),
              }),
              projectPreferencesRef.current,
            ),
          );
        }
      } catch (reason) {
        if (cancelled) return;
        setTasks([]);
        setActiveTaskId(null);
        setDraftTask(createDraftTask(preferences.taskRunDefaults));
        setOpenTaskIds([]);
        setDraftTabOpen(true);
        setTaskWorkspacePath("");
        setTaskLoadError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    void loadState();
    return () => {
      cancelled = true;
    };
  }, [codexThreads, loading, preferences.importCodexHistory, taskWorkspacePath, workspace.name, workspace.path]);

  useEffect(() => {
    if (loading || scheduleWorkspacePath === workspace.path) return;
    setScheduledTasks(readScheduledTasks(workspace.path));
    setScheduleWorkspacePath(workspace.path);
    setPendingScheduledPrompt(null);
    scheduleSubmittingRef.current = null;
  }, [loading, scheduleWorkspacePath, workspace.path]);

  useEffect(() => {
    if (!scheduleWorkspacePath || scheduleWorkspacePath !== workspace.path) return;
    try { window.localStorage.setItem(scheduleStorageKey(workspace.path), JSON.stringify(scheduledTasks)); }
    catch { /* Scheduling remains available for the current app session. */ }
  }, [scheduleWorkspacePath, scheduledTasks, workspace.path]);

  useEffect(() => {
    if (!taskStateReady || workspace.path !== taskWorkspacePath) return;
    const state = { tasks, activeTaskId, showArchived: false };
    latestTaskStateRef.current = { path: workspace.path, state };
    const timer = window.setTimeout(() => {
      void persistTaskState(workspace.path, state).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeTaskId, persistTaskState, taskStateReady, taskWorkspacePath, tasks, workspace.path]);

  useEffect(() => {
    if (!taskStateReady) return;
    setTasks((current) => {
      let changed = false;
      const next = current.map((task) => {
        if (task.title !== "New task") return task;
        const firstPrompt = task.timeline.find(
          (entry) => entry.kind === "user" || entry.kind === "brief",
        );
        const prompt = firstPrompt?.body ?? firstPrompt?.title;
        if (!prompt?.trim()) return task;
        changed = true;
        return { ...task, title: titleFromPrompt(prompt), updatedAt: Date.now(), meta: "Now" };
      });
      return changed ? next : current;
    });
  }, [taskStateReady, taskWorkspacePath]);

  useEffect(() => {
    if (!taskStateReady) return;
    if (activeTaskId) {
      setOpenTaskIds((current) => current.includes(activeTaskId) ? current : [...current, activeTaskId]);
      return;
    }
    setDraftTabOpen(true);
  }, [activeTaskId, taskStateReady]);

  useEffect(() => {
    setOpenTaskIds((current) => {
      const next = current.filter((taskId) => tasks.some((task) => task.id === taskId && !task.archived));
      return next.length === current.length ? current : next;
    });
  }, [tasks]);

  useEffect(
    () => () => {
      const latest = latestTaskStateRef.current;
      if (latest?.path === taskWorkspacePath) {
        void persistTaskState(latest.path, latest.state).catch(() => undefined);
      }
    },
    [persistTaskState, taskWorkspacePath],
  );

  const updateTaskTimeline = useCallback((taskId: string, timeline: TimelineEntry[]) => {
    const updatedAt = Date.now();
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? { ...task, timeline, updatedAt, meta: "Now", group: "Active" }
          : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId
        ? { ...current, timeline, updatedAt, meta: "Now", group: "Active" }
        : current,
    );
  }, []);

  const updateTaskPlan = useCallback((taskId: string, plan: AgentPlan | null) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, plan, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, plan, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const updateTaskTitle = useCallback((taskId: string, title: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, title, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, title, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const updateTaskThread = useCallback((taskId: string, threadId: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, threadId, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, threadId, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const updateTaskGoal = useCallback((taskId: string, goal: AgentGoal | null) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, goal, updatedAt: Date.now(), meta: "Now" } : task,
      ),
    );
    setDraftTask((current) =>
      current.id === taskId ? { ...current, goal, updatedAt: Date.now(), meta: "Now" } : current,
    );
  }, []);

  const markTaskFinished = useCallback(
    (taskId: string, outcome: AgentTurnOutcome) => {
      const scheduled = pendingScheduledPrompt;
      if (scheduled?.taskId === taskId) {
        setScheduledTasks((current) => current.map((task) =>
          task.id === scheduled.id
            ? { ...task, status: outcome === "completed" ? "completed" : "failed" }
            : task,
        ));
        setPendingScheduledPrompt(null);
        scheduleSubmittingRef.current = null;
        if (outcome === "completed" && preferences.notifyCompletions && "Notification" in window && Notification.permission === "granted") {
          new Notification("Xiao finished a scheduled task", { body: scheduled.prompt });
        }
      }
      const finished = tasks.find((task) => task.id === taskId);
      if (
        outcome === "completed" &&
        scheduled?.taskId !== taskId &&
        finished &&
        taskId !== activeTaskId &&
        preferences.notifyCompletions &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification("Xiao finished a task", { body: finished.title });
      }
      setTasks((current) =>
        current.map((task) =>
          task.id === taskId && taskId !== activeTaskId
            ? { ...task, unread: true, updatedAt: Date.now(), meta: "Now" }
            : task,
        ),
      );
    },
    [activeTaskId, pendingScheduledPrompt, preferences.notifyCompletions, tasks],
  );

  const agent = useAgentRuntime(
    workspace.path,
    activeTask.id,
    activeTask.title,
    activeTask.threadId,
    activeTask.timeline,
    activeTask.model,
    activeTask.reasoningEffort,
    activeTask.mode,
    activeTask.approvalPolicy,
    activeTask.sandboxMode,
    activeTask.goal,
    updateTaskTimeline,
    updateTaskPlan,
    updateTaskTitle,
    updateTaskThread,
    updateTaskGoal,
    markTaskFinished,
    refresh,
    !codexUpdate.updating,
  );

  useEffect(() => {
    if (!preferences.importCodexHistory) {
      setTasks((current) => current.filter((task) => task.origin !== "codex"));
      setActiveTaskId((current) => current?.startsWith("codex:") ? null : current);
    }
    if (!isTauriHost() || agent.runtime.phase !== "ready") return;
    const now = Date.now();
    if (now - codexHistoryRefreshRef.current < 30_000) return;
    codexHistoryRefreshRef.current = now;
    let cancelled = false;

    void Promise.all([listCodexThreads(), nativeBridge.readAgentThreadUsage()])
      .then(([threads, usage]) => {
        if (cancelled) return;
        setCodexThreads(threads);
        setThreadTokenUsage(usage);
        writeSnapshot(codexThreadSnapshotStorageKey, threads);
        writeSnapshot(usageSnapshotStorageKey, usage);
        const threadCounts = new Map<string, { path: string; count: number; updatedAt: number }>();
        for (const thread of threads) {
          if (thread.archived || !thread.cwd.trim()) continue;
          const key = projectPathKey(thread.cwd);
          const current = threadCounts.get(key);
          threadCounts.set(key, {
            path: thread.cwd,
            count: (current?.count ?? 0) + 1,
            updatedAt: Math.max(current?.updatedAt ?? 0, thread.updatedAt),
          });
        }
        const historyProjects: XiaoProjectSummary[] = [...threadCounts.values()]
          .filter(({ count }) => count >= 2)
          .map(({ path, count, updatedAt }) => ({
            path,
            name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
            updatedAt,
            taskCount: count,
          }));
        setProjects((current) => {
          const next = applyProjectPreferences(
            historyProjects.reduce((merged, project) => mergeProject(merged, project), current),
            projectPreferencesRef.current,
          );
          writeSnapshot(projectSnapshotStorageKey, next);
          return next;
        });
      })
      .catch((reason) => {
        if (!cancelled) console.error("Could not load Codex thread history.", reason);
      });

    return () => {
      cancelled = true;
    };
  }, [agent.runtime.phase, preferences.importCodexHistory]);

  useEffect(() => {
    if (
      !preferences.importCodexHistory ||
      !taskStateReady ||
      taskWorkspacePath !== workspace.path ||
      !codexThreads.length
    ) return;
    const workspaceThreads = codexThreads.filter((thread) =>
      sameWorkspacePath(thread.cwd, workspace.path),
    );
    setTasks((current) => mergeCodexTasks(current, workspaceThreads));
  }, [codexThreads, preferences.importCodexHistory, taskStateReady, taskWorkspacePath, workspace.path]);

  useEffect(() => {
    if (
      agent.runtime.phase !== "ready" ||
      activeTask.origin !== "codex" ||
      activeTask.historyLoaded ||
      !activeTask.threadId ||
      loadingCodexThreadsRef.current.has(activeTask.threadId)
    ) {
      return;
    }
    const threadId = activeTask.threadId;
    const taskId = activeTask.id;
    loadingCodexThreadsRef.current.add(threadId);
    void readCodexThreadTimeline(threadId)
      .then((page) => {
        setTasks((current) => current.map((task) =>
          task.id === taskId
            ? {
                ...task,
                timeline: page.timeline,
                historyLoaded: true,
                historyCursor: page.nextCursor,
              }
            : task,
        ));
      })
      .catch((reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setTasks((current) => current.map((task) =>
          task.id === taskId
            ? {
                ...task,
                historyLoaded: true,
                timeline: [{
                  id: `history-error-${threadId}`,
                  kind: "result",
                  title: "Could not load Codex history",
                  body: message,
                  status: "error",
                  meta: "Codex",
                }],
              }
            : task,
        ));
      })
      .finally(() => loadingCodexThreadsRef.current.delete(threadId));
  }, [activeTask.historyLoaded, activeTask.id, activeTask.origin, activeTask.threadId, agent.runtime.phase]);

  const loadOlderCodexHistory = useCallback(async () => {
    if (
      activeTask.origin !== "codex" ||
      !activeTask.threadId ||
      !activeTask.historyCursor ||
      activeTask.historyLoadingOlder
    ) return;
    const taskId = activeTask.id;
    const cursor = activeTask.historyCursor;
    setTasks((current) => current.map((task) =>
      task.id === taskId ? { ...task, historyLoadingOlder: true } : task,
    ));
    try {
      const page = await readCodexThreadTimeline(activeTask.threadId, cursor);
      setTasks((current) => current.map((task) => {
        if (task.id !== taskId) return task;
        const existing = new Set(task.timeline.map((entry) => entry.id));
        return {
          ...task,
          timeline: [...page.timeline.filter((entry) => !existing.has(entry.id)), ...task.timeline],
          historyCursor: page.nextCursor,
          historyLoadingOlder: false,
        };
      }));
    } catch (reason) {
      console.error("Could not load older Codex history.", reason);
      setTasks((current) => current.map((task) =>
        task.id === taskId ? { ...task, historyLoadingOlder: false } : task,
      ));
    }
  }, [activeTask.historyCursor, activeTask.historyLoadingOlder, activeTask.id, activeTask.origin, activeTask.threadId]);

  const titleBarTabs = [
    ...openTaskIds.flatMap((taskId) => {
      const task = tasks.find((item) => item.id === taskId && !item.archived);
      return task ? [{
        id: task.id,
        title: task.title,
        working: agent.runtime.phase === "working" && agent.runtime.taskId === task.id,
      }] : [];
    }),
    ...(draftTabOpen ? [{ id: draftTask.id, title: "New task", draft: true, working: false }] : []),
  ];
  const visibleModels = agent.models.filter(
    (model) => !preferences.hiddenModels.includes(model.model) || model.model === activeTask.model,
  );

  useEffect(() => {
    const runtimeError = agent.runtime.error;
    if (!runtimeError) {
      notifiedRuntimeErrorRef.current = null;
      return;
    }
    if (
      preferences.notifyErrors &&
      notifiedRuntimeErrorRef.current !== runtimeError &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedRuntimeErrorRef.current = runtimeError;
      new Notification("Xiao needs attention", { body: runtimeError });
    }
  }, [agent.runtime.error, preferences.notifyErrors]);

  useEffect(() => {
    const approval = [...activeTask.timeline]
      .reverse()
      .find((entry) => entry.kind === "approval" && entry.status === "warning");
    if (!approval) return;
    if (
      preferences.notifyApprovals &&
      notifiedApprovalRef.current !== approval.id &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedApprovalRef.current = approval.id;
      new Notification("Xiao is waiting for approval", { body: approval.title });
    }
  }, [activeTask.timeline, preferences.notifyApprovals]);

  useEffect(() => {
    const question = agent.questionRequest;
    if (!question) {
      notifiedQuestionRef.current = null;
      return;
    }
    const requestId = String(question.requestId);
    if (
      preferences.notifyApprovals &&
      notifiedQuestionRef.current !== requestId &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedQuestionRef.current = requestId;
      new Notification("Xiao has a question", { body: question.questions[0]?.question });
    }
  }, [agent.questionRequest, preferences.notifyApprovals]);

  const submitTask = async (prompt: string, attachments: Parameters<typeof agent.submit>[1]) => {
    if (!taskStateReady) return false;
    if (!selectedTask) {
      const updatedAt = Date.now();
      const materializedTask: WorkbenchTask = {
        ...activeTask,
        title: activeTask.title === "New task" ? titleFromPrompt(prompt) : activeTask.title,
        updatedAt,
        meta: "Now",
        group: "Active",
        draftText: "",
      };
      setTasks((current) =>
        current.some((task) => task.id === materializedTask.id)
          ? current
          : [materializedTask, ...current],
      );
      setOpenTaskIds((current) => current.includes(materializedTask.id) ? current : [...current, materializedTask.id]);
      setActiveTaskId(materializedTask.id);
      setDraftTabOpen(false);
      setDraftTask(createDraftTask(preferences.taskRunDefaults));
    }
    return agent.submit(prompt, attachments);
  };

  const queueTaskFollowUp = async (prompt: string, attachments: AgentAttachment[]) => {
    const cleanPrompt = prompt.trim();
    if (!taskStateReady || activeTask.archived || !cleanPrompt) return false;
    const followUp = {
      id: crypto.randomUUID(),
      prompt: cleanPrompt,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      createdAt: Date.now(),
    };
    const updatedAt = Date.now();
    setTasks((current) => current.map((task) =>
      task.id === activeTask.id
        ? { ...task, followUps: [...task.followUps, followUp], updatedAt, meta: "Now" }
        : task,
    ));
    setFailedFollowUpId(null);
    return true;
  };

  const removeTaskFollowUp = (followUpId: string) => {
    if (sendingFollowUpId === followUpId) return;
    setTasks((current) => current.map((task) =>
      task.id === activeTask.id
        ? { ...task, followUps: task.followUps.filter((item) => item.id !== followUpId) }
        : task,
    ));
    if (failedFollowUpId === followUpId) setFailedFollowUpId(null);
  };

  const sendTaskFollowUpNow = async (followUpId: string) => {
    if (sendingFollowUpId) return;
    const followUp = activeTask.followUps.find((item) => item.id === followUpId);
    if (!followUp) return;
    const taskId = activeTask.id;
    setSendingFollowUpId(followUp.id);
    setFailedFollowUpId(null);
    try {
      const success = await agent.submit(followUp.prompt, followUp.attachments);
      if (!success) {
        setFailedFollowUpId(followUp.id);
        return;
      }
      setTasks((current) => current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              followUps: task.followUps.filter((item) => item.id !== followUp.id),
              updatedAt: Date.now(),
              meta: "Now",
            }
          : task,
      ));
    } finally {
      setSendingFollowUpId((current) => current === followUp.id ? null : current);
    }
  };

  useEffect(() => {
    const followUp = activeTask.followUps[0];
    if (
      !taskStateReady ||
      activeTask.archived ||
      !followUp ||
      agent.runtime.phase !== "ready" ||
      agent.undoing ||
      sendingFollowUpId ||
      failedFollowUpId === followUp.id
    ) return;

    const taskId = activeTask.id;
    setSendingFollowUpId(followUp.id);
    void agent.submit(followUp.prompt, followUp.attachments).then((success) => {
      if (!success) {
        setFailedFollowUpId(followUp.id);
        return;
      }
      setTasks((current) => current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              followUps: task.followUps.filter((item) => item.id !== followUp.id),
              updatedAt: Date.now(),
              meta: "Now",
            }
          : task,
      ));
      setFailedFollowUpId((current) => current === followUp.id ? null : current);
    }).finally(() => setSendingFollowUpId((current) => current === followUp.id ? null : current));
  }, [
    activeTask.archived,
    activeTask.followUps,
    activeTask.id,
    agent.runtime.phase,
    agent.submit,
    agent.undoing,
    failedFollowUpId,
    sendingFollowUpId,
    taskStateReady,
  ]);

  const patchActiveTask = (patch: Partial<WorkbenchTask>) => {
    setTasks((current) =>
      current.map((task) => (task.id === activeTask.id ? { ...task, ...patch } : task)),
    );
    setDraftTask((current) =>
      current.id === activeTask.id ? { ...current, ...patch } : current,
    );
  };

  const updateTaskDraft = (taskId: string, draftText: string) => {
    if (selectedTask?.id === taskId) {
      setTasks((current) =>
        current.map((task) => task.id === taskId ? { ...task, draftText } : task),
      );
      return;
    }
    if (draftTask.id !== taskId) return;

    setDraftTask((current) => current.id === taskId ? { ...current, draftText } : current);
    if (!draftText.trim()) return;

    const task = { ...draftTask, draftText };
    setTasks((current) =>
      current.some((item) => item.id === taskId)
        ? current.map((item) => item.id === taskId ? { ...item, draftText } : item)
        : [task, ...current],
    );
    setOpenTaskIds((current) => current.includes(taskId) ? current : [...current, taskId]);
    setActiveTaskId(taskId);
    setDraftTabOpen(false);
  };

  const undoTaskTurn = async () => {
    if (!window.confirm("Undo the last turn and revert its captured workspace changes?")) return;
    const result = await agent.undoLastTurn();
    if (!result) return;
    updateTaskDraft(activeTask.id, result.prompt);
    if (result.attachments.length) {
      setRestoredAttachmentsByTask((current) => ({
        ...current,
        [activeTask.id]: result.attachments,
      }));
    }
  };

  const stageReviewContext = (attachment: AgentAttachment) => {
    setReviewContextByTask((current) => {
      const existing = current[activeTask.id] ?? [];
      return {
        ...current,
        [activeTask.id]: [
          ...existing.filter((item) => item.id !== attachment.id),
          attachment,
        ],
      };
    });
  };

  const removeReviewContext = (attachmentId: string) => {
    setReviewContextByTask((current) => ({
      ...current,
      [activeTask.id]: (current[activeTask.id] ?? []).filter((item) => item.id !== attachmentId),
    }));
  };

  const clearReviewContext = () => {
    setReviewContextByTask((current) => ({ ...current, [activeTask.id]: [] }));
  };

  const openFocusView = (view: FocusView) => {
    setFocusView(view);
    setFocusPanelOpen(true);
    closeSidebarOnNarrow();
  };

  const selectTaskTab = (tabId: string) => {
    setActiveTaskId(tabId === draftTask.id ? null : tabId);
    setActivePage("tasks");
    closeSidebarOnNarrow();
  };

  const closeTaskTab = (tabId: string) => {
    if (tabId === draftTask.id) {
      if (!openTaskIds.length) return;
      setDraftTabOpen(false);
      setDraftTask(createDraftTask(preferences.taskRunDefaults));
      if (activeTaskId === null) setActiveTaskId(openTaskIds.at(-1) ?? null);
      return;
    }

    const index = openTaskIds.indexOf(tabId);
    if (index === -1) return;
    const nextTaskIds = openTaskIds.filter((taskId) => taskId !== tabId);
    setOpenTaskIds(nextTaskIds);
    if (activeTaskId !== tabId) return;

    const nextTaskId = nextTaskIds[Math.min(index, nextTaskIds.length - 1)] ?? null;
    if (nextTaskId) {
      setActiveTaskId(nextTaskId);
      return;
    }
    setActiveTaskId(null);
    setDraftTabOpen(true);
    setDraftTask(createDraftTask(preferences.taskRunDefaults));
  };

  const createTask = (title: string): string | null => {
    if (!taskStateReady) return null;
    const task: WorkbenchTask = {
      ...createDraftTask(preferences.taskRunDefaults),
      title,
    };
    setTasks((current) => [task, ...current]);
    setOpenTaskIds((current) => current.includes(task.id) ? current : [...current, task.id]);
    setActiveTaskId(task.id);
    setDraftTabOpen(false);
    setDraftTask(createDraftTask(preferences.taskRunDefaults));
    setActivePage("tasks");
    return task.id;
  };

  const openNewTaskTab = () => {
    if (!createTask("New task")) return;
    setFocusPanelOpen(false);
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pendingScheduledPrompt || !taskStateReady) return;
      const due = scheduledTasks.find((task) => task.status === "pending" && task.runAt <= Date.now());
      if (!due) return;
      const taskId = createTask(titleFromPrompt(due.prompt));
      if (!taskId) return;
      setScheduledTasks((current) => current.map((task) => task.id === due.id ? { ...task, status: "running" } : task));
      setPendingScheduledPrompt({ id: due.id, taskId, prompt: due.prompt });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pendingScheduledPrompt, scheduledTasks, taskStateReady]);

  useEffect(() => {
    const scheduled = pendingScheduledPrompt;
    if (!scheduled || scheduled.taskId !== activeTask.id || agent.runtime.phase !== "ready" || scheduleSubmittingRef.current === scheduled.id) return;
    scheduleSubmittingRef.current = scheduled.id;
    void agent.submit(scheduled.prompt, []).then((success) => {
      if (!success) {
        setScheduledTasks((current) => current.map((task) => task.id === scheduled.id ? { ...task, status: "failed" } : task));
        setPendingScheduledPrompt(null);
        scheduleSubmittingRef.current = null;
        if (preferences.notifyErrors && "Notification" in window && Notification.permission === "granted") {
          new Notification("Xiao could not start a scheduled task", { body: scheduled.prompt });
        }
      }
    });
  }, [activeTask.id, agent, pendingScheduledPrompt, preferences.notifyErrors]);

  const scheduleTask = (prompt: string, runAt: number) => {
    setScheduledTasks((current) => [...current, { id: crypto.randomUUID(), prompt, runAt, status: "pending" }]);
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  };

  const setTaskArchived = async (taskId: string, archived: boolean) => {
    if (
      !taskStateReady ||
      (agent.runtime.phase === "working" && agent.runtime.taskId === taskId)
    ) return;
    const target = tasks.find((task) => task.id === taskId);
    if (target?.origin === "codex" && target.threadId) {
      try {
        await nativeBridge.agentRequest(
          archived ? "thread/archive" : "thread/unarchive",
          { threadId: target.threadId },
        );
        setCodexThreads((current) => current.map((thread) =>
          thread.id === target.threadId ? { ...thread, archived, updatedAt: Date.now() } : thread,
        ));
      } catch (reason) {
        console.error("Could not update the Codex archive.", reason);
        return;
      }
    }
    const updatedAt = Date.now();
    setTasks((current) => {
      const nextTasks = current.map((task) =>
        task.id === taskId
          ? { ...task, archived, pinned: archived ? false : task.pinned, updatedAt }
          : task,
      );

      if (archived && taskId === activeTaskId) {
        const nextActiveTask = nextTasks.find((task) => !task.archived);
        setActiveTaskId(nextActiveTask?.id ?? null);
        if (!nextActiveTask) setDraftTask(createDraftTask(preferences.taskRunDefaults));
      } else if (!archived && activeTaskId === null) {
        setActiveTaskId(taskId);
      }

      return nextTasks;
    });
  };

  const toggleTaskPinned = (taskId: string) => {
    if (!taskStateReady) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, pinned: !task.pinned, updatedAt: Date.now() } : task,
      ),
    );
  };

  const renameTask = async (taskId: string, title: string) => {
    const cleanTitle = title.trim();
    if (!taskStateReady || !cleanTitle) return;
    const target = tasks.find((task) => task.id === taskId);
    if (target?.origin === "codex" && target.threadId) {
      try {
        await nativeBridge.agentRequest("thread/name/set", {
          threadId: target.threadId,
          name: cleanTitle,
        });
        setCodexThreads((current) => current.map((thread) =>
          thread.id === target.threadId ? { ...thread, title: cleanTitle } : thread,
        ));
      } catch (reason) {
        console.error("Could not rename the Codex thread.", reason);
        return;
      }
    }
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, title: cleanTitle, updatedAt: Date.now() } : task,
      ),
    );
  };

  const markTaskUnread = (taskId: string, unread: boolean) => {
    if (!taskStateReady) return;
    setTasks((current) =>
      current.map((task) => task.id === taskId ? { ...task, unread } : task),
    );
  };

  const continueInNewTask = (taskId: string) => {
    if (!taskStateReady) return;
    const source = tasks.find((task) => task.id === taskId);
    if (!source) return;
    const createdAt = Date.now();
    const task: WorkbenchTask = {
      ...source,
      id: crypto.randomUUID(),
      title: `Continue: ${source.title}`,
      archived: false,
      pinned: false,
      unread: false,
      createdAt,
      updatedAt: createdAt,
      draftText: "",
      followUps: [],
      threadId: null,
      goal: null,
      meta: "Now",
      group: "Active",
      timeline: source.timeline.map((entry) => ({ ...entry })),
      plan: source.plan ? { ...source.plan, steps: source.plan.steps.map((step) => ({ ...step })) } : null,
    };
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setActivePage("tasks");
  };

  const updateProjectPreference = (path: string, update: ProjectPreference) => {
    const nextPreferences = {
      ...projectPreferences,
      [path]: { ...projectPreferences[path], ...update },
    };
    setProjectPreferences(nextPreferences);
    projectPreferencesRef.current = nextPreferences;
    writeProjectPreferences(nextPreferences);
    setProjects((current) => applyProjectPreferences(current, nextPreferences));
  };

  const toggleProjectPinned = (path: string) => {
    const project = projects.find((item) => item.path === path);
    updateProjectPreference(path, { pinned: !project?.pinned });
  };

  const renameProject = (path: string, name: string) => {
    updateProjectPreference(path, { name });
  };

  const openProject = (path: string) => {
    if (!isTauriHost()) return;
    void nativeBridge.openXiaoProject(path).catch((reason) => {
      console.error("Could not open project in the file manager.", reason);
    });
  };

  const archiveProjectTasks = async (path: string) => {
    const updatedAt = Date.now();
    if (path === workspace.path) {
      if (!taskStateReady) return;
      const nextTasks = tasks.map((task) =>
        task.archived
          ? task
          : { ...task, archived: true, pinned: false, updatedAt, meta: "Now" },
      );
      const nextState = {
        tasks: nextTasks,
        activeTaskId: null,
        showArchived: false,
      };
      try {
        if (isTauriHost()) {
          await enqueueDocumentSave(documentFromState(workspace.path, nextState));
        } else {
          window.localStorage.setItem(taskStorageKey(workspace.path), JSON.stringify(nextState));
        }
      } catch (reason) {
        console.error("Could not archive project tasks.", reason);
        return;
      }
      setTasks(nextTasks);
      setActiveTaskId(null);
      setDraftTask(createDraftTask(preferences.taskRunDefaults));
      setProjects((current) =>
        current.map((project) =>
          project.path === path ? { ...project, updatedAt } : project,
        ),
      );
      return;
    }
    if (!isTauriHost()) return;

    try {
      const document = await nativeBridge.loadXiaoWorkspace(path);
      if (!document) return;
      const nextTasks = document.tasks.map((task) =>
        task.archived ? task : { ...task, archived: true, pinned: false, updatedAt },
      );
      await enqueueDocumentSave({
        ...document,
        activeTaskId: null,
        tasks: nextTasks,
        showArchived: false,
      });
      setProjects((current) =>
        current.map((project) =>
          project.path === path ? { ...project, updatedAt } : project,
        ),
      );
    } catch (reason) {
      console.error("Could not archive project tasks.", reason);
    }
  };

  const removeProject = (path: string) => {
    if (workspace.path === path && agent.runtime.phase === "working") return;
    const fallback = projects.find((project) => project.path !== path);
    updateProjectPreference(path, { hidden: true });
    if (workspace.path === path && fallback) {
      setActiveProjectPath(fallback.path);
      setActivePage("tasks");
      setFocusPanelOpen(false);
    }
  };

  const refreshArchivedTasks = useCallback(async () => {
    const refreshId = ++archivedRefreshId.current;
    setArchivedTasksLoading(true);
    setArchivedTasksError(null);

    try {
      const currentProjectName =
        projects.find((project) => project.path === workspace.path)?.name ?? workspace.name;
      const nextItems: ArchivedTaskItem[] = tasks
        .filter((task) => task.archived)
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          updatedAt: task.updatedAt,
          projectPath: workspace.path,
          projectName: currentProjectName,
          origin: task.origin,
          threadId: task.threadId,
        }));

      for (const thread of codexThreads.filter((item) => item.archived)) {
        const projectName =
          projects.find((project) => sameWorkspacePath(project.path, thread.cwd))?.name ??
          thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) ??
          thread.cwd;
        nextItems.push({
          taskId: `codex:${thread.id}`,
          title: thread.title,
          updatedAt: thread.updatedAt,
          projectPath: thread.cwd,
          projectName,
          origin: "codex",
          threadId: thread.id,
        });
      }

      if (isTauriHost()) {
        const otherProjects = projects.filter((project) => project.path !== workspace.path);
        const documents = await Promise.all(
          otherProjects.map(async (project) => ({
            project,
            document: await nativeBridge.loadXiaoWorkspace(project.path),
          })),
        );
        for (const { project, document } of documents) {
          if (!document) continue;
          for (const task of document.tasks) {
            if (!task.archived) continue;
            nextItems.push({
              taskId: task.id,
              title: task.title,
              updatedAt: task.updatedAt,
              projectPath: project.path,
              projectName: project.name,
            });
          }
        }
      }

      const uniqueItems = new Map(
        nextItems.map((item) => [`${item.projectPath}\u0000${item.taskId}`, item]),
      );
      if (refreshId !== archivedRefreshId.current) return;
      setArchivedTasks([...uniqueItems.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (reason) {
      if (refreshId !== archivedRefreshId.current) return;
      setArchivedTasksError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (refreshId === archivedRefreshId.current) setArchivedTasksLoading(false);
    }
  }, [codexThreads, projects, tasks, workspace.name, workspace.path]);

  const restoreArchivedTask = async (item: ArchivedTaskItem) => {
    if (item.origin === "codex" && item.threadId) {
      try {
        await nativeBridge.agentRequest("thread/unarchive", { threadId: item.threadId });
        setCodexThreads((current) => current.map((thread) =>
          thread.id === item.threadId ? { ...thread, archived: false, updatedAt: Date.now() } : thread,
        ));
        setArchivedTasks((current) => current.filter((task) => task.threadId !== item.threadId));
      } catch (reason) {
        setArchivedTasksError(reason instanceof Error ? reason.message : String(reason));
      }
      return;
    }
    if (item.projectPath === workspace.path) {
      if (!taskStateReady) return;
      setTaskArchived(item.taskId, false);
      setArchivedTasks((current) =>
        current.filter(
          (task) => task.projectPath !== item.projectPath || task.taskId !== item.taskId,
        ),
      );
      return;
    }
    if (!isTauriHost()) return;

    try {
      const document = await nativeBridge.loadXiaoWorkspace(item.projectPath);
      if (!document) return;
      const updatedAt = Date.now();
      const tasks = document.tasks.map((task) =>
        task.id === item.taskId ? { ...task, archived: false, updatedAt } : task,
      );
      await enqueueDocumentSave({ ...document, tasks, showArchived: false });
      setArchivedTasks((current) =>
        current.filter(
          (task) => task.projectPath !== item.projectPath || task.taskId !== item.taskId,
        ),
      );
      setProjects((current) =>
        current.map((project) =>
          project.path === item.projectPath ? { ...project, updatedAt } : project,
        ),
      );
    } catch (reason) {
      setArchivedTasksError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const addProject = async () => {
    if (agent.runtime.phase === "working") return;
    if (!isTauriHost()) return;
    const selected = await open({ directory: true, multiple: false, title: "Add a project to Xiao" });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).filter(Boolean).at(-1) ?? selected;
    const nextPreferences = {
      ...projectPreferences,
      [selected]: { ...projectPreferences[selected], hidden: false },
    };
    setProjectPreferences(nextPreferences);
    managedProjectPathsRef.current.add(projectPathKey(selected));
    projectPreferencesRef.current = nextPreferences;
    writeProjectPreferences(nextPreferences);
    setProjects((current) =>
      applyProjectPreferences(
        mergeProject(current, { path: selected, name, updatedAt: Date.now() }),
        nextPreferences,
      ),
    );
    setActiveProjectPath(selected);
    setActivePage("tasks");
    setFocusPanelOpen(false);
  };

  useEffect(() => {
    if (activePage !== "settings") return;
    void refreshArchivedTasks();
    return () => {
      archivedRefreshId.current += 1;
    };
  }, [activePage, refreshArchivedTasks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandMenuOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        openNewTaskTab();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w" && activePage === "tasks") {
        event.preventDefault();
        closeTaskTab(activeTaskId ?? draftTask.id);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        openFocusView("runtime");
      }
      if (event.key === "Escape") setCommandMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePage, activeTaskId, draftTask.id, draftTabOpen, openTaskIds]);

  return (
    <>
      <GlobalContextMenu />
      <AppShell
        sidebarOpen={sidebarOpen}
        onCloseSidebar={closeSidebar}
        titleBar={
          <TitleBar
            tabs={titleBarTabs}
            activeTabId={activeTaskId ?? draftTask.id}
            sidebarOpen={sidebarOpen}
            onOpenMenu={() => setCommandMenuOpen(true)}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            onSelectTab={selectTaskTab}
            onCloseTab={closeTaskTab}
            onNewTab={openNewTaskTab}
            update={codexUpdate.status?.updateAvailable && codexUpdate.status.canUpdate ? {
              version: codexUpdate.status.latestVersion,
              installing: codexUpdate.updating,
              disabled: codexUpdate.updating || agent.runtime.phase === "working" || agent.runtime.phase === "starting",
              onInstall: () => {
                void codexUpdate.install().then((result) => {
                  if (result) void refresh();
                });
              },
            } : undefined}
          />
        }
        sidebar={
          <Sidebar
            activePage={activePage}
            projects={projects}
            activeProjectPath={workspace.path}
            tasks={tasks}
            activeTaskId={selectedTask?.id ?? ""}
            workspace={workspace}
            runtime={agent.runtime}
            account={agent.account}
            rateLimits={agent.rateLimits}
            codexThreads={preferences.importCodexHistory ? codexThreads : []}
            threadTokenUsage={threadTokenUsage}
            profile={profile}
            canOpenProjects={isTauriHost()}
            onOpenSidebar={openSidebar}
            onOpenMenu={() => setCommandMenuOpen(true)}
            onOpenProfile={() => {
              setActivePage("profile");
              setFocusPanelOpen(false);
              closeSidebarOnNarrow();
            }}
            onOpenSettings={() => {
              setActivePage("settings");
              setFocusPanelOpen(false);
              closeSidebarOnNarrow();
            }}
            onOpenTasks={() => {
              setActivePage("tasks");
              closeSidebarOnNarrow();
            }}
            onAddProject={() => void addProject()}
            onSelectProject={(path) => {
              if (agent.runtime.phase === "working") return;
              openProjectWithoutTaskRef.current = true;
              setActiveProjectPath(path);
              setActivePage("tasks");
              setFocusPanelOpen(false);
              closeSidebarOnNarrow();
            }}
            onCreateTask={createTask}
            onSelectTask={(taskId) => {
              setActiveTaskId(taskId);
              setActivePage("tasks");
              closeSidebarOnNarrow();
            }}
            onSelectCodexThread={(thread) => {
              if (agent.runtime.phase === "working") return;
              pendingCodexThreadRef.current = thread.id;
              setTaskWorkspacePath("");
              setActiveProjectPath(thread.cwd);
              setActivePage("tasks");
              setFocusPanelOpen(false);
              closeSidebarOnNarrow();
            }}
            onToggleTaskPinned={toggleTaskPinned}
            onSetTaskArchived={setTaskArchived}
            onRenameTask={renameTask}
            onMarkTaskUnread={markTaskUnread}
            onContinueInNewTask={continueInNewTask}
            onToggleProjectPinned={toggleProjectPinned}
            onOpenProject={openProject}
            onRenameProject={renameProject}
            onArchiveProjectTasks={(path) => void archiveProjectTasks(path)}
            onRemoveProject={removeProject}
          />
        }
        content={
          activePage === "settings" ? (
            <SettingsPage
              theme={theme}
              preferences={preferences}
              models={agent.models}
              account={agent.account}
              runtime={agent.runtime}
              system={system}
              codexUpdate={codexUpdate.status}
              codexUpdateResult={codexUpdate.result}
              codexUpdateChecking={codexUpdate.checking}
              codexUpdating={codexUpdate.updating}
              codexUpdateError={codexUpdate.error}
              archivedTasks={archivedTasks}
              archivedTasksLoading={archivedTasksLoading}
              archivedTasksError={archivedTasksError}
              onThemeChange={setTheme}
              onPreferencesChange={updatePreferences}
              onRestoreArchivedTask={(item) => void restoreArchivedTask(item)}
              onReloadArchivedTasks={() => void refreshArchivedTasks()}
              onReconnect={() => void agent.connect()}
              onCheckCodexUpdate={() => void codexUpdate.check()}
              onUpdateCodex={() => {
                void codexUpdate.install().then((result) => {
                  if (result) void refresh();
                });
              }}
              onClose={() => setActivePage("tasks")}
            />
          ) : activePage === "profile" ? (
            <ProfilePage
              accountUsage={agent.accountUsage}
              profile={profile}
              runtime={agent.runtime}
              usage={agent.usage}
              onClose={() => setActivePage("tasks")}
              onSaveProfile={saveProfile}
            />
          ) : (
            <TaskWorkspace
              taskId={activeTask.id}
              taskTitle={activeTask.title}
              taskArchived={activeTask.archived}
              launchMode={focusedLaunch}
              taskStateError={taskStateError}
              timeline={agent.timeline}
              runtime={agent.runtime}
              models={visibleModels}
              selectedModel={activeTask.model}
              selectedReasoningEffort={activeTask.reasoningEffort}
              mode={activeTask.mode}
              approvalPolicy={activeTask.approvalPolicy}
              sandboxMode={activeTask.sandboxMode}
              goal={activeTask.goal}
              plan={activeTask.plan}
              reviewContext={pendingReviewContext}
              questionRequest={agent.questionRequest}
              draftText={activeTask.draftText}
              followUps={activeTask.followUps}
              sendingFollowUpId={sendingFollowUpId}
              failedFollowUpId={failedFollowUpId}
              restoredAttachments={restoredAttachmentsByTask[activeTask.id] ?? []}
              canCompact={agent.canCompact}
              compacting={agent.compacting}
              hasThread={agent.hasThread}
              canUndo={agent.canUndo && activeTask.followUps.length === 0}
              undoing={agent.undoing}
              contextUsage={agent.contextUsage}
              showReasoningSummaries={preferences.showReasoningSummaries}
              expandToolOutput={preferences.expandToolOutput}
              historyHasMore={Boolean(activeTask.historyCursor)}
              historyLoadingOlder={Boolean(activeTask.historyLoadingOlder)}
              workspace={workspace}
              onModelChange={(model) => {
                patchActiveTask({ model, reasoningEffort: null });
                updateTaskRunDefaults({ model, reasoningEffort: null });
              }}
              onReasoningEffortChange={(reasoningEffort) => {
                patchActiveTask({ reasoningEffort });
                updateTaskRunDefaults({ reasoningEffort });
              }}
              onModeChange={(mode) => {
                patchActiveTask({ mode });
                updateTaskRunDefaults({ mode });
              }}
              onApprovalPolicyChange={(approvalPolicy) => {
                patchActiveTask({ approvalPolicy });
                updateTaskRunDefaults({ approvalPolicy });
                void agent.setApprovalPolicy(approvalPolicy);
              }}
              onSandboxModeChange={(sandboxMode) => {
                patchActiveTask({ sandboxMode });
                updateTaskRunDefaults({ sandboxMode });
              }}
              onGoalSet={agent.setGoal}
              onGoalClear={agent.clearGoal}
              onInterrupt={agent.interrupt}
              onSubmit={submitTask}
              onQueueFollowUp={queueTaskFollowUp}
              onRemoveFollowUp={removeTaskFollowUp}
              onSendFollowUpNow={sendTaskFollowUpNow}
              onRetryFollowUp={() => setFailedFollowUpId(null)}
              onRestoredAttachmentsConsumed={() => setRestoredAttachmentsByTask((current) => {
                if (!current[activeTask.id]) return current;
                const next = { ...current };
                delete next[activeTask.id];
                return next;
              })}
              onCompact={agent.compact}
              onUndo={() => void undoTaskTurn()}
              onRemoveReviewContext={removeReviewContext}
              onReviewContextSent={clearReviewContext}
              onResolveQuestion={agent.resolveQuestion}
              onDraftChange={(draftText) => updateTaskDraft(activeTask.id, draftText)}
              onResolveApproval={agent.resolveApproval}
              onFocusView={openFocusView}
              onToggleArchived={() => {
                if (selectedTask) setTaskArchived(selectedTask.id, !selectedTask.archived);
              }}
              onLoadOlderHistory={() => void loadOlderCodexHistory()}
            />
          )
        }
        focusRail={
          activePage === "tasks" && focusPanelOpen ? (
            <FocusRail
              activeView={focusView}
              onViewChange={setFocusView}
              onClose={() => setFocusPanelOpen(false)}
              workspace={workspace}
              system={system}
              runtime={agent.runtime}
              task={activeTask}
              timeline={agent.timeline}
              models={agent.models}
              contextUsage={agent.contextUsage}
              plan={activeTask.plan}
              runtimeLogs={agent.runtimeLogs}
              loading={loading}
              error={workspaceError}
              onRefresh={refresh}
              onLoadDirectory={loadDirectory}
              scheduledTasks={scheduledTasks}
              onScheduleTask={scheduleTask}
              onRemoveScheduledTask={(id) => setScheduledTasks((current) => current.filter((task) => task.id !== id))}
              reviewContext={pendingReviewContext}
              onStageReviewContext={stageReviewContext}
              onRemoveReviewContext={removeReviewContext}
              obscured={commandMenuOpen}
            />
          ) : null
        }
      />

      <CommandMenu
        open={commandMenuOpen}
        tasks={tasks}
        workspace={workspace}
        onClose={() => setCommandMenuOpen(false)}
        onSelectTask={(taskId) => {
          setActiveTaskId(taskId);
          setActivePage("tasks");
          setCommandMenuOpen(false);
        }}
        onSelectView={(view) => {
          setActivePage("tasks");
          openFocusView(view);
          setCommandMenuOpen(false);
        }}
      />
    </>
  );
}
