import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type {
  AgentApprovalPolicy,
  AgentAttachment,
  AgentFollowUp,
  AgentGoal,
  AgentMode,
  AgentModelSummary,
  AgentPlan,
  AgentQuestionRequest,
  AgentRuntimeState,
  AgentSandboxMode,
} from "../../../core/models/agent";
import type { ManagedWorktreeSummary } from "../../../core/models/workspace";
import type { XiaoWorkspaceMode } from "../../../core/models/xiao";
import type { FocusView } from "../../focus-rail/focus-rail.types";
import { ImageLightbox } from "../media/ImageLightbox";
import { fileMentionAtCursor, removeFileMention, type FileMention } from "./fileMention";
import { ModelPicker } from "./ModelPicker";
import {
  canNavigatePromptHistory,
  navigatePromptHistory,
  normalizePromptHistory,
  prependPromptHistory,
} from "./promptHistory";
import { QuestionDock } from "./QuestionDock";
import {
  filterSlashCommands,
  SLASH_COMMANDS,
  slashCommandDisabledReason,
  type SlashCommand,
} from "./slashCommands";

const promptHistoryStorageKey = "xiao.prompt-history.v1";

type ComposerProps = {
  taskId: string;
  executionTaskId: string | null;
  workspacePath: string;
  runtime: AgentRuntimeState;
  models: AgentModelSummary[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  fastMode: boolean;
  mode: AgentMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  workspaceMode: XiaoWorkspaceMode;
  isolationAvailable: boolean;
  isolationUnavailableReason: string | null;
  environmentBusy: boolean;
  environmentError: string | null;
  managedWorktree: ManagedWorktreeSummary | null;
  goal: AgentGoal | null;
  plan: AgentPlan | null;
  changeSummary: { files: number; additions: number; deletions: number };
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
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onFastModeChange: (fastMode: boolean) => void;
  onModeChange: (mode: AgentMode) => void;
  onApprovalPolicyChange: (policy: AgentApprovalPolicy) => void;
  onSandboxModeChange: (mode: AgentSandboxMode) => void;
  onWorkspaceModeChange: (mode: XiaoWorkspaceMode) => Promise<void>;
  onGoalSet: (objective: string, status?: AgentGoal["status"]) => Promise<boolean>;
  onGoalClear: () => Promise<boolean>;
  onOpenView: (view: FocusView) => void;
  onInterrupt: () => Promise<void>;
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
  disabled?: boolean;
  disabledPlaceholder?: string;
  storageError?: string | null;
  autoFocus?: boolean;
};

const compactBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
};

const attachmentFromPath = (path: string, kind?: AgentAttachment["kind"]): AgentAttachment => {
  const name = path.split(/[\\/]/).pop() || path;
  return {
    name,
    path,
    kind: kind ?? (/\.(?:jpe?g|png|webp)$/i.test(path) ? "image" : "file"),
  };
};

const dataUrlAttachment = (file: File) =>
  new Promise<AgentAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted image."));
    reader.onload = () =>
      resolve({
        name: file.name || "pasted-image.png",
        path: `clipboard:${crypto.randomUUID()}`,
        kind: "image",
        url: String(reader.result),
      });
    reader.readAsDataURL(file);
  });

export function Composer({
  taskId,
  executionTaskId,
  workspacePath,
  runtime,
  models,
  selectedModel,
  selectedReasoningEffort,
  fastMode,
  mode,
  approvalPolicy,
  sandboxMode,
  workspaceMode,
  isolationAvailable,
  isolationUnavailableReason,
  environmentBusy,
  environmentError,
  managedWorktree,
  goal,
  plan,
  changeSummary,
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
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  onModeChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onWorkspaceModeChange,
  onGoalSet,
  onGoalClear,
  onOpenView,
  onInterrupt,
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
  disabled = false,
  disabledPlaceholder = "Restore this task to continue",
  storageError = null,
  autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState(draftText);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [selectingAttachments, setSelectingAttachments] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [goalValue, setGoalValue] = useState(goal?.objective ?? "");
  const [dragging, setDragging] = useState(false);
  const [planCollapsed, setPlanCollapsed] = useState(true);
  const [fileMention, setFileMention] = useState<FileMention | null>(null);
  const [fileResults, setFileResults] = useState<FuzzyFileResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [activeFileResult, setActiveFileResult] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [activeSlashCommand, setActiveSlashCommand] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const draftChangeTimer = useRef<number | null>(null);
  const pendingDraft = useRef<{ value: string; commit: (draft: string) => void } | null>(null);
  const textareaResizeFrame = useRef<number | null>(null);
  const promptHistory = useRef<string[]>([]);
  const promptHistoryIndex = useRef(-1);
  const promptHistoryDraft = useRef<string | null>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const addMenuTrigger = useRef<HTMLButtonElement>(null);
  const fileSearchRequest = useRef(0);
  const slashMenu = useRef<HTMLDivElement>(null);
  const slashCommandOptions = useRef<Array<HTMLButtonElement | null>>([]);
  const currentTaskWorking = runtime.phase === "working" && runtime.taskId === taskId;
  const activeQuestionRequest = questionRequest?.taskId === taskId ? questionRequest : null;
  const canSteer = currentTaskWorking && Boolean(runtime.threadId && runtime.turnId);
  const canSubmit =
    !disabled &&
    !compacting &&
    !undoing &&
    !activeQuestionRequest &&
    (value.trim().length > 0 || attachments.length > 0 || reviewContext.length > 0) &&
    (runtime.phase === "ready" || currentTaskWorking);
  const defaultModel = models.find((model) => model.isDefault);
  const activeModel =
    (selectedModel ? models.find((model) => model.model === selectedModel) : defaultModel) ??
    defaultModel;
  const effectiveReasoningEffort =
    selectedReasoningEffort || activeModel?.defaultReasoningEffort || "";
  const planSteps = plan?.steps ?? [];
  const completedPlanSteps = planSteps.filter((step) => step.status === "completed").length;
  const planProgress = planSteps.length ? Math.round((completedPlanSteps / planSteps.length) * 100) : 0;
  const planComplete = completedPlanSteps === planSteps.length;
  const activePlanStep =
    planSteps.find((step) => step.status === "inProgress") ??
    planSteps.find((step) => step.status === "pending") ??
    planSteps.at(-1);
  const activePlanStepNumber = Math.max(1, planSteps.indexOf(activePlanStep ?? planSteps[0]) + 1);
  const normalizedSlashQuery = slashQuery?.trim().toLocaleLowerCase() ?? "";
  const filteredSlashCommands = filterSlashCommands(SLASH_COMMANDS, normalizedSlashQuery)
    .filter((command) => command.id !== "undo" || (canUndo && !undoing));
  const slashMenuOpen = slashQuery !== null;
  const disabledReasonForSlashCommand = (command: SlashCommand) =>
    slashCommandDisabledReason(command, { canCompact, compacting, hasThread });

  useEffect(() => setGoalValue(goal?.objective ?? ""), [goal?.objective]);

  useEffect(() => {
    setValue((current) => current === draftText ? current : draftText);
  }, [draftText]);

  useEffect(() => () => {
    if (draftChangeTimer.current !== null) window.clearTimeout(draftChangeTimer.current);
    if (textareaResizeFrame.current !== null) window.cancelAnimationFrame(textareaResizeFrame.current);
    if (pendingDraft.current !== null) {
      pendingDraft.current.commit(pendingDraft.current.value);
      pendingDraft.current = null;
    }
  }, [taskId]);

  useEffect(() => {
    if (!fileMention) {
      setFileResults([]);
      setFileSearchLoading(false);
      setFileSearchError(null);
      return;
    }
    if (!isTauriHost() || runtime.phase === "offline" || runtime.phase === "starting") {
      setFileResults([]);
      setFileSearchError("File search needs the connected Xiao desktop runtime.");
      return;
    }

    const requestId = ++fileSearchRequest.current;
    const timer = window.setTimeout(() => {
      setFileSearchLoading(true);
      setFileSearchError(null);
      void nativeBridge
        .agentRequest<FuzzyFileResponse>(
          "fuzzyFileSearch",
          {
            query: fileMention.query,
            roots: [workspacePath],
            cancellationToken: null,
          },
          { projectPath: workspacePath, taskId: executionTaskId },
        )
        .then((result) => {
          if (requestId !== fileSearchRequest.current) return;
          setFileResults(result.files.slice(0, 9));
          setActiveFileResult(0);
        })
        .catch((reason) => {
          if (requestId !== fileSearchRequest.current) return;
          setFileResults([]);
          setFileSearchError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (requestId === fileSearchRequest.current) setFileSearchLoading(false);
        });
    }, 100);

    return () => window.clearTimeout(timer);
  }, [executionTaskId, fileMention?.query, runtime.phase, workspacePath]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!addMenu.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAddMenuOpen(false);
      window.requestAnimationFrame(() => addMenuTrigger.current?.focus());
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [addMenuOpen]);

  useLayoutEffect(() => {
    const menu = slashMenu.current;
    if (!slashMenuOpen || !menu) return;
    const boundary = menu.closest(".task-workspace");
    const anchor = menu.parentElement;
    if (!(boundary instanceof HTMLElement) || !anchor) return;

    const fitMenuToWorkspace = () => {
      const availableHeight = menu.getBoundingClientRect().bottom - boundary.getBoundingClientRect().top - 12;
      menu.style.setProperty("--composer-slash-menu-max-height", `${Math.max(0, Math.floor(availableHeight))}px`);
    };

    fitMenuToWorkspace();
    const observer = new ResizeObserver(fitMenuToWorkspace);
    observer.observe(boundary);
    observer.observe(anchor);
    boundary.addEventListener("scroll", fitMenuToWorkspace, { passive: true });
    window.addEventListener("resize", fitMenuToWorkspace);
    return () => {
      observer.disconnect();
      boundary.removeEventListener("scroll", fitMenuToWorkspace);
      window.removeEventListener("resize", fitMenuToWorkspace);
    };
  }, [slashMenuOpen]);

  const appendAttachments = (items: AgentAttachment[]) => {
    setAttachments((current) => {
      const next = new Map(current.map((attachment) => [attachment.path, attachment]));
      items.forEach((attachment) => next.set(attachment.path, attachment));
      return [...next.values()];
    });
  };

  useEffect(() => {
    if (!restoredAttachments.length) return;
    appendAttachments(restoredAttachments);
    onRestoredAttachmentsConsumed();
  }, [restoredAttachments]);

  const flushDraftChange = () => {
    if (draftChangeTimer.current !== null) {
      window.clearTimeout(draftChangeTimer.current);
      draftChangeTimer.current = null;
    }
    if (pendingDraft.current === null) return;
    const draft = pendingDraft.current;
    pendingDraft.current = null;
    draft.commit(draft.value);
  };

  const updateValue = (next: string, immediate = false) => {
    setValue(next);
    pendingDraft.current = { value: next, commit: onDraftChange };
    if (immediate) {
      flushDraftChange();
      return;
    }
    if (draftChangeTimer.current !== null) window.clearTimeout(draftChangeTimer.current);
    draftChangeTimer.current = window.setTimeout(flushDraftChange, 240);
  };

  const resizeTextarea = () => {
    if (textareaResizeFrame.current !== null) return;
    textareaResizeFrame.current = window.requestAnimationFrame(() => {
      textareaResizeFrame.current = null;
      const node = textarea.current;
      if (!node) return;
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 150)}px`;
    });
  };

  const syncFileMention = (text: string, cursor: number | null) => {
    const mention = fileMentionAtCursor(text, cursor ?? text.length);
    setFileMention(mention);
    if (mention) setSlashQuery(null);
    if (!mention) fileSearchRequest.current += 1;
  };

  const syncSlashCommand = (text: string, cursor: number | null) => {
    const match = cursor === text.length ? text.match(/^\/([^\s/]*)$/) : null;
    setSlashQuery(match?.[1] ?? null);
    if (!match) return;
    setFileMention(null);
    fileSearchRequest.current += 1;
    setActiveSlashCommand(0);
  };

  const resetPromptHistoryNavigation = () => {
    promptHistoryIndex.current = -1;
    promptHistoryDraft.current = null;
  };

  const readPromptHistory = () => {
    try {
      return normalizePromptHistory(
        JSON.parse(window.localStorage.getItem(promptHistoryStorageKey) ?? "null") as unknown,
      );
    } catch {
      return [];
    }
  };

  const savePromptToHistory = (prompt: string) => {
    if (!prompt.trim()) return;
    const next = prependPromptHistory(readPromptHistory(), prompt);
    promptHistory.current = next;
    try {
      window.localStorage.setItem(promptHistoryStorageKey, JSON.stringify(next));
    } catch {
      // Prompt history is optional when local storage is unavailable.
    }
  };

  const moveThroughPromptHistory = (direction: "up" | "down") => {
    if (promptHistoryIndex.current === -1) promptHistory.current = readPromptHistory();
    const result = navigatePromptHistory({
      direction,
      entries: promptHistory.current,
      historyIndex: promptHistoryIndex.current,
      currentDraft: value,
      savedDraft: promptHistoryDraft.current,
    });
    if (!result.handled) return false;

    promptHistoryIndex.current = result.historyIndex;
    promptHistoryDraft.current = result.savedDraft;
    setValue(result.value);
    setFileMention(null);
    setSlashQuery(null);
    window.requestAnimationFrame(() => {
      if (!textarea.current) return;
      const cursor = result.cursor === "start" ? 0 : result.value.length;
      textarea.current.focus();
      textarea.current.setSelectionRange(cursor, cursor);
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 150)}px`;
    });
    return true;
  };

  const chooseFileResult = (result: FuzzyFileResult) => {
    if (!fileMention) return;
    const next = removeFileMention(value, fileMention);
    const separator = result.root.includes("\\") ? "\\" : "/";
    const path = /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(result.path)
      ? result.path
      : `${result.root.replace(/[\\/]$/, "")}${separator}${result.path}`;
    appendAttachments([{
      name: result.file_name,
      path,
      kind: result.match_type === "directory" ? "directory" : "file",
    }]);
    updateValue(next.text);
    setFileMention(null);
    setSlashQuery(null);
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const moveActiveSlashCommand = (direction: 1 | -1) => {
    if (!filteredSlashCommands.length) return;
    setActiveSlashCommand((current) => {
      const next = (current + direction + filteredSlashCommands.length) % filteredSlashCommands.length;
      window.requestAnimationFrame(() => slashCommandOptions.current[next]?.scrollIntoView({ block: "nearest" }));
      return next;
    });
  };

  const chooseSlashCommand = (command: SlashCommand) => {
    if (disabledReasonForSlashCommand(command)) return;
    setSlashQuery(null);
    if (command.prompt) {
      updateValue(command.prompt);
      window.requestAnimationFrame(() => {
        if (!textarea.current) return;
        textarea.current.focus();
        textarea.current.setSelectionRange(command.prompt!.length, command.prompt!.length);
        textarea.current.style.height = "auto";
        textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 150)}px`;
      });
      return;
    }

    updateValue("", true);
    if (textarea.current) textarea.current.style.height = "auto";
    switch (command.id) {
      case "plan":
        onModeChange(mode === "plan" ? "default" : "plan");
        window.requestAnimationFrame(() => textarea.current?.focus());
        break;
      case "goal":
        setGoalEditorOpen(true);
        break;
      case "compact":
        void onCompact();
        window.requestAnimationFrame(() => textarea.current?.focus());
        break;
      case "undo":
        onUndo();
        break;
      case "changes":
      case "files":
      case "browser":
      case "context":
      case "terminal":
      case "runtime":
        onOpenView(command.id);
        break;
      case "capabilities":
        onOpenView("extensions");
        break;
      default:
        break;
    }
  };

  const selectAttachments = async (directory: boolean) => {
    setSelectingAttachments(true);
    setAttachmentError(null);
    setAddMenuOpen(false);
    try {
      const selection = await open({
        title: directory ? "Attach a folder" : "Attach files",
        multiple: !directory,
        directory,
        recursive: directory,
      });
      const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];
      appendAttachments(
        paths.map((path) => attachmentFromPath(path, directory ? "directory" : undefined)),
      );
    } catch (reason) {
      setAttachmentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSelectingAttachments(false);
    }
  };

  const attachClipboardFiles = async (files: File[]) => {
    const items: AgentAttachment[] = [];
    for (const file of files) {
      const path = (file as File & { path?: string }).path;
      if (path) items.push(attachmentFromPath(path));
      else if (file.type.startsWith("image/")) items.push(await dataUrlAttachment(file));
    }
    appendAttachments(items);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter(
      (file) => Boolean((file as File & { path?: string }).path) || file.type.startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    void attachClipboardFiles(files).catch((reason) =>
      setAttachmentError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    void attachClipboardFiles(files).catch((reason) =>
      setAttachmentError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  const submit = async (delivery: "queue" | "send" = currentTaskWorking ? "queue" : "send") => {
    if (!canSubmit) return;
    const historyValue = value.trim();
    const submittedValue = historyValue || (reviewContext.length
      ? "Address these review comments."
      : "Review the attached context.");
    const submittedAttachments = [...attachments, ...reviewContext];

    resetPromptHistoryNavigation();
    updateValue("");
    setAttachments([]);
    setSlashQuery(null);
    if (textarea.current) textarea.current.style.height = "auto";

    const submitted = delivery === "queue"
      ? await onQueueFollowUp(submittedValue, submittedAttachments)
      : await onSubmit(submittedValue, submittedAttachments);
    if (submitted) {
      savePromptToHistory(historyValue);
      onReviewContextSent();
      return;
    }

    setValue((current) => {
      const restored = current ? `${submittedValue}\n\n${current}` : submittedValue;
      onDraftChange(restored);
      return restored;
    });
    setAttachments((current) => {
      const restored = new Map(
        [...attachments, ...current].map((attachment) => [attachment.path, attachment]),
      );
      return [...restored.values()];
    });
    window.requestAnimationFrame(() => {
      if (!textarea.current) return;
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 150)}px`;
    });
  };

  const saveGoal = async () => {
    if (await onGoalSet(goalValue, goal?.status ?? "active")) setGoalEditorOpen(false);
  };

  const visibleError = attachmentError ?? storageError ?? runtime.error;
  const showOfflineNotice = runtime.phase === "offline" && !visibleError;
  const offlineMessage = isTauriHost()
    ? "Xiao is offline. Check the Codex connection before sending this task."
    : "Task execution needs the native Xiao app; this browser view is for previewing the interface.";
  let composerPlaceholder = "Ask Xiao anything. Use / for commands and @ for files";
  if (storageError) composerPlaceholder = "Task storage is unavailable";
  else if (compacting) composerPlaceholder = "Compacting session context…";
  else if (undoing) composerPlaceholder = "Undoing the last turn…";
  else if (disabled) composerPlaceholder = disabledPlaceholder;
  else if (runtime.phase === "starting") composerPlaceholder = "Connecting to Codex…";
  else if (runtime.phase === "offline") {
    composerPlaceholder = isTauriHost()
      ? "Write a prompt while Xiao reconnects"
      : "Write a prompt to use in the native Xiao app";
  } else if (runtime.phase === "error") {
    composerPlaceholder = "Resolve the runtime issue to send this task";
  } else if (canSteer) {
    composerPlaceholder = "Queue a follow-up while Xiao is working";
  } else if (runtime.phase === "working") {
    composerPlaceholder = "Xiao is working in another task";
  }

  return (
    <div className={`composer-wrap ${planSteps.length ? "has-plan" : ""}`}>
      {goal && (
        <div className="goal-strip">
          <XiaoIcon name="target" size={15} />
          <span title={goal.objective}>{goal.objective}</span>
          <button onClick={() => void onGoalSet(goal.objective, goal.status === "paused" ? "active" : "paused")}>
            {goal.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button onClick={() => setGoalEditorOpen(true)}>Edit</button>
          <button aria-label="Clear goal" onClick={() => void onGoalClear()}>
            <XiaoIcon name="close" size={13} />
          </button>
        </div>
      )}
      {goalEditorOpen && (
        <div className="goal-editor">
          <label htmlFor="xiao-goal">Goal</label>
          <input
            id="xiao-goal"
            value={goalValue}
            maxLength={4000}
            autoFocus
            onChange={(event) => setGoalValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveGoal();
              if (event.key === "Escape") setGoalEditorOpen(false);
            }}
          />
          <button className="button button--primary" disabled={!goalValue.trim()} onClick={() => void saveGoal()}>
            Save goal
          </button>
          <button className="button button--quiet" onClick={() => setGoalEditorOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      {visibleError && <div className="composer-error" id="composer-error" role="alert">{visibleError}</div>}
      {showOfflineNotice && (
        <div className="composer-notice" id="composer-runtime-notice" role="status">
          <XiaoIcon name="runtime" size={15} />
          <span>{offlineMessage}</span>
          <button type="button" onClick={() => onOpenView("runtime")}>View runtime</button>
        </div>
      )}
      {planSteps.length > 0 && (
        <div className={`plan-dock ${planCollapsed ? "is-collapsed" : ""}`}>
          <button
            className="plan-dock__toggle"
            type="button"
            aria-expanded={!planCollapsed}
            aria-controls="composer-plan-steps"
            onClick={() => setPlanCollapsed((collapsed) => !collapsed)}
          >
            <span className="plan-dock__identity">
              <span className="plan-dock__mark"><XiaoIcon name="plan" size={14} /></span>
              <span>
                <small>Step {activePlanStepNumber} / {planSteps.length}</small>
                <strong>{planComplete ? "Complete" : activePlanStep?.step}</strong>
              </span>
            </span>
            <span className="plan-dock__current">
              {changeSummary.files} {changeSummary.files === 1 ? "file" : "files"} changed
              <b className="plan-dock__additions">+{changeSummary.additions}</b>
              <b className="plan-dock__deletions">-{changeSummary.deletions}</b>
            </span>
            <span
              className="plan-dock__progress"
              role="progressbar"
              aria-label="Plan progress"
              aria-valuemin={0}
              aria-valuemax={planSteps.length}
              aria-valuenow={completedPlanSteps}
            >
              <i style={{ "--plan-progress": `${planProgress}%` } as React.CSSProperties} />
            </span>
            <span className="plan-dock__chevron"><XiaoIcon name="caret" size={13} /></span>
          </button>
          <div
            className="plan-dock__body"
            id="composer-plan-steps"
            aria-hidden={planCollapsed}
          >
            <ol className="plan-dock__list">
              {planSteps.map((step, index) => {
                const statusLabel =
                  step.status === "completed"
                    ? "Completed"
                    : step.status === "inProgress"
                      ? "In progress"
                      : "Pending";
                return (
                  <li
                    className={step.status === "inProgress" ? "is-in-progress" : `is-${step.status}`}
                    aria-label={`${statusLabel}: ${step.step}`}
                    key={`${index}-${step.step}`}
                  >
                    <span className="plan-dock__check" aria-hidden="true">
                      {step.status === "completed" ? (
                        <XiaoIcon name="check" size={11} strokeWidth={2.1} />
                      ) : step.status === "inProgress" ? (
                        <i />
                      ) : <b>{index + 1}</b>}
                    </span>
                    <span>{step.step}</span>
                    {step.status !== "pending" ? <small>{step.status === "inProgress" ? "Now" : "Done"}</small> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
      {followUps.length > 0 && (
        <section className="follow-up-dock" aria-label={`${followUps.length} queued follow-ups`}>
          <header>
            <span><XiaoIcon name="taskQueue" size={14} /> Follow-up queue</span>
            <small>{followUps.length} waiting</small>
          </header>
          <ol>
            {followUps.map((followUp, index) => {
              const sending = sendingFollowUpId === followUp.id;
              const failed = failedFollowUpId === followUp.id;
              return (
                <li className={failed ? "is-error" : sending ? "is-sending" : undefined} key={followUp.id}>
                  <span>{index + 1}</span>
                  <div>
                    <strong>{followUp.prompt}</strong>
                    <small>
                      {sending
                        ? "Starting now"
                        : failed
                          ? "Could not start"
                          : index === 0
                            ? "Runs when the current turn ends"
                            : "Runs after the previous follow-up"}
                      {followUp.attachments.length ? ` · ${followUp.attachments.length} attachment${followUp.attachments.length === 1 ? "" : "s"}` : ""}
                    </small>
                  </div>
                  <button
                    className="follow-up-dock__send"
                    type="button"
                    disabled={sending || Boolean(activeQuestionRequest) || (!canSteer && !failed)}
                    title={canSteer
                      ? "Send this message to the current turn"
                      : failed
                        ? "Retry this queued message"
                        : "Available once the current turn starts"}
                    onClick={() => {
                      if (failed && !canSteer) onRetryFollowUp();
                      else void onSendFollowUpNow(followUp.id);
                    }}
                  >
                    <XiaoIcon name="send" size={11} />
                    <span>{failed ? (canSteer ? "Retry now" : "Retry") : "Send now"}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove queued follow-up ${index + 1}`}
                    disabled={sending}
                    onClick={() => onRemoveFollowUp(followUp.id)}
                  >
                    <XiaoIcon name="close" size={12} />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {activeQuestionRequest ? (
        <QuestionDock
          key={String(activeQuestionRequest.requestId)}
          request={activeQuestionRequest}
          onResolve={onResolveQuestion}
        />
      ) : null}
      <div
        className={`composer ${currentTaskWorking ? "is-working" : ""} ${
          dragging ? "is-dragging" : ""
        } ${effectiveReasoningEffort === "ultra" ? "is-ultra" : ""} ${
          activeQuestionRequest ? "is-question-paused" : ""
        }`}
        aria-hidden={activeQuestionRequest ? true : undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="composer__input">
          {slashQuery !== null ? (
            <div
              className="composer-slash-menu"
              ref={slashMenu}
              role="dialog"
              aria-label="Xiao commands"
            >
              <header>
                <span className="composer-slash-menu__identity">
                  <b>/</b>
                  <strong>Commands</strong>
                  <code>{slashQuery ? `/${slashQuery}` : "Task and workspace actions"}</code>
                </span>
                <small>{filteredSlashCommands.length} {filteredSlashCommands.length === 1 ? "result" : "results"}</small>
              </header>
              <div
                className="composer-slash-menu__list"
                id="composer-slash-commands"
                role="listbox"
                aria-label="Available commands"
              >
                {filteredSlashCommands.map((command, index) => {
                  const disabledReason = disabledReasonForSlashCommand(command);
                  const active = index === activeSlashCommand;
                  return (
                    <button
                      className={`${active ? "is-active" : ""}${disabledReason ? " is-disabled" : ""}`.trim() || undefined}
                      id={`composer-slash-command-${command.id}`}
                      type="button"
                      role="option"
                      aria-disabled={disabledReason ? true : undefined}
                      aria-selected={active}
                      key={command.id}
                      ref={(node) => {
                        slashCommandOptions.current[index] = node;
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveSlashCommand(index)}
                      onClick={() => chooseSlashCommand(command)}
                    >
                      <span className="composer-slash-menu__icon"><XiaoIcon name={command.icon} size={14} /></span>
                      <span className="composer-slash-menu__copy">
                        <strong><code>/{command.trigger}</code><span>{command.title}</span></strong>
                        <small>{disabledReason ?? command.description}</small>
                      </span>
                      <em>{disabledReason ? "Unavailable" : command.group}</em>
                    </button>
                  );
                })}
                {!filteredSlashCommands.length ? <p><strong>No matching command</strong><span>Try /review, /plan, or /files.</span></p> : null}
              </div>
              <footer><span><kbd>↑↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run <kbd>Esc</kbd> Close</span></footer>
            </div>
          ) : null}
          {fileMention ? (
            <div className="composer-file-search" role="listbox" aria-label="Workspace files">
              <header>
                <span><XiaoIcon name="mention" size={13} /> Add workspace context</span>
                <small>{fileMention.query ? `@${fileMention.query}` : "Type a file name"}</small>
              </header>
              <div>
                {fileResults.map((result, index) => (
                  <button
                    className={index === activeFileResult ? "is-active" : undefined}
                    type="button"
                    role="option"
                    aria-selected={index === activeFileResult}
                    key={`${result.root}:${result.path}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveFileResult(index)}
                    onClick={() => chooseFileResult(result)}
                  >
                    {result.match_type === "directory" ? (
                      <XiaoIcon name="folder" size={14} />
                    ) : (
                      <FileTypeIcon path={result.path} size={14} />
                    )}
                    <span><strong>{result.file_name}</strong><small>{result.path}</small></span>
                    <em>{result.match_type === "directory" ? "Folder" : "File"}</em>
                  </button>
                ))}
                {fileSearchLoading ? <p><XiaoIcon className="is-spinning" name="pending" size={14} /> Searching workspace</p> : null}
                {!fileSearchLoading && fileSearchError ? <p className="is-error">{fileSearchError}</p> : null}
                {!fileSearchLoading && !fileSearchError && !fileResults.length ? <p>No matching files</p> : null}
              </div>
              <footer><span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> attach <kbd>Esc</kbd> close</span></footer>
            </div>
          ) : null}
          {reviewContext.length > 0 && (
            <div className="composer__review-context" aria-label="Review comments ready to send">
              {reviewContext.map((attachment) => {
                const start = attachment.lineStart;
                const end = attachment.lineEnd ?? start;
                const lines = start
                  ? `:${start}${end && end !== start ? `-${end}` : ""}`
                  : "";
                return (
                  <article key={attachment.id ?? `${attachment.path}:${lines}`}>
                    <span><XiaoIcon name="file" size={13} /></span>
                    <div>
                      <strong>{attachment.path}{lines}</strong>
                      <small>{attachment.comment}</small>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove review comment for ${attachment.path}${lines}`}
                      onClick={() => attachment.id && onRemoveReviewContext(attachment.id)}
                    >
                      <XiaoIcon name="close" size={12} />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="composer__attachments" aria-label="Attached files">
              {attachments.map((attachment) => {
                const imageSource =
                  attachment.kind === "image"
                    ? attachment.url ?? (isTauriHost() ? convertFileSrc(attachment.path) : "")
                    : "";
                return (
                  <article className={`composer__attachment ${imageSource ? "is-image" : ""}`} key={attachment.path} title={attachment.path}>
                    {imageSource ? (
                      <button className="composer__attachment-preview" type="button" onClick={() => setPreviewImage({ src: imageSource, name: attachment.name })}>
                        <img src={imageSource} alt={attachment.name} />
                      </button>
                    ) : (
                      <XiaoIcon name={attachment.kind === "directory" ? "folder" : "file"} size={14} />
                    )}
                    <span>{attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((item) => item.path !== attachment.path),
                        )
                      }
                    >
                      <XiaoIcon name="close" size={13} />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
          {previewImage ? <ImageLightbox src={previewImage.src} alt={previewImage.name} onClose={() => setPreviewImage(null)} /> : null}
          <textarea
            ref={textarea}
            autoFocus={autoFocus}
            value={value}
            disabled={disabled || compacting || undoing}
            aria-keyshortcuts="ArrowUp ArrowDown Control+Enter Meta+Enter"
            aria-autocomplete={slashQuery !== null || fileMention ? "list" : undefined}
            aria-controls={slashQuery !== null ? "composer-slash-commands" : undefined}
            aria-expanded={slashQuery !== null ? true : undefined}
            aria-activedescendant={
              slashQuery !== null && filteredSlashCommands[activeSlashCommand]
                ? `composer-slash-command-${filteredSlashCommands[activeSlashCommand].id}`
                : undefined
            }
            aria-describedby={
              visibleError
                ? "composer-error"
                : showOfflineNotice
                  ? "composer-runtime-notice"
                  : undefined
            }
            rows={1}
            placeholder={composerPlaceholder}
            onPaste={onPaste}
            onChange={(event) => {
              resetPromptHistoryNavigation();
              updateValue(event.target.value);
              syncFileMention(event.target.value, event.target.selectionStart);
              syncSlashCommand(event.target.value, event.target.selectionStart);
              resizeTextarea();
            }}
            onBlur={flushDraftChange}
            onKeyDown={(event) => {
              if (slashQuery !== null) {
                const ctrlNavigation = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
                if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  (ctrlNavigation && (event.key.toLowerCase() === "n" || event.key.toLowerCase() === "p"))
                ) {
                  event.preventDefault();
                  const forward = event.key === "ArrowDown" || event.key.toLowerCase() === "n";
                  moveActiveSlashCommand(forward ? 1 : -1);
                  return;
                }
                if ((event.key === "Enter" || event.key === "Tab") && filteredSlashCommands.length) {
                  event.preventDefault();
                  chooseSlashCommand(filteredSlashCommands[activeSlashCommand] ?? filteredSlashCommands[0]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashQuery(null);
                  return;
                }
              }
              if (fileMention) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (fileResults.length) {
                    setActiveFileResult((current) =>
                      (current + (event.key === "ArrowDown" ? 1 : -1) + fileResults.length) % fileResults.length,
                    );
                  }
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const result = fileResults[activeFileResult];
                  if (result) chooseFileResult(result);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setFileMention(null);
                  return;
                }
              }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                const direction = event.key === "ArrowUp" ? "up" : "down";
                if (
                  canNavigatePromptHistory(
                    direction,
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                    promptHistoryIndex.current >= 0,
                  ) && moveThroughPromptHistory(direction)
                ) {
                  event.preventDefault();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const delivery = currentTaskWorking && (event.ctrlKey || event.metaKey) && canSteer
                  ? "send"
                  : currentTaskWorking
                    ? "queue"
                    : "send";
                void submit(delivery);
              }
            }}
            onSelect={(event) => {
              syncFileMention(event.currentTarget.value, event.currentTarget.selectionStart);
              syncSlashCommand(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
          />
        </div>
        <div className="composer__toolbar">
          <div className="composer__tools-left">
            <div className="composer-add" ref={addMenu}>
              <button
                type="button"
                ref={addMenuTrigger}
                aria-label="Add context or task settings"
                aria-expanded={addMenuOpen}
                disabled={disabled || compacting || undoing || selectingAttachments}
                onClick={(event) => {
                  const nextOpen = !addMenuOpen;
                  setAddMenuOpen(nextOpen);
                  if (nextOpen && event.detail === 0) {
                    window.requestAnimationFrame(() =>
                      addMenu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
                    );
                  }
                }}
              >
                <XiaoIcon name="add" size={18} />
              </button>
              {addMenuOpen && (
                <div className="composer-add__menu" role="dialog" aria-label="Context and task settings">
                  <button onClick={() => void selectAttachments(false)}>
                    <XiaoIcon name="files" size={16} />
                    <span><strong>Files</strong><small>Attach files or paste images with Ctrl/Command V</small></span>
                  </button>
                  <button onClick={() => void selectAttachments(true)}>
                    <XiaoIcon name="folder" size={16} />
                    <span><strong>Folder</strong><small>Add a folder as context</small></span>
                  </button>
                  <button onClick={() => { setGoalEditorOpen(true); setAddMenuOpen(false); }}>
                    <XiaoIcon name="target" size={16} />
                    <span><strong>Goal</strong><small>Set a persistent objective</small></span>
                  </button>
                  <button onClick={() => { onModeChange(mode === "plan" ? "default" : "plan"); setAddMenuOpen(false); }}>
                    <XiaoIcon name="plan" size={16} />
                    <span><strong>Plan mode</strong><small>{mode === "plan" ? "Turn plan mode off" : "Plan before implementation"}</small></span>
                  </button>
                  <button onClick={() => { onOpenView("extensions"); setAddMenuOpen(false); }}>
                    <XiaoIcon name="capability" size={16} />
                    <span><strong>Capabilities</strong><small>Inspect skills, plugins, MCP, and apps</small></span>
                  </button>
                  <div className="composer-add__settings">
                    <span>Run environment</span>
                    <label title={isolationUnavailableReason ?? undefined}>
                      <span>Workspace</span>
                      <select
                        aria-label="Workspace mode"
                        value={workspaceMode}
                        disabled={disabled || environmentBusy}
                        onChange={(event) =>
                          void onWorkspaceModeChange(event.target.value as XiaoWorkspaceMode)
                        }
                      >
                        <option value="local">Local project</option>
                        <option
                          value="managed-worktree"
                          disabled={!isolationAvailable && workspaceMode !== "managed-worktree"}
                        >
                          Isolated worktree
                        </option>
                      </select>
                    </label>
                    {managedWorktree ? (
                      <small title={managedWorktree.checkoutPath}>
                        {managedWorktree.branch} · {managedWorktree.sizeComplete ? "" : "≥"}
                        {compactBytes(managedWorktree.diskBytes)}
                        {managedWorktree.hasChanges ? " · uncommitted changes" : ""}
                      </small>
                    ) : null}
                    {environmentBusy ? <small>Preparing execution environment…</small> : null}
                    {environmentError ? <small className="is-error">{environmentError}</small> : null}
                    <span>Run permissions</span>
                    <label>
                      <span>Approval</span>
                      <select
                        aria-label="Approval policy"
                        value={approvalPolicy}
                        disabled={disabled}
                        onChange={(event) =>
                          onApprovalPolicyChange(event.target.value as AgentApprovalPolicy)
                        }
                      >
                        <option value="on-request">Ask approval</option>
                        <option value="untrusted">Untrusted only</option>
                        <option value="never">Never ask</option>
                      </select>
                    </label>
                    <label>
                      <span>Sandbox</span>
                      <select
                        aria-label="Sandbox mode"
                        value={sandboxMode}
                        disabled={disabled}
                        onChange={(event) =>
                          onSandboxModeChange(event.target.value as AgentSandboxMode)
                        }
                      >
                        <option value="workspace-write">Workspace</option>
                        <option value="read-only">Read only</option>
                        <option value="danger-full-access">Full access</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </div>
            {mode === "plan" && <span className="composer-mode"><XiaoIcon name="plan" size={13} /> Plan</span>}
            <ModelPicker
              models={models}
              selectedModel={selectedModel}
              selectedReasoningEffort={selectedReasoningEffort}
              fastMode={fastMode}
              disabled={disabled || undoing || runtime.phase === "starting"}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onFastModeChange={onFastModeChange}
            />
          </div>
          <div className="composer__actions">
            {currentTaskWorking && (
              <button className="composer__stop" aria-label="Stop current turn" onClick={() => void onInterrupt()}>
                <XiaoIcon name="close" size={16} />
              </button>
            )}
            {canSteer && canSubmit && (
              <button
                className="composer__steer"
                type="button"
                title="Send immediately to the current turn (Ctrl/Command+Enter)"
                onClick={() => void submit("send")}
              >
                Steer now
              </button>
            )}
            <button
              className="composer__submit"
              aria-label={currentTaskWorking ? "Queue follow-up" : "Send task"}
              disabled={!canSubmit}
              onClick={() => void submit(currentTaskWorking ? "queue" : "send")}
            >
              <XiaoIcon name={currentTaskWorking ? "taskQueue" : "send"} size={18} strokeWidth={1.9} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type FuzzyFileResult = {
  root: string;
  path: string;
  match_type: "directory" | "file";
  file_name: string;
  score: number;
  indices: number[] | null;
};

type FuzzyFileResponse = { files: FuzzyFileResult[] };
