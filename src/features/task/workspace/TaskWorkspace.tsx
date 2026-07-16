import { useLayoutEffect, useRef } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  type AgentApprovalPolicy,
  type AgentAttachment,
  type AgentFollowUp,
  type AgentGoal,
  type AgentMode,
  type AgentModelSummary,
  type AgentPlan,
  type AgentQuestionRequest,
  type AgentRuntimeState,
  type AgentSandboxMode,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { Composer } from "../composer/Composer";
import { TaskTimeline } from "../timeline/TaskTimeline";
import { TaskHeader } from "./TaskHeader";
import "../styles/task.css";

type TaskWorkspaceProps = {
  taskId: string;
  taskTitle: string;
  taskArchived: boolean;
  launchMode: boolean;
  taskStateError: string | null;
  timeline: TimelineEntry[];
  runtime: AgentRuntimeState;
  models: AgentModelSummary[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  goal: AgentGoal | null;
  plan: AgentPlan | null;
  reviewContext: AgentAttachment[];
  questionRequest: AgentQuestionRequest | null;
  draftText: string;
  followUps: AgentFollowUp[];
  sendingFollowUpId: string | null;
  failedFollowUpId: string | null;
  restoredAttachments: AgentAttachment[];
  canCompact: boolean;
  compacting: boolean;
  hasThread: boolean;
  canUndo: boolean;
  undoing: boolean;
  contextUsage: ThreadTokenUsage | null;
  showReasoningSummaries: boolean;
  expandToolOutput: boolean;
  historyHasMore: boolean;
  historyLoadingOlder: boolean;
  workspace: WorkspaceSnapshot;
  onSubmit: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onQueueFollowUp: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onRemoveFollowUp: (followUpId: string) => void;
  onSendFollowUpNow: (followUpId: string) => Promise<void>;
  onRetryFollowUp: () => void;
  onRestoredAttachmentsConsumed: () => void;
  onCompact: () => Promise<boolean>;
  onUndo: () => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  onReviewContextSent: () => void;
  onDraftChange: (draftText: string) => void;
  onResolveQuestion: (
    requestId: number | string,
    answers: Record<string, string[]>,
  ) => Promise<boolean>;
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onModeChange: (mode: AgentMode) => void;
  onApprovalPolicyChange: (policy: AgentApprovalPolicy) => void;
  onSandboxModeChange: (mode: AgentSandboxMode) => void;
  onGoalSet: (objective: string, status?: AgentGoal["status"]) => Promise<boolean>;
  onGoalClear: () => Promise<boolean>;
  onInterrupt: () => Promise<void>;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  onFocusView: (view: FocusView) => void;
  onToggleArchived: () => void;
  onLoadOlderHistory: () => void;
};

export function TaskWorkspace({
  taskId,
  taskTitle,
  taskArchived,
  launchMode,
  taskStateError,
  timeline,
  runtime,
  models,
  selectedModel,
  selectedReasoningEffort,
  mode,
  approvalPolicy,
  sandboxMode,
  goal,
  plan,
  reviewContext,
  questionRequest,
  draftText,
  followUps,
  sendingFollowUpId,
  failedFollowUpId,
  restoredAttachments,
  canCompact,
  compacting,
  hasThread,
  canUndo,
  undoing,
  contextUsage,
  showReasoningSummaries,
  expandToolOutput,
  historyHasMore,
  historyLoadingOlder,
  workspace,
  onSubmit,
  onQueueFollowUp,
  onRemoveFollowUp,
  onSendFollowUpNow,
  onRetryFollowUp,
  onRestoredAttachmentsConsumed,
  onCompact,
  onUndo,
  onRemoveReviewContext,
  onReviewContextSent,
  onDraftChange,
  onResolveQuestion,
  onModelChange,
  onReasoningEffortChange,
  onModeChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onGoalSet,
  onGoalClear,
  onInterrupt,
  onResolveApproval,
  onFocusView,
  onToggleArchived,
  onLoadOlderHistory,
}: TaskWorkspaceProps) {
  const scrollArea = useRef<HTMLDivElement>(null);
  const followLiveOutput = useRef(true);
  const previousWorking = useRef(false);
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const activeModel =
    (selectedModel ? models.find((model) => model.model === selectedModel) : models.find((model) => model.isDefault)) ??
    models.find((model) => model.isDefault);
  const contextPercent = contextUsedPercent(contextUsage, activeModel?.contextWindow);

  useLayoutEffect(() => {
    const node = scrollArea.current;
    if (!node) return;
    if (taskWorking && !previousWorking.current) {
      followLiveOutput.current = true;
    }
    previousWorking.current = taskWorking;
    if (followLiveOutput.current) node.scrollTop = node.scrollHeight;
  }, [taskId, taskWorking, timeline]);

  const composer = (
    <Composer
      key={taskId}
      taskId={taskId}
      workspacePath={workspace.path}
      runtime={runtime}
      models={models}
      selectedModel={selectedModel}
      selectedReasoningEffort={selectedReasoningEffort}
      mode={mode}
      approvalPolicy={approvalPolicy}
      sandboxMode={sandboxMode}
      goal={goal}
      plan={plan}
      changeSummary={{
        files: workspace.git?.changes.length ?? 0,
        additions: workspace.git?.changes.reduce((sum, change) => sum + change.additions, 0) ?? 0,
        deletions: workspace.git?.changes.reduce((sum, change) => sum + change.deletions, 0) ?? 0,
      }}
      reviewContext={reviewContext}
      questionRequest={questionRequest}
      draftText={draftText}
      followUps={followUps}
      sendingFollowUpId={sendingFollowUpId}
      failedFollowUpId={failedFollowUpId}
      restoredAttachments={restoredAttachments}
      canCompact={canCompact}
      compacting={compacting}
      hasThread={hasThread}
      canUndo={canUndo}
      undoing={undoing}
      autoFocus={launchMode}
      onModelChange={onModelChange}
      onReasoningEffortChange={onReasoningEffortChange}
      onModeChange={onModeChange}
      onApprovalPolicyChange={onApprovalPolicyChange}
      onSandboxModeChange={onSandboxModeChange}
      onGoalSet={onGoalSet}
      onGoalClear={onGoalClear}
      onInterrupt={onInterrupt}
      onOpenView={onFocusView}
      onSubmit={onSubmit}
      onQueueFollowUp={onQueueFollowUp}
      onRemoveFollowUp={onRemoveFollowUp}
      onSendFollowUpNow={onSendFollowUpNow}
      onRetryFollowUp={onRetryFollowUp}
      onRestoredAttachmentsConsumed={onRestoredAttachmentsConsumed}
      onCompact={onCompact}
      onUndo={onUndo}
      onRemoveReviewContext={onRemoveReviewContext}
      onReviewContextSent={onReviewContextSent}
      onDraftChange={onDraftChange}
      onResolveQuestion={onResolveQuestion}
      disabled={taskArchived || Boolean(taskStateError)}
      storageError={taskStateError}
    />
  );

  if (launchMode) {
    const branch = workspace.git?.branch ?? "No Git branch";
    return (
      <section className="task-workspace task-workspace--launch">
        <div className="task-launch">
          <div className="task-launch__inner">
            <div className="task-launch__brand" aria-label="XIAO">
              <span className="task-launch__wordmark" aria-hidden="true">
                <i>X</i><i>I</i><i>A</i><i className="task-launch__orbit">O</i>
              </span>
              <small>Local agent workspace</small>
            </div>
            {composer}
            <div className="task-launch__context" aria-label="Task context">
              <span title={workspace.path}>
                <XiaoIcon name="workspace" size={14} />
                <strong>{workspace.name}</strong>
              </span>
              <i aria-hidden="true">/</i>
              <button type="button" onClick={() => onFocusView("changes")}>
                <XiaoIcon name="branch" size={13} />
                <span>{branch}</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="task-workspace">
      <TaskHeader
        taskId={taskId}
        taskTitle={taskTitle}
        taskArchived={taskArchived}
        workspace={workspace}
        runtime={runtime}
        contextPercent={contextPercent}
        archiveDisabled={Boolean(taskStateError)}
        canUndo={canUndo}
        undoing={undoing}
        onFocusView={onFocusView}
        onToggleArchived={onToggleArchived}
        onUndo={onUndo}
      />
      <div
        className="task-workspace__scroll"
        ref={scrollArea}
        onScroll={(event) => {
          const node = event.currentTarget;
          followLiveOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        }}
      >
      <TaskTimeline
          taskId={taskId}
          timeline={timeline}
          runtime={runtime}
          showReasoningSummaries={showReasoningSummaries}
          expandToolOutput={expandToolOutput}
          onResolveApproval={onResolveApproval}
        onReviewChanges={() => onFocusView("changes")}
        canUndo={canUndo}
        undoing={undoing}
        onUndo={onUndo}
        historyHasMore={historyHasMore}
        historyLoadingOlder={historyLoadingOlder}
        onLoadOlderHistory={onLoadOlderHistory}
      />
      </div>
      {composer}
    </section>
  );
}
