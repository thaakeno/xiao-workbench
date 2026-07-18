import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, RuntimePhase, TimelineEntry } from "../../../core/models/agent";
import type { RunSnapshot, RunStatus } from "../../../core/models/run";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { ChatExportMenu } from "./ChatExportMenu";

type TaskHeaderProps = {
  taskId: string;
  taskTitle: string;
  taskArchived: boolean;
  workspace: WorkspaceSnapshot;
  runtime: AgentRuntimeState;
  latestRun: RunSnapshot | null;
  contextPercent: number | null;
  archiveDisabled: boolean;
  canUndo: boolean;
  undoing: boolean;
  timeline: TimelineEntry[];
  showChatExport: boolean;
  onFocusView: (view: FocusView) => void;
  onRetryRun: (runId: string) => void;
  onToggleArchived: () => void;
  onUndo: () => void;
};

const runtimeLabels: Record<RuntimePhase, string> = {
  offline: "Offline",
  starting: "Connecting",
  ready: "Ready",
  working: "Working",
  error: "Needs attention",
};

const runLabels: Partial<Record<RunStatus, string>> = {
  queued: "Queued",
  preparing: "Preparing",
  running: "Working",
  waiting_for_input: "Waiting for input",
  verifying: "Verifying",
  completed: "Done",
  needs_attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function TaskHeader({
  taskId,
  taskTitle,
  taskArchived,
  workspace,
  runtime,
  latestRun,
  contextPercent,
  archiveDisabled,
  canUndo,
  undoing,
  timeline,
  showChatExport,
  onFocusView,
  onRetryRun,
  onToggleArchived,
  onUndo,
}: TaskHeaderProps) {
  const branch = workspace.git?.branch ?? "No Git branch";
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const runtimeLabel = latestRun?.status && runLabels[latestRun.status]
    ? runLabels[latestRun.status]
    : runtime.phase === "working" && !taskWorking
      ? "Busy in another task"
      : runtimeLabels[runtime.phase];
  const canRetry = latestRun?.status === "failed" || latestRun?.status === "interrupted";

  return (
    <header className="task-header">
      <div className="task-header__copy">
        <h1>{taskTitle}</h1>
        <div className="task-header__context-row">
          <button className="task-header__branch" onClick={() => onFocusView("changes")}>
            <XiaoIcon name="branch" size={13} />
            <span>{branch}</span>
          </button>
          <span
            className="task-header__environment"
            title={workspace.execution.executionRoot}
          >
            <XiaoIcon name="workspace" size={12} />
            {workspace.execution.workspaceMode === "managed-worktree" ? "Isolated" : "Local"}
          </span>
        </div>
      </div>

      <div className="task-header__actions">
        {showChatExport ? <ChatExportMenu title={taskTitle} timeline={timeline} /> : null}
        <span
          className={`task-header__runtime task-header__runtime--${runtime.phase}`}
          role="status"
          aria-live="polite"
          title={runtime.error ?? undefined}
        >
          <i />
          {runtimeLabel}
        </span>
        <button
          className="task-header__context"
          type="button"
          aria-label={contextPercent === null ? "View context usage" : `View context usage, ${contextPercent}% used`}
          title={contextPercent === null ? "Context usage" : `${contextPercent}% context used`}
          onClick={() => onFocusView("context")}
        >
          <i style={{ "--usage": `${contextPercent ?? 0}%` } as React.CSSProperties} />
          <span>{contextPercent === null ? "Context" : `${contextPercent}%`}</span>
        </button>
        {canRetry ? (
          <button
            className="button button--quiet"
            type="button"
            onClick={() => onRetryRun(latestRun.id)}
          >
            <XiaoIcon name="refresh" size={15} />
            <span>Retry</span>
          </button>
        ) : null}
        <button className="button button--quiet" onClick={() => onFocusView("changes")}>
          <XiaoIcon name="changes" size={16} />
          <span>Review</span>
        </button>
        {canUndo || undoing ? (
          <button
            className="button button--quiet task-header__undo"
            type="button"
            disabled={!canUndo || undoing}
            title="Remove the last turn and safely revert its workspace patch"
            onClick={onUndo}
          >
            <XiaoIcon className={undoing ? "is-spinning" : undefined} name={undoing ? "pending" : "undo"} size={15} />
            <span>{undoing ? "Undoing" : "Undo"}</span>
          </button>
        ) : null}
        <button
          aria-label={taskArchived ? "Restore task" : "Archive task"}
          className="icon-button task-header__archive"
          disabled={archiveDisabled || taskWorking}
          onClick={onToggleArchived}
          title={taskArchived ? "Restore task" : "Archive task"}
        >
          <XiaoIcon name={taskArchived ? "refresh" : "archive"} size={15} />
        </button>
      </div>
    </header>
  );
}
