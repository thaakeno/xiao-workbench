import type { XiaoProjectSummary } from "../../core/models/xiao";
import type { WorkbenchTask } from "../task/task.types";

export type StartupTaskState = {
  tasks: WorkbenchTask[];
  activeTaskId: string | null;
  showArchived: boolean;
};

type WorkspaceCache = Record<string, StartupTaskState>;

const projectsKey = "xiao.startup.projects.v1";
const workspacesKey = "xiao.startup.workspaces.v1";
const maxCachedProjects = 80;
const maxCachedTasks = 600;

const pathKey = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase();

const parse = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};

const store = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Startup caching is an optimization; native persistence remains authoritative.
  }
};

export const readStartupProjects = (): XiaoProjectSummary[] => {
  const value = parse<unknown>(projectsKey, []);
  return Array.isArray(value)
    ? value.filter((project): project is XiaoProjectSummary =>
        Boolean(project) && typeof project === "object" &&
        typeof (project as XiaoProjectSummary).path === "string" &&
        typeof (project as XiaoProjectSummary).name === "string" &&
        typeof (project as XiaoProjectSummary).updatedAt === "number",
      )
    : [];
};

export const writeStartupProjects = (projects: XiaoProjectSummary[]) => {
  store(projectsKey, projects.slice(0, maxCachedProjects));
};

export const readStartupTaskState = (workspacePath?: string): StartupTaskState | null => {
  if (!workspacePath) return null;
  const cache = parse<WorkspaceCache>(workspacesKey, {});
  const value = cache[pathKey(workspacePath)];
  if (!value || !Array.isArray(value.tasks)) return null;
  return value;
};

export const writeStartupTaskState = (workspacePath: string, state: StartupTaskState) => {
  const cache = parse<WorkspaceCache>(workspacesKey, {});
  const tasks = state.tasks.slice(0, maxCachedTasks).map((task) => ({
    ...task,
    timeline: [],
    timelineLoaded: false,
    timelineComplete: task.timelineEntryCount === 0,
    timelineStart: task.timelineEntryCount,
  }));
  cache[pathKey(workspacePath)] = { ...state, tasks };
  store(workspacesKey, cache);
};
