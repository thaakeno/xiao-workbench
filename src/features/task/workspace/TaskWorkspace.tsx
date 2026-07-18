import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
import type { RunSnapshot } from "../../../core/models/run";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import type { XiaoWorkspaceMode } from "../../../core/models/xiao";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { Composer } from "../composer/Composer";
import { TaskTimeline } from "../timeline/TaskTimeline";
import { TaskHeader } from "./TaskHeader";
import { MessageNavigator } from "./MessageNavigator";
import "../styles/task.css";

type TaskWorkspaceProps = {
  taskId: string;
  executionTaskId: string | null;
  taskTitle: string;
  taskArchived: boolean;
  launchMode: boolean;
  taskStateError: string | null;
  taskStateLoading: boolean;
  timeline: TimelineEntry[];
  runtime: AgentRuntimeState;
  latestRun: RunSnapshot | null;
  models: AgentModelSummary[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  fastMode: boolean;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  workspaceMode: XiaoWorkspaceMode;
  environmentBusy: boolean;
  environmentError: string | null;
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
  showChatExport: boolean;
  historyHasMore: boolean;
  historyLoadingOlder: boolean;
  launchBrand: "logo" | "wordmark";
  workspace: WorkspaceSnapshot;
  onSubmit: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onQueueFollowUp: (prompt: string, attachments: AgentAttachment[]) => Promise<boolean>;
  onRemoveFollowUp: (followUpId: string) => void;
  onSendFollowUpNow: (followUpId: string) => Promise<void>;
  onRetryFollowUp: () => void;
  onRestoredAttachmentsConsumed: () => void;
  onCompact: () => Promise<boolean>;
  onUndo: () => void;
  onForkTask: (entryId: string) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  onReviewContextSent: () => void;
  onDraftChange: (draftText: string) => void;
  onLoadOlderHistory: () => Promise<void>;
  onResolveQuestion: (
    requestId: number | string,
    answers: Record<string, string[]>,
  ) => Promise<boolean>;
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onFastModeChange: (fastMode: boolean) => void;
  onModeChange: (mode: AgentMode) => void;
  onApprovalPolicyChange: (policy: AgentApprovalPolicy) => void;
  onSandboxModeChange: (mode: AgentSandboxMode) => void;
  onWorkspaceModeChange: (mode: XiaoWorkspaceMode) => Promise<void>;
  onGoalSet: (objective: string, status?: AgentGoal["status"]) => Promise<boolean>;
  onGoalClear: () => Promise<boolean>;
  onInterrupt: () => Promise<void>;
  onRetryRun: (runId: string) => void;
  onResolveApproval: (
    taskId: string,
    entryId: string,
    requestId: number | string,
    decision: "accept" | "decline",
  ) => Promise<void>;
  onFocusView: (view: FocusView) => void;
  onToggleArchived: () => void;
};

export function TaskWorkspace({
  taskId,
  executionTaskId,
  taskTitle,
  taskArchived,
  launchMode,
  taskStateError,
  taskStateLoading,
  timeline,
  runtime,
  latestRun,
  models,
  selectedModel,
  selectedReasoningEffort,
  fastMode,
  mode,
  approvalPolicy,
  sandboxMode,
  workspaceMode,
  environmentBusy,
  environmentError,
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
  showChatExport,
  historyHasMore,
  historyLoadingOlder,
  launchBrand,
  workspace,
  onSubmit,
  onQueueFollowUp,
  onRemoveFollowUp,
  onSendFollowUpNow,
  onRetryFollowUp,
  onRestoredAttachmentsConsumed,
  onCompact,
  onUndo,
  onForkTask,
  onRemoveReviewContext,
  onReviewContextSent,
  onDraftChange,
  onLoadOlderHistory,
  onResolveQuestion,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  onModeChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onWorkspaceModeChange,
  onGoalSet,
  onGoalClear,
  onInterrupt,
  onRetryRun,
  onResolveApproval,
  onFocusView,
  onToggleArchived,
}: TaskWorkspaceProps) {
  const scrollArea = useRef<HTMLDivElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const followLiveOutput = useRef(true);
  const previousWorking = useRef(false);
  const previousTimelineLength = useRef(timeline.length);
  const scrollPositions = useRef(new Map<string, number>());
  const loadingOlder = useRef(false);
  const taskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const canFork =
    runtime.phase === "ready" &&
    !taskArchived &&
    !taskStateError &&
    !taskStateLoading &&
    !environmentBusy &&
    !compacting &&
    !undoing &&
    followUps.length === 0;
  const activeModel =
    (selectedModel ? models.find((model) => model.model === selectedModel) : models.find((model) => model.isDefault)) ??
    models.find((model) => model.isDefault);
  const contextPercent = contextUsedPercent(contextUsage, activeModel?.contextWindow);

  useLayoutEffect(() => {
    const node = scrollArea.current;
    if (!node) return;
    const savedPosition = scrollPositions.current.get(taskId);
    node.scrollTop = savedPosition ?? node.scrollHeight;
    followLiveOutput.current = savedPosition === undefined;
    previousTimelineLength.current = timeline.length;
    return () => {
      scrollPositions.current.set(taskId, node.scrollTop);
    };
  }, [taskId]);

  useEffect(() => {
    const node = scrollArea.current;
    if (!node) return;
    if (taskWorking && !previousWorking.current) {
      followLiveOutput.current = true;
    }
    previousWorking.current = taskWorking;
    const appended = timeline.length >= previousTimelineLength.current;
    previousTimelineLength.current = timeline.length;
    if (!followLiveOutput.current || !appended) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollArea.current === node) {
        node.scrollTop = node.scrollHeight;
        setShowScrollBottom(false);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [taskId, taskWorking, timeline.length]);

  const loadOlderHistory = async () => {
    const node = scrollArea.current;
    if (!node || loadingOlder.current) return;
    loadingOlder.current = true;
    const previousHeight = node.scrollHeight;
    const previousTop = node.scrollTop;
    try {
      await onLoadOlderHistory();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (scrollArea.current !== node) return;
        node.scrollTop = previousTop + Math.max(0, node.scrollHeight - previousHeight);
      }));
    } finally {
      loadingOlder.current = false;
    }
  };

  const scrollToEntry = (entryId: string) => {
    document.getElementById(`timeline-entry-${entryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const scrollToBottom = () => {
    const node = scrollArea.current;
    if (!node) return;
    followLiveOutput.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  const composer = (
    <Composer
      key={taskId}
      taskId={taskId}
      executionTaskId={executionTaskId}
      workspacePath={workspace.path}
      runtime={runtime}
      models={models}
      selectedModel={selectedModel}
      selectedReasoningEffort={selectedReasoningEffort}
      fastMode={fastMode}
      mode={mode}
      approvalPolicy={approvalPolicy}
      sandboxMode={sandboxMode}
      workspaceMode={workspaceMode}
      isolationAvailable={workspace.execution.isolationAvailable}
      isolationUnavailableReason={workspace.execution.isolationUnavailableReason}
      environmentBusy={environmentBusy}
      environmentError={environmentError}
      managedWorktree={workspace.execution.managedWorktree}
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
      onFastModeChange={onFastModeChange}
      onModeChange={onModeChange}
      onApprovalPolicyChange={onApprovalPolicyChange}
      onSandboxModeChange={onSandboxModeChange}
      onWorkspaceModeChange={onWorkspaceModeChange}
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
      disabled={
        taskArchived || taskStateLoading || environmentBusy || Boolean(taskStateError)
      }
      disabledPlaceholder={taskStateLoading ? "Loading task history…" : undefined}
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
              {launchBrand === "logo" ? (
                <img className="task-launch__logo" src="/xiao-mark.png" alt="" aria-hidden="true" />
              ) : (
                <span className="task-launch__wordmark" aria-hidden="true">
                  <i>X</i><i>I</i><i>A</i><i className="task-launch__orbit">O</i>
                </span>
              )}
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
        latestRun={latestRun}
        contextPercent={contextPercent}
        archiveDisabled={environmentBusy || taskStateLoading || Boolean(taskStateError)}
        canUndo={canUndo}
        undoing={undoing}
        timeline={timeline}
        showChatExport={showChatExport}
        onFocusView={onFocusView}
        onRetryRun={onRetryRun}
        onToggleArchived={onToggleArchived}
        onUndo={onUndo}
      />
      <div
        key={taskId}
        className="task-workspace__scroll"
        ref={scrollArea}
        onScroll={(event) => {
          const node = event.currentTarget;
          followLiveOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
          setShowScrollBottom(!followLiveOutput.current);
        }}
      >
      <TaskTimeline
          key={taskId}
          taskId={taskId}
          timeline={timeline}
          runtime={runtime}
          showReasoningSummaries={showReasoningSummaries}
          expandToolOutput={expandToolOutput}
          historyLoading={taskStateLoading}
          historyHasMore={historyHasMore}
          canFork={canFork}
          onForkTask={onForkTask}
          onResolveApproval={onResolveApproval}
          onReviewChanges={() => onFocusView("changes")}
          canUndo={canUndo}
          undoing={undoing}
          onUndo={onUndo}
          historyLoadingOlder={historyLoadingOlder}
          onLoadOlderHistory={loadOlderHistory}
        />
      </div>
      <MessageNavigator timeline={timeline} onJump={scrollToEntry} />
      {showScrollBottom ? <button className="task-scroll-bottom" type="button" aria-label="Scroll to latest message" title="Scroll to bottom" onClick={scrollToBottom}><XiaoIcon name="send" size={16} /></button> : null}
      {composer}
    </section>
  );
}
