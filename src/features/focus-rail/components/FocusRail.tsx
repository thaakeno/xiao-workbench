import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  type AgentAttachment,
  type AgentModelSummary,
  type AgentPlan,
  type AgentRuntimeState,
  type RuntimeLogEntry,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";
import type { RoutineSummary } from "../../../core/models/routine";
import type { FileNode, SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";
import type { WorkbenchTask } from "../../task/task.types";
import type { FocusView } from "../focus-rail.types";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { OpenFilePanel } from "./OpenFilePanel";
import { PlanPanel } from "./PlanPanel";
import { RuntimePanel } from "./RuntimePanel";
import { SchedulePanel, type RoutineDraft } from "./SchedulePanel";
import "../styles/focus-rail.css";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
);
const XiaoRunPanel = lazy(() =>
  import("./XiaoRunPanel").then((module) => ({ default: module.XiaoRunPanel })),
);

type FocusRailProps = {
  activeView: FocusView;
  onViewChange: (view: FocusView) => void;
  onClose: () => void;
  workspace: WorkspaceSnapshot;
  system: SystemInfo;
  runtime: AgentRuntimeState;
  task: WorkbenchTask;
  executionTaskId: string | null;
  executionTransitioning: boolean;
  timeline: TimelineEntry[];
  models: AgentModelSummary[];
  contextUsage: ThreadTokenUsage | null;
  plan: AgentPlan | null;
  runtimeLogs: RuntimeLogEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onLoadDirectory: (path: string) => Promise<FileNode[]>;
  routines: RoutineSummary[];
  routinesLoading: boolean;
  routinesError: string | null;
  routineCreating: boolean;
  routineBusyIds: ReadonlySet<string>;
  routineOpenRunId: string | null;
  nativeRoutinesAvailable: boolean;
  dangerousRoutineAccessDefault: boolean;
  dangerousRoutineIds: ReadonlySet<string>;
  onCreateRoutine: (draft: RoutineDraft) => Promise<void>;
  onUpdateRoutine: (routineId: string, draft: RoutineDraft) => Promise<void>;
  onSetRoutineEnabled: (routineId: string, enabled: boolean) => Promise<void>;
  onRunRoutineNow: (routineId: string) => Promise<void>;
  onDeleteRoutine: (routineId: string) => Promise<void>;
  onClearRoutineError: () => void;
  reviewContext: AgentAttachment[];
  onStageReviewContext: (attachment: AgentAttachment) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  obscured: boolean;
};

const utilityViews: Array<{ id: FocusView; label: string; description: string; icon: XiaoIconName }> = [
  { id: "files", label: "Open file", description: "Read and comment on source", icon: "files" },
  { id: "plan", label: "Plan", description: "Follow live task steps", icon: "plan" },
  { id: "terminal", label: "Terminal", description: "Run workspace commands", icon: "terminal" },
  { id: "browser", label: "Browser", description: "Research without leaving Xiao", icon: "browser" },
  { id: "run", label: "Xiao Break", description: "Play while Xiao works", icon: "game" },
  { id: "runtime", label: "Runtime", description: "Inspect Codex events", icon: "runtime" },
  { id: "schedule", label: "Schedule", description: "Queue work for later", icon: "routine" },
  { id: "extensions", label: "Tools", description: "Skills, plugins, MCP, and apps", icon: "capability" },
];

const baseViews = new Set<FocusView>(["changes", "context"]);
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function FocusRail({
  activeView,
  onViewChange,
  onClose,
  workspace,
  system,
  runtime,
  task,
  executionTaskId,
  executionTransitioning,
  timeline,
  models,
  contextUsage,
  plan,
  runtimeLogs,
  loading,
  error,
  onRefresh,
  onLoadDirectory,
  routines,
  routinesLoading,
  routinesError,
  routineCreating,
  routineBusyIds,
  routineOpenRunId,
  nativeRoutinesAvailable,
  dangerousRoutineAccessDefault,
  dangerousRoutineIds,
  onCreateRoutine,
  onUpdateRoutine,
  onSetRoutineEnabled,
  onRunRoutineNow,
  onDeleteRoutine,
  onClearRoutineError,
  reviewContext,
  onStageReviewContext,
  onRemoveReviewContext,
  obscured,
}: FocusRailProps) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [terminalOpened, setTerminalOpened] = useState(activeView === "terminal");
  const [browserOpened, setBrowserOpened] = useState(activeView === "browser");
  const [runOpened, setRunOpened] = useState(activeView === "run");
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const activeModel =
    (task.model ? models.find((model) => model.model === task.model) : models.find((model) => model.isDefault)) ??
    models.find((model) => model.isDefault);
  const usagePercent = contextUsedPercent(contextUsage, activeModel?.contextWindow) ?? 0;
  const utility = utilityViews.find((view) => view.id === activeView);
  const utilityLabel = activeView === "files" && activeFile ? basename(activeFile) : utility?.label;

  useEffect(() => setActiveFile(null), [workspace.path]);
  useEffect(() => {
    if (activeView === "terminal") setTerminalOpened(true);
    if (activeView === "browser") setBrowserOpened(true);
    if (activeView === "run") setRunOpened(true);
  }, [activeView]);

  const selectUtility = (view: FocusView) => {
    if (view === "files") setActiveFile(null);
    onViewChange(view);
    setToolsMenuOpen(false);
    menu.current?.removeAttribute("open");
  };

  return (
    <aside className="focus-rail" id="review-panel">
      <header className="review-tabs-bar">
        <button className="review-tabs-bar__rail" type="button" aria-label={activeView === "run" ? "Xiao Break" : "Review workspace"}>
          <XiaoIcon name={activeView === "run" ? "game" : "sidebar"} size={15} />
        </button>
        <nav className="review-tabs" aria-label="Review tabs">
          {activeView === "run" ? (
            <strong className="review-tabs__run-title">Xiao Break</strong>
          ) : (
            <>
              <button
                className={activeView === "changes" ? "is-active" : undefined}
                type="button"
                onClick={() => onViewChange("changes")}
              >
                <span>Changes</span>
                <small>{workspace.git?.changes.length ?? 0}</small>
              </button>
              <button
                className={activeView === "context" ? "is-active" : undefined}
                type="button"
                onClick={() => onViewChange("context")}
              >
                <i className="review-tabs__context-dot" style={{ "--usage": `${usagePercent}%` } as React.CSSProperties} />
                <span>Context</span>
              </button>
              {!baseViews.has(activeView) && utilityLabel ? (
                <div className="review-tabs__utility is-active">
                  <button type="button" onClick={() => onViewChange(activeView)} title={activeView === "files" ? activeFile ?? "Open file" : utilityLabel}>
                    {activeView === "files" && activeFile ? (
                      <FileTypeIcon path={activeFile} size={14} />
                    ) : (
                      <XiaoIcon name={utility?.icon ?? "file"} size={13} />
                    )}
                    <span>{utilityLabel}</span>
                  </button>
                  <button type="button" aria-label={`Close ${utilityLabel}`} onClick={() => onViewChange("changes")}>
                    <XiaoIcon name="close" size={11} />
                  </button>
                </div>
              ) : null}
              <button
                className="review-tabs__add"
                type="button"
                aria-label="Open file"
                title="Open file"
                onClick={() => selectUtility("files")}
              >
                <XiaoIcon name="add" size={15} />
              </button>
            </>
          )}
        </nav>
        <div className="review-tabs-bar__actions">
          <details className="review-lens-menu" ref={menu} onToggle={(event) => setToolsMenuOpen(event.currentTarget.open)}>
            <summary aria-label="Open workspace tools" title="Workspace tools">
              <XiaoIcon name="folderOpen" size={15} />
              <XiaoIcon name="caret" size={10} />
            </summary>
            <div role="menu" aria-label="Workspace tools">
              <header><span>Workspace tools</span><small>{workspace.name}</small></header>
              {utilityViews.map((view) => (
                <button className={activeView === view.id ? "is-active" : undefined} key={view.id} role="menuitem" title={view.description} onClick={() => selectUtility(view.id)}>
                  <span><XiaoIcon name={view.icon} size={15} /></span>
                  <div><strong>{view.label}</strong><small>{view.description}</small></div>
                  {activeView === view.id ? <XiaoIcon name="check" size={13} /> : null}
                </button>
              ))}
            </div>
          </details>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close review panel">
            <XiaoIcon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className={`focus-panel focus-panel--${activeView}`}>
        {activeView === "changes" && (
          <ChangesPanel
            workspace={workspace}
            taskId={executionTaskId}
            transitioning={executionTransitioning}
            onRefresh={onRefresh}
          />
        )}
        {activeView === "context" && (
          <ContextPanel
            key={task.id}
            taskTitle={task.title}
            taskCreatedAt={task.createdAt}
            timeline={timeline}
            threadId={task.threadId}
            models={models}
            selectedModel={task.model}
            usage={contextUsage}
          />
        )}
        {activeView === "files" && (
          <OpenFilePanel
            workspace={workspace}
            taskId={executionTaskId}
            loading={loading}
            activeFile={activeFile}
            onActiveFileChange={setActiveFile}
            onLoadDirectory={onLoadDirectory}
            reviewContext={reviewContext}
            onStageReviewContext={onStageReviewContext}
            onRemoveReviewContext={onRemoveReviewContext}
          />
        )}
        {activeView === "plan" && <PlanPanel runtime={runtime} plan={plan} />}
        {activeView === "extensions" && (
          <ExtensionsPanel workspace={workspace} taskId={executionTaskId} runtime={runtime} />
        )}
        {(terminalOpened || activeView === "terminal") && (
          <div className="focus-terminal-slot" hidden={activeView !== "terminal"}>
            <Suspense fallback={<div className="terminal-loading"><XiaoIcon name="pending" size={15} /> Starting terminal</div>}>
              <TerminalPanel
                active={activeView === "terminal"}
                workspace={workspace}
                taskId={executionTaskId}
                system={system}
                transitioning={executionTransitioning}
              />
            </Suspense>
          </div>
        )}
        {(browserOpened || activeView === "browser") && (
          <div className="focus-browser-slot" hidden={activeView !== "browser"}>
            <Suspense fallback={<div className="browser-loading"><XiaoIcon name="pending" size={15} /> Starting browser</div>}>
              <BrowserPanel active={activeView === "browser" && !toolsMenuOpen && !obscured} />
            </Suspense>
          </div>
        )}
        {(runOpened || activeView === "run") && (
          <div className="focus-run-slot" hidden={activeView !== "run"}>
            <Suspense fallback={<div className="run-loading"><XiaoIcon name="pending" size={15} /> Opening game</div>}>
              <XiaoRunPanel
                runtime={runtime}
                plan={plan}
                interactive={activeView === "run" && !toolsMenuOpen && !obscured}
              />
            </Suspense>
          </div>
        )}
        {activeView === "schedule" && (
          <SchedulePanel
            routines={routines}
            loading={routinesLoading}
            error={routinesError}
            creating={routineCreating}
            busyIds={routineBusyIds}
            nativeAvailable={nativeRoutinesAvailable}
            dangerousAccessDefault={dangerousRoutineAccessDefault}
            dangerousRoutineIds={dangerousRoutineIds}
            openRunId={routineOpenRunId}
            onCreate={onCreateRoutine}
            onUpdate={onUpdateRoutine}
            onSetEnabled={onSetRoutineEnabled}
            onRunNow={onRunRoutineNow}
            onDelete={onDeleteRoutine}
            onClearError={onClearRoutineError}
          />
        )}
        {activeView === "runtime" && (
          <RuntimePanel runtime={runtime} logs={runtimeLogs} system={system} error={error} onRefresh={onRefresh} />
        )}
      </div>
    </aside>
  );
}
