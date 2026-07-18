import { useEffect, useMemo, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  MissedRunPolicy,
  RoutineScheduleKind,
  RoutineSummary,
} from "../../../core/models/routine";

export type RoutineDraft = {
  title: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  timezone: string;
  scheduledFor: number | null;
  dailyTime: string | null;
  missedRunPolicy: MissedRunPolicy;
  preferIsolation: boolean;
  dangerousAccessConfirmed: boolean;
};

type SchedulePanelProps = {
  routines: RoutineSummary[];
  loading: boolean;
  error: string | null;
  creating: boolean;
  busyIds: ReadonlySet<string>;
  nativeAvailable: boolean;
  dangerousAccessDefault: boolean;
  dangerousRoutineIds: ReadonlySet<string>;
  openRunId: string | null;
  onCreate: (draft: RoutineDraft) => Promise<void>;
  onUpdate: (routineId: string, draft: RoutineDraft) => Promise<void>;
  onSetEnabled: (routineId: string, enabled: boolean) => Promise<void>;
  onRunNow: (routineId: string) => Promise<void>;
  onDelete: (routineId: string) => Promise<void>;
  onClearError: () => void;
};

type FormState = {
  title: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  runAt: string;
  dailyTime: string;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  preferIsolation: boolean;
  dangerousAccessConfirmed: boolean;
};

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const emptyForm = (): FormState => ({
  title: "",
  prompt: "",
  scheduleKind: "one_shot",
  runAt: "",
  dailyTime: "09:00",
  timezone: localTimezone(),
  missedRunPolicy: "run_once",
  preferIsolation: true,
  dangerousAccessConfirmed: false,
});

const toLocalDateTimeInput = (timestamp: number | null) => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const formatTimestamp = (timestamp: number | null, timezone?: string) => {
  if (!timestamp) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
};

const readableStatus = (status: string) => status.replaceAll("_", " ");

const routineState = (routine: RoutineSummary) => {
  if (routine.lastStatus) return routine.lastStatus;
  return routine.enabled ? "scheduled" : "disabled";
};

const formFromRoutine = (routine: RoutineSummary): FormState => ({
  title: routine.title,
  prompt: routine.prompt,
  scheduleKind: routine.scheduleKind,
  runAt: toLocalDateTimeInput(routine.scheduledFor),
  dailyTime: routine.dailyTime ?? "09:00",
  timezone: routine.scheduleKind === "one_shot" ? localTimezone() : routine.timezone,
  missedRunPolicy: routine.missedRunPolicy,
  preferIsolation: routine.workspaceMode === "managed-worktree" || Boolean(routine.isolationWarning),
  dangerousAccessConfirmed: false,
});

export function SchedulePanel({
  routines,
  loading,
  error,
  creating,
  busyIds,
  nativeAvailable,
  dangerousAccessDefault,
  dangerousRoutineIds,
  openRunId,
  onCreate,
  onUpdate,
  onSetEnabled,
  onRunNow,
  onDelete,
  onClearError,
}: SchedulePanelProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const editingRoutine = useMemo(
    () => routines.find((routine) => routine.id === editingId) ?? null,
    [editingId, routines],
  );
  const requiresDangerConfirmation = editingRoutine
    ? dangerousRoutineIds.has(editingRoutine.id) || editingRoutine.sandboxMode === "danger-full-access"
    : dangerousAccessDefault;

  useEffect(() => {
    if (!openRunId) return;
    const routine = routines.find((item) =>
      item.history.some((occurrence) => occurrence.run?.id === openRunId),
    );
    if (!routine) return;
    setExpandedId(routine.id);
  }, [openRunId, routines]);

  useEffect(() => {
    if (!openRunId || !expandedId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`routine-run-${openRunId}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedId, openRunId, routines]);

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
    setFormError(null);
  };

  const submit = async () => {
    const prompt = form.prompt.trim();
    const timezone = form.timezone.trim();
    if (!prompt) {
      setFormError("Describe what Xiao should do.");
      return;
    }
    if (!timezone) {
      setFormError("Enter an IANA timezone, such as America/New_York.");
      return;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      setFormError("Enter a valid IANA timezone, such as America/New_York.");
      return;
    }
    const scheduledFor = form.scheduleKind === "one_shot"
      ? new Date(form.runAt).getTime()
      : null;
    if (form.scheduleKind === "one_shot" && (!form.runAt || Number.isNaN(scheduledFor))) {
      setFormError("Choose a valid date and time.");
      return;
    }
    if (form.scheduleKind === "one_shot" && scheduledFor !== null && scheduledFor <= Date.now()) {
      setFormError("Choose a future date and time.");
      return;
    }
    if (form.scheduleKind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.dailyTime)) {
      setFormError("Daily time must use a valid HH:MM value.");
      return;
    }
    if (requiresDangerConfirmation && !form.dangerousAccessConfirmed) {
      setFormError("Confirm danger-full-access before saving this routine.");
      return;
    }

    const draft: RoutineDraft = {
      title: form.title.trim(),
      prompt,
      scheduleKind: form.scheduleKind,
      timezone,
      scheduledFor,
      dailyTime: form.scheduleKind === "daily" ? form.dailyTime : null,
      missedRunPolicy: form.missedRunPolicy,
      preferIsolation: form.preferIsolation,
      dangerousAccessConfirmed: form.dangerousAccessConfirmed,
    };
    setFormError(null);
    try {
      if (editingId) await onUpdate(editingId, draft);
      else await onCreate(draft);
      resetForm();
    } catch {
      // Native operation errors are rendered from the routine controller.
    }
  };

  const startEdit = (routine: RoutineSummary) => {
    onClearError();
    setEditingId(routine.id);
    setForm(formFromRoutine(routine));
    setFormError(null);
    window.requestAnimationFrame(() => {
      document.getElementById("routine-form")?.scrollIntoView({ block: "start" });
    });
  };

  const perform = (operation: () => Promise<void>) => {
    void operation().catch(() => undefined);
  };

  return (
    <section className="rail-section schedule-panel">
      <header className="rail-section__header">
        <div><span>Native scheduler</span><h2>Routines</h2></div>
        <XiaoIcon name="routine" size={20} />
      </header>
      <p className="rail-section__summary">
        Durable one-shot and daily work. Window close keeps Xiao in the tray; Quit pauses future runs until Xiao opens again.
      </p>

      {!nativeAvailable ? (
        <div className="rail-error">Routines require the Xiao desktop app.</div>
      ) : null}
      {error ? (
        <div className="routine-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onClearError} aria-label="Dismiss routine error">
            <XiaoIcon name="close" size={12} />
          </button>
        </div>
      ) : null}

      <div className="routine-form" id="routine-form" aria-label={editingId ? "Edit routine" : "Create routine"}>
        <div className="routine-form__heading">
          <div>
            <strong>{editingId ? "Edit routine" : "New routine"}</strong>
            <small>Each routine keeps a dedicated task and run history.</small>
          </div>
          {editingId ? (
            <button className="button button--quiet" type="button" onClick={resetForm}>Cancel</button>
          ) : null}
        </div>

        <label>
          <span>Name</span>
          <input
            value={form.title}
            placeholder="Daily code review"
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            rows={4}
            value={form.prompt}
            placeholder="What should Xiao do?"
            onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>

        <div className="routine-form__row">
          <label>
            <span>Repeats</span>
            <select
              value={form.scheduleKind}
              onChange={(event) => setForm((current) => {
                const scheduleKind = event.target.value as RoutineScheduleKind;
                return {
                  ...current,
                  scheduleKind,
                  timezone: scheduleKind === "one_shot" ? localTimezone() : current.timezone,
                };
              })}
            >
              <option value="one_shot">One time</option>
              <option value="daily">Every day</option>
            </select>
          </label>
          <label>
            <span>{form.scheduleKind === "one_shot" ? "Run at" : "Local time"}</span>
            {form.scheduleKind === "one_shot" ? (
              <input
                type="datetime-local"
                value={form.runAt}
                onChange={(event) => setForm((current) => ({ ...current, runAt: event.target.value }))}
              />
            ) : (
              <input
                type="time"
                value={form.dailyTime}
                onChange={(event) => setForm((current) => ({ ...current, dailyTime: event.target.value }))}
              />
            )}
          </label>
        </div>

        <div className="routine-form__row">
          <label>
            <span>{form.scheduleKind === "one_shot" ? "Device timezone" : "Timezone"}</span>
            <input
              value={form.timezone}
              disabled={form.scheduleKind === "one_shot"}
              spellCheck={false}
              onChange={(event) => setForm((current) => ({ ...current, timezone: event.target.value }))}
            />
          </label>
          <label>
            <span>If Xiao was closed</span>
            <select
              value={form.missedRunPolicy}
              onChange={(event) => setForm((current) => ({
                ...current,
                missedRunPolicy: event.target.value as MissedRunPolicy,
              }))}
            >
              <option value="run_once">Run once on return</option>
              <option value="skip">Skip missed work</option>
            </select>
          </label>
        </div>

        <label className="routine-check">
          <input
            type="checkbox"
            checked={form.preferIsolation}
            disabled={editingRoutine?.workspaceMode === "managed-worktree"}
            onChange={(event) => setForm((current) => ({ ...current, preferIsolation: event.target.checked }))}
          />
          <span>
            <strong>Prefer an isolated worktree</strong>
            <small>{editingRoutine?.workspaceMode === "managed-worktree"
              ? "This routine already owns an isolated worktree."
              : "Falls back to the local workspace only when Git isolation is unavailable."}</small>
          </span>
        </label>
        {requiresDangerConfirmation ? (
          <label className="routine-check routine-check--danger">
            <input
              type="checkbox"
              checked={form.dangerousAccessConfirmed}
              onChange={(event) => setForm((current) => ({
                ...current,
                dangerousAccessConfirmed: event.target.checked,
              }))}
            />
            <span><strong>Allow danger-full-access</strong><small>This routine can modify files outside the workspace sandbox.</small></span>
          </label>
        ) : null}
        {formError ? <p className="routine-form__error" role="alert">{formError}</p> : null}
        <button
          className="button button--primary routine-form__submit"
          type="button"
          disabled={!nativeAvailable || creating || Boolean(editingId && busyIds.has(editingId))}
          onClick={() => void submit()}
        >
          {creating || (editingId && busyIds.has(editingId)) ? (
            <XiaoIcon className="is-spinning" name="pending" size={13} />
          ) : null}
          {editingId ? "Save routine" : "Create routine"}
        </button>
      </div>

      <div className="routine-list" aria-busy={loading}>
        <div className="routine-list__heading">
          <strong>Saved routines</strong>
          <small>{routines.length}</small>
        </div>
        {loading ? (
          <div className="routine-skeleton" aria-label="Loading routines">
            <i /><i /><i />
          </div>
        ) : null}
        {!loading && routines.map((routine) => {
          const state = routineState(routine);
          const expanded = expandedId === routine.id;
          const busy = busyIds.has(routine.id);
          return (
            <article className={`routine-card ${expanded ? "is-expanded" : ""}`} key={routine.id}>
              <header>
                <span className={`routine-state routine-state--${state}`} aria-label={readableStatus(state)} />
                <button
                  className="routine-card__summary"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : routine.id)}
                >
                  <strong>{routine.title}</strong>
                  <small>
                    {routine.enabled
                      ? `Next: ${formatTimestamp(routine.nextRunAt, routine.timezone)}`
                      : `Disabled, last status: ${readableStatus(routine.lastStatus ?? "not run")}`}
                  </small>
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={expanded ? `Collapse ${routine.title}` : `Expand ${routine.title}`}
                  onClick={() => setExpandedId(expanded ? null : routine.id)}
                >
                  <XiaoIcon className={expanded ? "routine-card__caret is-open" : "routine-card__caret"} name="caret" size={13} />
                </button>
              </header>

              {expanded ? (
                <div className="routine-card__details">
                  <p>{routine.prompt}</p>
                  <dl>
                    <div><dt>Schedule</dt><dd>{routine.scheduleKind === "daily" ? `Daily at ${routine.dailyTime}` : formatTimestamp(routine.scheduledFor, routine.timezone)}</dd></div>
                    <div><dt>Timezone</dt><dd>{routine.timezone}</dd></div>
                    <div><dt>Missed work</dt><dd>{routine.missedRunPolicy === "run_once" ? "Run once" : "Skip"}</dd></div>
                    <div><dt>Workspace</dt><dd>{routine.workspaceMode === "managed-worktree" ? "Isolated worktree" : "Local workspace"}</dd></div>
                    <div><dt>Sandbox</dt><dd>{readableStatus(routine.sandboxMode)}</dd></div>
                    <div><dt>Approval</dt><dd>{readableStatus(routine.approvalPolicy)}</dd></div>
                    <div><dt>Model</dt><dd>{routine.model ?? "Default model"}</dd></div>
                    <div><dt>Reasoning</dt><dd>{routine.reasoningEffort ?? "Default effort"}</dd></div>
                    <div><dt>Service</dt><dd>{routine.serviceTier ?? "Standard"}</dd></div>
                  </dl>
                  {routine.isolationWarning ? <p className="routine-card__warning">{routine.isolationWarning}</p> : null}
                  {routine.lastError ? <p className="routine-card__error">{routine.lastError}</p> : null}

                  <div className="routine-card__actions">
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => perform(() => onRunNow(routine.id))}>
                      <XiaoIcon name="enter" size={12} /> Run now
                    </button>
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => perform(() => onSetEnabled(routine.id, !routine.enabled))}>
                      <XiaoIcon name="power" size={12} /> {routine.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => startEdit(routine)}>
                      <XiaoIcon name="edit" size={12} /> Edit
                    </button>
                  </div>

                  {routine.history.length ? (
                    <div className="routine-history">
                      <strong>Recent runs</strong>
                      <ol>
                        {routine.history.map((occurrence) => {
                          const status = occurrence.run?.status ?? occurrence.status;
                          const target = occurrence.run?.id === openRunId;
                          return (
                            <li
                              className={target ? "is-target" : undefined}
                              id={occurrence.run ? `routine-run-${occurrence.run.id}` : undefined}
                              key={occurrence.id}
                            >
                              <span>{formatTimestamp(occurrence.scheduledFor, routine.timezone)}</span>
                              <small>{occurrence.triggerKind === "manual" ? "Manual" : "Scheduled"}, {readableStatus(status)}</small>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  ) : <p className="routine-history__empty">No runs yet.</p>}

                  {confirmDeleteId === routine.id ? (
                    <div className="routine-delete-confirm" role="alert">
                      <p>Delete this routine? Existing runs and task history remain available.</p>
                      <div>
                        <button className="button button--quiet" type="button" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                        <button className="button routine-button--danger" type="button" disabled={busy} onClick={() => perform(async () => {
                          await onDelete(routine.id);
                          setConfirmDeleteId(null);
                        })}>Delete</button>
                      </div>
                    </div>
                  ) : (
                    <button className="routine-delete" type="button" disabled={busy} onClick={() => setConfirmDeleteId(routine.id)}>Delete routine</button>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
        {!loading && routines.length === 0 ? (
          <div className="rail-empty">
            <XiaoIcon name="routine" size={24} />
            <strong>No routines yet</strong>
            <p>Create one scheduled task to start.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
