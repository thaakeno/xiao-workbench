import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, RuntimePhase, TimelineEntry } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { ChatExportMenu } from "./ChatExportMenu";

type TaskHeaderProps = {
  taskId: string;
  taskTitle: string;
  taskArchived: boolean;
  workspace: WorkspaceSnapshot;
  runtime: AgentRuntimeState;
  contextPercent: number | null;
  archiveDisabled: boolean;
  canUndo: boolean;
  undoing: boolean;
  timeline: TimelineEntry[];
  showChatExport: boolean;
  onFocusView: (view: FocusView) => void;
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

export function TaskHeader({
  taskId,
  taskTitle,
  taskArchived,
  workspace,
  runtime,
  contextPercent,
  archiveDisabled,
  canUndo,
  undoing,
  timeline,
  showChatExport,
  onFocusView,
  onToggleArchived,
  onUndo,
}: TaskHeaderProps) {
  const branch = workspace.git?.branch ?? "No Git branch";
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const runtimeLabel = runtime.phase === "working" && !taskWorking
    ? "Busy in another task"
    : runtimeLabels[runtime.phase];

  return (
    <header className="task-header">
      <div className="task-header__copy">
        <h1>{taskTitle}</h1>
        <button className="task-header__branch" onClick={() => onFocusView("changes")}>
          <XiaoIcon name="branch" size={13} />
          <span>{branch}</span>
        </button>
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
