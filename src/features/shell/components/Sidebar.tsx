import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentAccountSummary,
  AgentRateLimits,
  AgentThreadTokenUsage,
  CodexThreadSummary,
  ThreadChangeSummary,
} from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoProjectSummary } from "../../../core/models/xiao";
import { profileInitials, type LocalUserProfile } from "../../profile/hooks/useLocalProfile";
import type { WorkbenchTask } from "../../task/task.types";
import type { AppPage } from "../shell.types";
import { UsageDetailsDialog } from "./UsageDetailsDialog";

type SidebarProps = {
  activePage: AppPage;
  projects: XiaoProjectSummary[];
  activeProjectPath: string;
  tasks: WorkbenchTask[];
  activeTaskId: string;
  workspace: WorkspaceSnapshot;
  workingTaskIds: string[];
  account: AgentAccountSummary | null;
  rateLimits: AgentRateLimits | null;
  codexThreads: CodexThreadSummary[];
  threadTokenUsage: AgentThreadTokenUsage[];
  threadChangeSummaries: Record<string, ThreadChangeSummary | null>;
  profile: LocalUserProfile;
  canOpenProjects: boolean;
  onOpenSidebar: () => void;
  onOpenMenu: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  onAddProject: () => void;
  onSelectProject: (path: string) => void;
  onCreateTask: (title: string) => void;
  onSelectTask: (taskId: string) => void;
  onPrefetchTask: (taskId: string) => void;
  onSelectCodexThread: (thread: CodexThreadSummary) => void;
  onPrefetchCodexThread: (threadId: string) => void;
  onToggleTaskPinned: (taskId: string) => void;
  onSetTaskArchived: (taskId: string, archived: boolean) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMarkTaskUnread: (taskId: string, unread: boolean) => void;
  onContinueInNewTask: (taskId: string) => void;
  onToggleProjectPinned: (path: string) => void;
  onOpenProject: (path: string) => void;
  onRenameProject: (path: string, name: string) => void;
  onArchiveProjectTasks: (path: string) => void;
  onRemoveProject: (path: string) => void;
};

type ProjectMenuState = {
  projectPath: string;
  top: number;
  left: number;
  focusFirst: boolean;
};

type RenamingProject = {
  path: string;
  name: string;
};

type TaskMenuState = {
  taskId: string;
  top: number;
  left: number;
  focusFirst: boolean;
};

type RenamingTask = {
  id: string;
  title: string;
};

const projectMenuWidth = 218;
const projectMenuHeight = 250;
const taskMenuHeight = 330;
const sidebarDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const sameProjectPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLocaleLowerCase() ===
  right.replace(/[\\/]+$/, "").toLocaleLowerCase();
const monthGroupFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const startOfDay = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const relativeTime = (timestamp: number, now: number) => {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return "yesterday";
  return sidebarDateFormatter.format(new Date(timestamp));
};

const groupForTask = (task: WorkbenchTask, now: number) => {
  const today = startOfDay(now);
  const taskDay = startOfDay(task.updatedAt);
  if (taskDay === today) return "Today";
  if (taskDay === today - 86_400_000) return "Yesterday";
  const todayDate = new Date(today);
  const startOfWeek = today - ((todayDate.getDay() + 6) % 7) * 86_400_000;
  if (taskDay >= startOfWeek) return "This week";
  const taskDate = new Date(task.updatedAt);
  if (taskDate.getFullYear() === todayDate.getFullYear() && taskDate.getMonth() === todayDate.getMonth()) return "Earlier this month";
  return monthGroupFormatter.format(taskDate);
};

const taskChangeSummary = (task: WorkbenchTask, fallback?: ThreadChangeSummary | null) => {
  for (let index = task.timeline.length - 1; index >= 0; index -= 1) {
    const files = task.timeline[index]?.files;
    if (!files?.length) continue;
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return additions || deletions ? { additions, deletions } : null;
  }
  return fallback ?? null;
};

const isSidebarDraft = (task: WorkbenchTask) =>
  !task.threadId && !task.timeline.length && !task.draftText.trim() && task.title === "New task";

export function Sidebar({
  activePage,
  projects,
  activeProjectPath,
  tasks,
  activeTaskId,
  workspace,
  workingTaskIds,
  account,
  rateLimits,
  codexThreads,
  threadTokenUsage,
  threadChangeSummaries,
  profile,
  canOpenProjects,
  onOpenSidebar,
  onOpenMenu,
  onOpenProfile,
  onOpenSettings,
  onOpenTasks,
  onAddProject,
  onSelectProject,
  onCreateTask,
  onSelectTask,
  onPrefetchTask,
  onSelectCodexThread,
  onPrefetchCodexThread,
  onToggleTaskPinned,
  onSetTaskArchived,
  onRenameTask,
  onMarkTaskUnread,
  onContinueInNewTask,
  onToggleProjectPinned,
  onOpenProject,
  onRenameProject,
  onArchiveProjectTasks,
  onRemoveProject,
}: SidebarProps) {
  const [creatingTaskProjectPath, setCreatingTaskProjectPath] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [expandedProjectPath, setExpandedProjectPath] = useState<string | null>(activeProjectPath);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [renamingProject, setRenamingProject] = useState<RenamingProject | null>(null);
  const [taskMenu, setTaskMenu] = useState<TaskMenuState | null>(null);
  const [renamingTask, setRenamingTask] = useState<RenamingTask | null>(null);
  const [now, setNow] = useState(Date.now);
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuTriggerRef = useRef<HTMLElement | null>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const taskMenuTriggerRef = useRef<HTMLElement | null>(null);
  const visibleTasks = useMemo(() => [...tasks]
    .filter((task) =>
      !task.archived &&
      (task.origin !== "codex" || !task.sourceCwd || sameProjectPath(task.sourceCwd, activeProjectPath)),
    )
    .sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      Number(isSidebarDraft(left)) - Number(isSidebarDraft(right)) ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt,
    ),
  [activeProjectPath, tasks]);
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, WorkbenchTask[]>();
    for (const task of visibleTasks) {
      const group = groupForTask(task, now);
      groups.set(group, [...(groups.get(group) ?? []), task]);
    }
    const priority = ["Today", "Yesterday", "This week", "Earlier this month"];
    return [...groups]
      .map(([group, groupTasks]) => ({ group, tasks: groupTasks }))
      .sort((left, right) => {
        const leftIndex = priority.indexOf(left.group);
        const rightIndex = priority.indexOf(right.group);
        if (leftIndex < 0 && rightIndex < 0) return right.tasks[0].updatedAt - left.tasks[0].updatedAt;
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
       return leftIndex - rightIndex;
      });
  }, [now, visibleTasks]);
  const menuProject = projects.find((project) => project.path === projectMenu?.projectPath);
  const menuTask = tasks.find((task) => task.id === taskMenu?.taskId);
  const workingTasks = new Set(workingTaskIds);
  const projectSwitchLocked = workingTasks.size > 0;
  const initials = profileInitials(profile.name);
  const quotaWindows = [
    rateLimits?.primary ? { label: "Session", window: rateLimits.primary } : null,
    rateLimits?.secondary ? { label: "Weekly", window: rateLimits.secondary } : null,
  ].filter((item): item is NonNullable<typeof item> => item != null);
  const otherCodexThreads = codexThreads.filter(
    (thread) => !thread.archived && !projects.some((project) => sameProjectPath(project.path, thread.cwd)),
  );

  const closeProjectMenu = (restoreFocus = false) => {
    const trigger = projectMenuTriggerRef.current;
    projectMenuTriggerRef.current = null;
    setProjectMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus());
  };

  const closeTaskMenu = (restoreFocus = false) => {
    const trigger = taskMenuTriggerRef.current;
    taskMenuTriggerRef.current = null;
    setTaskMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus());
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (!items.length) return;

    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? activeIndex <= 0
              ? items.length - 1
              : activeIndex - 1
            : activeIndex >= items.length - 1
              ? 0
              : activeIndex + 1;
    items[nextIndex]?.focus();
  };

  const createTask = () => {
    const title = draftTitle.trim();
    if (!title) return;
    onCreateTask(title);
    setDraftTitle("");
    setCreatingTaskProjectPath(null);
    onOpenTasks();
  };

  const cancelCreate = () => {
    setDraftTitle("");
    setCreatingTaskProjectPath(null);
  };

  const openTaskComposer = (projectPath: string) => {
    if (projectSwitchLocked && projectPath !== activeProjectPath) return;
    closeProjectMenu();
    closeTaskMenu();
    if (projectPath !== activeProjectPath) onSelectProject(projectPath);
    setExpandedProjectPath(projectPath);
    setCreatingTaskProjectPath(projectPath);
    onOpenSidebar();
  };

  const toggleProjectMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    projectPath: string,
  ) => {
    closeTaskMenu();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const below = bounds.bottom + 6;
    const top =
      below + projectMenuHeight <= window.innerHeight
        ? below
        : Math.max(8, bounds.top - projectMenuHeight - 6);
    const left = Math.max(
      8,
      Math.min(bounds.right - 46, window.innerWidth - projectMenuWidth - 8),
    );

    if (projectMenu?.projectPath === projectPath) {
      closeProjectMenu();
      return;
    }
    projectMenuTriggerRef.current = trigger;
    setProjectMenu({ projectPath, top, left, focusFirst: event.detail === 0 });
  };

  const openProjectContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    projectPath: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    closeTaskMenu();
    projectMenuTriggerRef.current = event.currentTarget;
    setProjectMenu({
      projectPath,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - projectMenuHeight - 8)),
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - projectMenuWidth - 8)),
      focusFirst: false,
    });
  };

  const openTaskContextMenu = (event: ReactMouseEvent<HTMLElement>, taskId: string) => {
    event.preventDefault();
    event.stopPropagation();
    closeProjectMenu();
    taskMenuTriggerRef.current = event.currentTarget;
    setTaskMenu({
      taskId,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - taskMenuHeight - 8)),
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - projectMenuWidth - 8)),
      focusFirst: false,
    });
  };

  const toggleTaskMenu = (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => {
    closeProjectMenu();
    if (taskMenu?.taskId === taskId) {
      closeTaskMenu();
      return;
    }

    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const below = bounds.bottom + 6;
    const top =
      below + taskMenuHeight <= window.innerHeight
        ? below
        : Math.max(8, bounds.top - taskMenuHeight - 6);
    const left = Math.max(
      8,
      Math.min(bounds.right - 46, window.innerWidth - projectMenuWidth - 8),
    );
    taskMenuTriggerRef.current = trigger;
    setTaskMenu({ taskId, top, left, focusFirst: event.detail === 0 });
  };

  const commitTaskRename = () => {
    if (!renamingTask) return;
    const title = renamingTask.title.trim();
    if (title) onRenameTask(renamingTask.id, title);
    setRenamingTask(null);
  };

  const copyText = (value: string) => {
    closeTaskMenu();
    void navigator.clipboard.writeText(value);
  };

  const beginProjectRename = (project: XiaoProjectSummary) => {
    closeProjectMenu();
    setRenamingProject({ path: project.path, name: project.name });
  };

  const commitProjectRename = () => {
    if (!renamingProject) return;
    const name = renamingProject.name.trim();
    if (name) onRenameProject(renamingProject.path, name);
    setRenamingProject(null);
  };

  useEffect(() => {
    setExpandedProjectPath(activeProjectPath);
  }, [activeProjectPath]);

  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(Date.now());
      interval = window.setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setExpandedProjectPath(activeProjectPath);
        setCreatingTaskProjectPath(activeProjectPath);
        onOpenSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProjectPath, onOpenSidebar]);

  useEffect(() => {
    if (!projectMenu) return;

    const focusFrame = projectMenu.focusFirst
      ? window.requestAnimationFrame(() => {
          projectMenuRef.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus({ preventScroll: true });
        })
      : null;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        projectMenuRef.current?.contains(target) ||
        projectMenuTriggerRef.current?.contains(target)
      ) {
        return;
      }
      closeProjectMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = projectMenuTriggerRef.current;
      closeProjectMenu();
      trigger?.focus();
    };
    const closeOnViewportChange = () => closeProjectMenu();

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    document.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      document.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!taskMenu) return;
    const focusFrame = taskMenu.focusFirst
      ? window.requestAnimationFrame(() => {
          taskMenuRef.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus({ preventScroll: true });
        })
      : null;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (taskMenuRef.current?.contains(target) || taskMenuTriggerRef.current?.contains(target)) {
        return;
      }
      closeTaskMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTaskMenu(true);
    };
    const closeOnViewportChange = () => closeTaskMenu();
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    document.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      document.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [taskMenu]);

  return (
    <>
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar__primary-nav">
          <button
            className="sidebar__new-task"
            type="button"
            aria-keyshortcuts="Control+N Meta+N"
            onClick={() => openTaskComposer(activeProjectPath)}
          >
            <XiaoIcon name="add" size={18} />
            <span>New task</span>
            <kbd>Ctrl N</kbd>
          </button>
          <button className="sidebar__search" onClick={onOpenMenu}>
            <XiaoIcon name="search" size={18} />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <div className="sidebar__projects-heading">
          <span>Projects</span>
          <button
            aria-label="Add project"
            disabled={projectSwitchLocked}
            title={projectSwitchLocked ? "Wait for the active task to finish" : undefined}
            onClick={onAddProject}
          >
            <XiaoIcon name="add" size={15} />
          </button>
        </div>

        <div className="sidebar__projects">
          {projects.map((project) => {
            const active = project.path === activeProjectPath;
            const expanded = active && expandedProjectPath === project.path;
            const menuOpen = projectMenu?.projectPath === project.path;
            const renaming = renamingProject?.path === project.path;
            const running = active && workingTasks.size > 0;
            const updatedAt = active
              ? Math.max(project.updatedAt, ...visibleTasks.map((task) => task.updatedAt))
              : project.updatedAt;
            const status = running
              ? "Running"
              : !active && projectSwitchLocked
                ? "Locked: task running"
                : `Updated ${relativeTime(updatedAt, now)}`;
            return (
              <section
                className={`sidebar-project ${active ? "is-active" : ""} ${menuOpen ? "has-open-menu" : ""}`}
                key={project.path}
                onContextMenu={(event) => openProjectContextMenu(event, project.path)}
              >
                <div className="sidebar-project__row">
                  {renaming ? (
                    <form
                      className="sidebar-project__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        commitProjectRename();
                      }}
                    >
                      <XiaoIcon name="folder" size={16} />
                      <input
                        aria-label={`Rename ${project.name}`}
                        autoFocus
                        value={renamingProject.name}
                        onBlur={commitProjectRename}
                        onChange={(event) =>
                          setRenamingProject({ path: project.path, name: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setRenamingProject(null);
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        className="sidebar-project__select"
                        title={project.path}
                        aria-expanded={expanded}
                        disabled={!active && projectSwitchLocked}
                        onClick={() => {
                          if (active) {
                            setExpandedProjectPath((currentPath) =>
                              currentPath === project.path ? null : project.path,
                            );
                            return;
                          }
                          setExpandedProjectPath(project.path);
                          onSelectProject(project.path);
                        }}
                      >
                        <span className={`sidebar-project__chevron ${expanded ? "is-expanded" : ""}`}>
                          <XiaoIcon name="caret" size={13} />
                        </span>
                        <XiaoIcon name={expanded ? "folderOpen" : "folder"} size={16} />
                        <span className="sidebar-project__copy">
                          <span className="sidebar-project__title">
                            <strong>{project.name}</strong>
                            {project.pinned ? (
                              <XiaoIcon className="sidebar-project__pin" name="pin" size={11} />
                            ) : null}
                          </span>
                          <small className={running ? "is-running" : ""}>
                            {running ? <i aria-hidden="true" /> : null}
                            {status}
                          </small>
                        </span>
                      </button>
                      <div className="sidebar-project__actions">
                        <button
                          className="sidebar-project__menu-trigger"
                          type="button"
                          aria-label={`Project actions for ${project.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          title="Project actions"
                          onClick={(event) => toggleProjectMenu(event, project.path)}
                        >
                          <XiaoIcon name="more" size={15} />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {expanded ? (
                  <div className="sidebar-project__tasks">
                    {creatingTaskProjectPath === project.path ? (
                      <div className="sidebar__create-task">
                        <input
                          aria-label="Task title"
                          autoFocus
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") createTask();
                            if (event.key === "Escape") cancelCreate();
                          }}
                          placeholder="Name this task"
                          value={draftTitle}
                        />
                        <button disabled={!draftTitle.trim()} onClick={createTask}>Create</button>
                        <button
                          aria-label="Cancel new task"
                          className="sidebar__create-cancel"
                          onClick={cancelCreate}
                        >
                          <XiaoIcon name="close" size={13} />
                        </button>
                      </div>
                    ) : null}

                    <div className="task-groups">
                      {groupedTasks.map(({ group, tasks: groupTasks }) => {
                        const groupId = `task-group-${group.toLowerCase().replaceAll(" ", "-")}`;
                        return (
                          <section className="task-group" aria-labelledby={groupId} key={group}>
                            <h3 id={groupId}>{group}</h3>
                            <div className="task-list">
                              {groupTasks.map((task) => {
                                const selected = activePage === "tasks" && task.id === activeTaskId;
                                const taskRunning = workingTasks.has(task.id);
                                const taskMenuOpen = taskMenu?.taskId === task.id;
                                const taskMeta = taskRunning
                                  ? "Running"
                                  : task.meta === "Draft" || (task.timelineEntryCount === 0 && !task.threadId)
                                    ? "Draft"
                                    : `Updated ${relativeTime(task.updatedAt, now)}`;
                                const stateLabel = taskRunning
                                  ? ", running"
                                  : task.unread
                                    ? ", unread"
                                    : "";
                                const changeSummary = taskChangeSummary(task, task.threadId ? threadChangeSummaries[task.threadId] : null);
                                return (
                                  <div
                                    className={`task-list__row ${task.unread ? "is-unread" : ""} ${
                                      taskRunning ? "is-running" : ""
                                    } ${taskMenuOpen ? "has-open-menu" : ""}`}
                                    key={task.id}
                                    onContextMenu={(event) => openTaskContextMenu(event, task.id)}
                                  >
                                    {renamingTask?.id === task.id ? (
                                      <form
                                        className="task-list__rename"
                                        onSubmit={(event) => {
                                          event.preventDefault();
                                          commitTaskRename();
                                        }}
                                      >
                                        <input
                                          autoFocus
                                          aria-label="Rename task"
                                          value={renamingTask.title}
                                          onBlur={commitTaskRename}
                                          onChange={(event) =>
                                            setRenamingTask({ id: task.id, title: event.target.value })
                                          }
                                          onKeyDown={(event) => {
                                            if (event.key === "Escape") {
                                              event.preventDefault();
                                              setRenamingTask(null);
                                            }
                                          }}
                                        />
                                      </form>
                                    ) : (
                                      <>
                                        <button
                                          className={`task-list__item ${selected ? "is-selected" : ""}`}
                                          aria-label={`${task.title}${stateLabel}${task.pinned ? ", pinned" : ""}`}
                                          title={task.title}
                                          onFocus={() => onPrefetchTask(task.id)}
                                          onPointerEnter={() => onPrefetchTask(task.id)}
                                          onClick={() => {
                                            onMarkTaskUnread(task.id, false);
                                            onSelectTask(task.id);
                                            onOpenTasks();
                                          }}
                                        >
                                          <span className="task-list__state" aria-hidden="true">
                                            {taskRunning ? (
                                              <XiaoIcon className="task-list__spinner" name="pending" size={13} />
                                            ) : task.unread ? (
                                              <i />
                                            ) : null}
                                          </span>
                                          <span className="task-list__copy">
                                            <span className="task-list__title">{task.title}</span>
                                            <small><span>{taskMeta}</span>{changeSummary ? <i className="task-list__change-pill"><b>+{changeSummary.additions}</b><em>-{changeSummary.deletions}</em></i> : null}</small>
                                          </span>
                                          {task.pinned ? (
                                            <XiaoIcon className="task-list__pin" name="pin" size={12} />
                                          ) : null}
                                        </button>
                                        <button
                                          className="task-list__menu-trigger"
                                          type="button"
                                          aria-label={`Task actions for ${task.title}`}
                                          aria-haspopup="menu"
                                          aria-expanded={taskMenuOpen}
                                          title="Task actions"
                                          onClick={(event) => toggleTaskMenu(event, task.id)}
                                        >
                                          <XiaoIcon name="more" size={15} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>

                    {!visibleTasks.length ? (
                      <p className="sidebar__empty">No tasks in this project.</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
          {otherCodexThreads.length ? (
            <section className="sidebar-other-chats" aria-label="Other Codex chats">
              <div className="sidebar-other-chats__heading">
                <XiaoIcon name="branch" size={15} />
                <span>Other Codex chats</span>
                <small>{otherCodexThreads.length}</small>
              </div>
              <div className="sidebar-other-chats__list">
                {otherCodexThreads.map((thread) => {
                  const selected = activePage === "tasks" && activeTaskId === `codex:${thread.id}`;
                  return (
                    <button
                      className={selected ? "is-selected" : ""}
                      key={thread.id}
                      type="button"
                      title={`${thread.title}\n${thread.cwd}`}
                      disabled={projectSwitchLocked && !selected}
                      onFocus={() => onPrefetchCodexThread(thread.id)}
                      onPointerEnter={() => onPrefetchCodexThread(thread.id)}
                      onClick={() => onSelectCodexThread(thread)}
                    >
                      <span>{thread.title}</span>
                      <small>{thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Outside projects"} · {relativeTime(thread.updatedAt, now)}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        <section className="sidebar-usage" aria-label="Codex usage remaining">
          <button className="sidebar-usage__open" type="button" onClick={() => setUsageDetailsOpen(true)}>
            <span><XiaoIcon name="runtime" size={13} />Usage remaining</span>
            <XiaoIcon name="caret" size={12} />
          </button>
          {quotaWindows.length ? quotaWindows.map(({ label, window }) => {
            const remaining = Math.max(0, Math.min(100, Number((100 - window.usedPercent).toFixed(1))));
            const urgency = remaining < 10 ? "is-critical" : remaining < 30 ? "is-warning" : "";
            const reset = window.resetsAt
              ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
                  .format(new Date(window.resetsAt * 1_000))
              : null;
            return (
              <div className={`sidebar-usage__row ${urgency}`} key={label}>
                <strong>{label}</strong>
                <span>{remaining}%</span>
                {reset ? <small>{reset}</small> : null}
                <i><b style={{ width: `${remaining}%` }} /></i>
              </div>
            );
          }) : <small className="sidebar-usage__pending">Limits will appear when Codex connects</small>}
        </section>

        <nav className="sidebar__secondary-nav" aria-label="Utilities">
          <button
            className={`sidebar__settings ${activePage === "settings" ? "is-active" : ""}`}
            onClick={onOpenSettings}
          >
            <XiaoIcon name="settings" size={17} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar__footer">
          <button
            className={`sidebar__profile ${activePage === "profile" ? "is-active" : ""}`}
            onClick={onOpenProfile}
          >
            <span className="sidebar__profile-avatar">
              {profile.avatarDataUrl ? (
                <img src={profile.avatarDataUrl} alt="" />
              ) : initials ? (
                initials
              ) : (
                <XiaoIcon name="user" size={14} />
              )}
            </span>
            <span className="sidebar__profile-copy">
              <strong>{profile.name || "Set up profile"}</strong>
              <small>{account?.planType ?? "Xiao profile"}</small>
            </span>
          </button>
        </div>
      </aside>

      {projectMenu && menuProject
        ? createPortal(
            <div
              className="project-actions-menu"
              ref={projectMenuRef}
              role="menu"
              aria-label={`Actions for ${menuProject.name}`}
              style={{ top: projectMenu.top, left: projectMenu.left }}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                role="menuitem"
                disabled={menuProject.path !== activeProjectPath && projectSwitchLocked}
                title={
                  menuProject.path !== activeProjectPath && projectSwitchLocked
                    ? "Wait for the active task to finish"
                    : undefined
                }
                onClick={() => openTaskComposer(menuProject.path)}
              >
                <XiaoIcon name="add" size={15} />
                <span>New task</span>
              </button>
              <i className="context-menu-separator" />
              <button
                role="menuitem"
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onToggleProjectPinned(menuProject.path);
                }}
              >
                <XiaoIcon name="pin" size={15} />
                <span>{menuProject.pinned ? "Unpin project" : "Pin project"}</span>
              </button>
              <button
                role="menuitem"
                disabled={!canOpenProjects}
                title={canOpenProjects ? undefined : "Available in the desktop app"}
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onOpenProject(menuProject.path);
                }}
              >
                <XiaoIcon name="folderOpen" size={15} />
                <span>Open in Explorer</span>
              </button>
              <button role="menuitem" onClick={() => beginProjectRename(menuProject)}>
                <XiaoIcon name="edit" size={15} />
                <span>Rename project</span>
              </button>
              <button
                role="menuitem"
                disabled={menuProject.path === activeProjectPath && workingTasks.size > 0}
                title={
                  menuProject.path === activeProjectPath && workingTasks.size > 0
                    ? "Wait for the active task to finish"
                    : undefined
                }
                onClick={() => {
                  closeProjectMenu(projectMenu.focusFirst);
                  onArchiveProjectTasks(menuProject.path);
                }}
              >
                <XiaoIcon name="archive" size={15} />
                <span>Archive tasks</span>
              </button>
              <button
                className="is-danger"
                role="menuitem"
                disabled={
                  projects.length === 1 ||
                  (menuProject.path === activeProjectPath && projectSwitchLocked)
                }
                title={
                  projects.length === 1
                    ? "Keep at least one project in Xiao"
                    : menuProject.path === activeProjectPath && projectSwitchLocked
                      ? "Wait for the active task to finish"
                      : undefined
                }
                onClick={() => {
                  closeProjectMenu();
                  onRemoveProject(menuProject.path);
                }}
              >
                <XiaoIcon name="close" size={15} />
                <span>Remove</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {taskMenu && menuTask
        ? createPortal(
            <div
              className="project-actions-menu task-actions-menu"
              ref={taskMenuRef}
              role="menu"
              aria-label={`Actions for ${menuTask.title}`}
              style={{ top: taskMenu.top, left: taskMenu.left }}
              onKeyDown={handleMenuKeyDown}
            >
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onToggleTaskPinned(menuTask.id);
              }}>
                <XiaoIcon name="pin" size={15} />
                <span>{menuTask.pinned ? "Unpin task" : "Pin task"}</span>
              </button>
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                setRenamingTask({ id: menuTask.id, title: menuTask.title });
              }}>
                <XiaoIcon name="edit" size={15} />
                <span>Rename task</span>
              </button>
              <button
                role="menuitem"
                disabled={workingTasks.has(menuTask.id)}
                title={workingTasks.has(menuTask.id) ? "Wait for this task to finish" : undefined}
                onClick={() => {
                  closeTaskMenu();
                  onSetTaskArchived(menuTask.id, true);
                }}
              >
                <XiaoIcon name="archive" size={15} />
                <span>Archive task</span>
              </button>
              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onMarkTaskUnread(menuTask.id, !menuTask.unread);
              }}>
                <XiaoIcon name="result" size={15} />
                <span>{menuTask.unread ? "Mark as read" : "Mark as unread"}</span>
              </button>

              <i className="context-menu-separator" />

              <button
                role="menuitem"
                disabled={!canOpenProjects}
                onClick={() => {
                  closeTaskMenu();
                  onOpenProject(workspace.path);
                }}
              >
                <XiaoIcon name="folderOpen" size={15} />
                <span>Open in Explorer</span>
              </button>
              <button role="menuitem" onClick={() => copyText(workspace.path)}>
                <XiaoIcon name="copy" size={15} />
                <span>Copy working directory</span>
              </button>
              <button
                role="menuitem"
                disabled={!menuTask.threadId}
                title={menuTask.threadId ? undefined : "This task has no active Codex session"}
                onClick={() => menuTask.threadId && copyText(menuTask.threadId)}
              >
                <XiaoIcon name="copy" size={15} />
                <span>Copy session ID</span>
              </button>

              <i className="context-menu-separator" />

              <button role="menuitem" onClick={() => {
                closeTaskMenu();
                onContinueInNewTask(menuTask.id);
              }}>
                <XiaoIcon name="taskQueue" size={15} />
                <span>Continue in new task</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {usageDetailsOpen ? (
        <UsageDetailsDialog
          rateLimits={rateLimits}
          threads={codexThreads}
          usage={threadTokenUsage}
          onClose={() => setUsageDetailsOpen(false)}
        />
      ) : null}
    </>
  );
}
