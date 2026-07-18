import { useMemo, useState } from "react";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import { isTauriHost } from "../../../core/bridges/tauri";
import type {
  AgentAccountSummary,
  AgentModelSummary,
  AgentRuntimeState,
} from "../../../core/models/agent";
import type { CodexUpdateResult, CodexUpdateStatus, SystemInfo } from "../../../core/models/workspace";
import type { AppPreferences } from "../hooks/useAppPreferences";
import type { Theme } from "../hooks/useTheme";
import "../styles/settings.css";

export type ArchivedTaskItem = {
  taskId: string;
  title: string;
  updatedAt: number;
  projectPath: string;
  projectName: string;
  origin?: "xiao" | "codex";
  threadId?: string | null;
};

type SettingsSection = "agent" | "archived" | "general" | "models" | "runtime" | "shortcuts";

type SettingsPageProps = {
  theme: Theme;
  preferences: AppPreferences;
  models: AgentModelSummary[];
  account: AgentAccountSummary | null;
  runtime: AgentRuntimeState;
  system: SystemInfo;
  codexUpdate: CodexUpdateStatus | null;
  codexUpdateResult: CodexUpdateResult | null;
  codexUpdateChecking: boolean;
  codexUpdating: boolean;
  codexUpdateError: string | null;
  archivedTasks: ArchivedTaskItem[];
  archivedTasksLoading: boolean;
  archivedTasksError: string | null;
  onThemeChange: (theme: Theme) => void;
  onPreferencesChange: (patch: Partial<AppPreferences>) => void;
  onRestoreArchivedTask: (item: ArchivedTaskItem) => void;
  onReloadArchivedTasks: () => void;
  onReconnect: () => void;
  onCheckCodexUpdate: () => void;
  onUpdateCodex: () => void;
  onClose: () => void;
};

const themes: Array<{ id: Theme; label: string; description: string }> = [
  { id: "system", label: "System", description: "Follow the Windows appearance automatically." },
  { id: "light", label: "Light", description: "Warm paper surfaces with crisp code contrast." },
  { id: "dark", label: "Dark", description: "A low-glare graphite workspace for long runs." },
  { id: "midnight", label: "Midnight", description: "Deep contrast, quieter chrome, and brighter code detail." },
];

const sections: Array<{ id: SettingsSection; label: string; icon: XiaoIconName; group: string }> = [
  { id: "general", label: "General", icon: "settings", group: "Workspace" },
  { id: "agent", label: "Agent feed", icon: "approach", group: "Workspace" },
  { id: "models", label: "Models", icon: "cpu", group: "Workspace" },
  { id: "runtime", label: "Runtime", icon: "runtime", group: "System" },
  { id: "shortcuts", label: "Shortcuts", icon: "command", group: "System" },
  { id: "archived", label: "Archive", icon: "archive", group: "Data" },
];

const shortcuts = [
  { action: "New task", keys: ["Ctrl", "N"] },
  { action: "Search and commands", keys: ["Ctrl", "K"] },
  { action: "Open runtime", keys: ["Ctrl", "`"] },
  { action: "Open terminal", keys: ["Ctrl", "J"] },
  { action: "Send prompt", keys: ["Enter"] },
  { action: "New line in prompt", keys: ["Shift", "Enter"] },
  { action: "Browse prompt history", keys: ["↑", "↓"] },
  { action: "Paste image", keys: ["Ctrl", "V"] },
  { action: "Send line comment", keys: ["Ctrl", "Enter"] },
];

const archivedTaskDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      className={`settings-toggle ${checked ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div><strong>{title}</strong><p>{description}</p></div>
      <div>{children}</div>
    </div>
  );
}

export function SettingsPage({
  theme,
  preferences,
  models,
  account,
  runtime,
  system,
  codexUpdate,
  codexUpdateResult,
  codexUpdateChecking,
  codexUpdating,
  codexUpdateError,
  archivedTasks,
  archivedTasksLoading,
  archivedTasksError,
  onThemeChange,
  onPreferencesChange,
  onRestoreArchivedTask,
  onReloadArchivedTasks,
  onReconnect,
  onCheckCodexUpdate,
  onUpdateCodex,
  onClose,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [modelQuery, setModelQuery] = useState("");
  const sortedArchivedTasks = [...archivedTasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return models.filter((model) => !query || `${model.displayName} ${model.model} ${model.description}`.toLowerCase().includes(query));
  }, [modelQuery, models]);
  const notificationPermission = isTauriHost()
    ? "Native OS alerts"
    : "Notification" in window ? Notification.permission : "unsupported";

  const updateNotification = (key: "notifyApprovals" | "notifyCompletions" | "notifyErrors" | "notifyUsageAlerts", checked: boolean) => {
    onPreferencesChange({ [key]: checked });
    if (checked && !isTauriHost() && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  const toggleModel = (model: string) => {
    const hiddenModels = preferences.hiddenModels.includes(model)
      ? preferences.hiddenModels.filter((item) => item !== model)
      : [...preferences.hiddenModels, model];
    onPreferencesChange({ hiddenModels });
  };

  return (
    <section className="settings-page">
      <header className="settings-header">
        <div className="settings-header__title">
          <span className="settings-header__mark">XI</span>
          <div><h1>Settings</h1><p>Shape how Xiao looks, thinks, and reports its work.</p></div>
        </div>
        <div className={`settings-header__runtime is-${runtime.phase}`}>
          <i />
          <span>{runtime.phase === "ready" ? "Codex connected" : runtime.phase}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close settings"><XiaoIcon name="close" size={14} /></button>
      </header>

      <div className="settings-body">
        <aside className="settings-index" aria-label="Settings sections">
          {["Workspace", "System", "Data"].map((group) => (
            <div className="settings-index__group" key={group}>
              <span>{group}</span>
              {sections.filter((section) => section.group === group).map((section) => (
                <button
                  type="button"
                  className={activeSection === section.id ? "is-active" : undefined}
                  aria-current={activeSection === section.id ? "page" : undefined}
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                >
                  <XiaoIcon name={section.icon} size={16} />
                  <strong>{section.label}</strong>
                  {section.id === "archived" && archivedTasks.length > 0 ? <small>{archivedTasks.length}</small> : null}
                </button>
              ))}
            </div>
          ))}
          <footer><span>XIAO desktop</span><small>v0.1.0</small></footer>
        </aside>

        <div className="settings-content">
          {activeSection === "general" && (
            <section className="settings-section" aria-labelledby="general-heading">
              <header><span>Workspace</span><h2 id="general-heading">General</h2><p>A calm interface that can get out of the way when work starts.</p></header>
              <div className="settings-block">
                <h3>Appearance</h3>
                <fieldset className="theme-options">
                  <legend>Color scheme</legend>
                  {themes.map((option) => (
                    <label className={`theme-option theme-option--${option.id} ${theme === option.id ? "is-selected" : ""}`} key={option.id}>
                      <input checked={theme === option.id} name="theme" type="radio" value={option.id} onChange={() => onThemeChange(option.id)} />
                      <span className="theme-option__preview" aria-hidden="true"><i className="theme-preview__rail" /><i className="theme-preview__header" /><i className="theme-preview__line theme-preview__line--one" /><i className="theme-preview__line theme-preview__line--two" /><i className="theme-preview__accent" /></span>
                      <span className="theme-option__copy"><strong>{option.label}</strong><small>{option.description}</small></span>
                      <span className="theme-option__check">{theme === option.id && <XiaoIcon name="check" size={13} strokeWidth={2} />}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="settings-list settings-list--appearance">
                  <SettingRow title="Start screen mark" description="Show the app logo or XIAO wordmark above the new-task composer.">
                    <div className="settings-choice" role="group" aria-label="Start screen mark">
                      <button type="button" className={preferences.launchBrand === "logo" ? "is-selected" : undefined} aria-pressed={preferences.launchBrand === "logo"} onClick={() => onPreferencesChange({ launchBrand: "logo" })}>Logo</button>
                      <button type="button" className={preferences.launchBrand === "wordmark" ? "is-selected" : undefined} aria-pressed={preferences.launchBrand === "wordmark"} onClick={() => onPreferencesChange({ launchBrand: "wordmark" })}>XIAO</button>
                    </div>
                  </SettingRow>
                </div>
              </div>
              <div className="settings-block">
                <h3>Behavior</h3>
                <div className="settings-list">
                  <SettingRow title="Focused new tasks" description="Collapse the sidebar and review panel when a blank task opens."><Toggle label="Focused new tasks" checked={preferences.focusNewTasks} onChange={(focusNewTasks) => onPreferencesChange({ focusNewTasks })} /></SettingRow>
                  <SettingRow title="Wrap long code" description="Wrap code in file previews instead of scrolling horizontally."><Toggle label="Wrap long code" checked={preferences.wrapCode} onChange={(wrapCode) => onPreferencesChange({ wrapCode })} /></SettingRow>
                </div>
              </div>
            </section>
          )}

          {activeSection === "agent" && (
            <section className="settings-section" aria-labelledby="agent-heading">
              <header><span>Conversation</span><h2 id="agent-heading">Agent feed</h2><p>Choose how much of Xiao's live work is projected into the task timeline.</p></header>
              <div className="settings-block">
                <h3>Timeline</h3>
                <div className="settings-list">
                  <SettingRow title="Codex history" description="Show persisted Codex conversations for projects you have already added to Xiao."><Toggle label="Import Codex history" checked={preferences.importCodexHistory} onChange={(importCodexHistory) => onPreferencesChange({ importCodexHistory })} /></SettingRow>
                  <SettingRow title="Reasoning summaries" description="Show the reasoning summaries Codex explicitly publishes. Hidden reasoning is never inferred."><Toggle label="Reasoning summaries" checked={preferences.showReasoningSummaries} onChange={(showReasoningSummaries) => onPreferencesChange({ showReasoningSummaries })} /></SettingRow>
                  <SettingRow title="Expand tool output" description="Open command output and patch details by default. Active tools always stay visible."><Toggle label="Expand tool output" checked={preferences.expandToolOutput} onChange={(expandToolOutput) => onPreferencesChange({ expandToolOutput })} /></SettingRow>
                  <SettingRow title="Copy and export" description="Show the chat export menu in the task header. Export filters stay local to the open menu."><Toggle label="Show chat copy and export" checked={preferences.showChatExport} onChange={(showChatExport) => onPreferencesChange({ showChatExport })} /></SettingRow>
                  <SettingRow title="Terminal placement" description="Dock Ctrl/Command + J beside the task or below the composer."><div className="settings-segmented"><button className={preferences.terminalPlacement === "right" ? "is-active" : ""} onClick={() => onPreferencesChange({ terminalPlacement: "right" })}>Right side</button><button className={preferences.terminalPlacement === "bottom" ? "is-active" : ""} onClick={() => onPreferencesChange({ terminalPlacement: "bottom" })}>Bottom</button></div></SettingRow>
                </div>
              </div>
              <div className="settings-block">
                <div className="settings-block__heading"><h3>Desktop notifications</h3><small>{notificationPermission}</small></div>
                <div className="settings-list">
                  <SettingRow title="Task completed" description="Notify when a background or scheduled task finishes."><Toggle label="Task completed notifications" checked={preferences.notifyCompletions} onChange={(checked) => updateNotification("notifyCompletions", checked)} /></SettingRow>
                  <SettingRow title="Input requested" description="Notify when Xiao pauses for permission or a decision."><Toggle label="Input request notifications" checked={preferences.notifyApprovals} onChange={(checked) => updateNotification("notifyApprovals", checked)} /></SettingRow>
                  <SettingRow title="Runtime errors" description="Notify when Codex disconnects or a scheduled task fails."><Toggle label="Runtime error notifications" checked={preferences.notifyErrors} onChange={(checked) => updateNotification("notifyErrors", checked)} /></SettingRow>
                  <SettingRow title="Usage alerts" description="Notify when a quota is nearly exhausted, refills unexpectedly, or new reset credits arrive."><Toggle label="Usage limit notifications" checked={preferences.notifyUsageAlerts} onChange={(checked) => updateNotification("notifyUsageAlerts", checked)} /></SettingRow>
                </div>
              </div>
            </section>
          )}

          {activeSection === "models" && (
            <section className="settings-section settings-section--models" aria-labelledby="models-heading">
              <header><span>OpenAI</span><h2 id="models-heading">Models</h2><p>Control which Codex models appear in Xiao's composer. The current model remains available until you switch.</p></header>
              <label className="settings-search"><XiaoIcon name="search" size={15} /><input type="search" value={modelQuery} placeholder="Search models" onChange={(event) => setModelQuery(event.target.value)} />{modelQuery && <button aria-label="Clear model search" onClick={() => setModelQuery("")}><XiaoIcon name="close" size={12} /></button>}</label>
              <div className="model-settings-list">
                {visibleModels.map((model) => {
                  const visible = !preferences.hiddenModels.includes(model.model);
                  return (
                    <article key={model.id}>
                      <span className="model-settings-list__icon">◎</span>
                      <div><strong>{model.displayName}{model.isDefault && <small>Default</small>}</strong><p>{model.description || model.model}</p><code>{model.model}{model.contextWindow ? ` · ${new Intl.NumberFormat().format(model.contextWindow)} context` : ""}</code></div>
                      <Toggle label={`Show ${model.displayName}`} checked={visible} onChange={() => toggleModel(model.model)} />
                    </article>
                  );
                })}
                {!visibleModels.length && <div className="settings-empty"><strong>No matching models</strong><p>Try a different name or model ID.</p></div>}
              </div>
            </section>
          )}

          {activeSection === "runtime" && (
            <section className="settings-section" aria-labelledby="runtime-heading">
              <header><span>Native bridge</span><h2 id="runtime-heading">Runtime</h2><p>Xiao talks directly to the local Codex app-server. These values come from the active process.</p></header>
              <div className={`runtime-card is-${runtime.phase}`}>
                <div><span className="runtime-card__pulse"><i /></span><div><strong>{runtime.phase === "ready" ? "Codex is ready" : `Codex is ${runtime.phase}`}</strong><p>{runtime.error ?? "The local agent runtime is available for tasks."}</p></div></div>
                <button className="button button--quiet" disabled={codexUpdating || runtime.phase === "starting" || runtime.phase === "working"} onClick={onReconnect}><XiaoIcon name="refresh" size={13} />Reconnect</button>
              </div>
              <div className="runtime-grid">
                <div><span>Account</span><strong>{account?.authenticated ? account.email ?? "Authenticated" : "Not authenticated"}</strong><small>{account?.planType ?? account?.authMode ?? "Codex CLI"}</small></div>
                <div><span>Codex</span><strong>{system.codexVersion ?? "Detecting"}</strong><small>{runtime.eventsSeen.toLocaleString()} events observed</small></div>
                <div><span>Platform</span><strong>{system.platform}</strong><small>Native Xiao host</small></div>
                <div><span>Shell</span><strong>{system.shell}</strong><small>Workspace commands</small></div>
              </div>
              <div className={`codex-update-card ${codexUpdate?.updateAvailable ? "is-available" : ""}`}>
                <span className="codex-update-card__icon">
                  <XiaoIcon className={codexUpdateChecking || codexUpdating ? "is-spinning" : undefined} name={codexUpdateChecking || codexUpdating ? "pending" : "refresh"} size={16} />
                </span>
                <div className="codex-update-card__copy">
                  <strong>
                    {codexUpdating
                      ? "Updating Codex"
                      : codexUpdateChecking && !codexUpdate
                        ? "Checking for updates"
                        : codexUpdateError
                          ? "Update check unavailable"
                          : codexUpdate?.updateAvailable
                            ? `Codex ${codexUpdate.latestVersion} is available`
                            : codexUpdate
                              ? "Codex is up to date"
                              : "Codex update status"}
                  </strong>
                  <p>
                    {codexUpdateError
                      ?? (codexUpdate?.updateAvailable
                        ? `Installed ${codexUpdate.currentVersion} via ${codexUpdate.installationSource}. ${codexUpdate.canUpdate ? `Xiao will use ${codexUpdate.updateMethod}.` : "Use the original installer to update."}`
                        : codexUpdate
                          ? `${codexUpdate.currentVersion} is the latest published release.`
                          : "Xiao checks the official Codex npm release when the native app starts.")}
                  </p>
                  {codexUpdateResult ? <small>Updated {codexUpdateResult.previousVersion} to {codexUpdateResult.version}.</small> : null}
                </div>
                <div className="codex-update-card__actions">
                  <button className="button button--quiet" type="button" disabled={codexUpdateChecking || codexUpdating} onClick={onCheckCodexUpdate}>Check</button>
                  {codexUpdate?.updateAvailable && codexUpdate.canUpdate ? (
                    <button className="button button--primary" type="button" disabled={codexUpdating || runtime.phase === "working" || runtime.phase === "starting"} onClick={onUpdateCodex}>{codexUpdating ? "Updating" : "Update Codex"}</button>
                  ) : null}
                </div>
              </div>
              <div className="settings-note"><XiaoIcon name="target" size={16} /><p>Provider and server controls are intentionally absent: this build has one real local Codex runtime, so Xiao does not show configuration that it cannot apply.</p></div>
            </section>
          )}

          {activeSection === "shortcuts" && (
            <section className="settings-section" aria-labelledby="shortcuts-heading">
              <header><span>Keyboard</span><h2 id="shortcuts-heading">Shortcuts</h2><p>The commands currently wired into Xiao. Editable keymaps will appear only when the command layer supports remapping.</p></header>
              <div className="shortcut-list">
                {shortcuts.map((shortcut) => <div key={shortcut.action}><strong>{shortcut.action}</strong><span>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>)}
              </div>
            </section>
          )}

          {activeSection === "archived" && (
            <section className="settings-section" aria-labelledby="archived-tasks-heading">
              <header><span>Data</span><h2 id="archived-tasks-heading">Archived tasks</h2><p>Restore completed or paused work to its original project.</p></header>
              {archivedTasksLoading ? (
                <div className="archived-tasks-state" role="status"><XiaoIcon className="is-spinning" name="refresh" size={18} /><p>Loading archived tasks…</p></div>
              ) : archivedTasksError ? (
                <div className="archived-tasks-state" role="alert"><XiaoIcon name="archive" size={19} /><strong>Couldn’t load archived tasks</strong><p>{archivedTasksError}</p><button type="button" onClick={onReloadArchivedTasks}><XiaoIcon name="refresh" size={14} />Retry</button></div>
              ) : sortedArchivedTasks.length === 0 ? (
                <div className="archived-tasks-state"><XiaoIcon name="archive" size={19} /><strong>No archived tasks</strong><p>Tasks you archive will appear here.</p></div>
              ) : (
                <ul className="archived-task-list">
                  {sortedArchivedTasks.map((item) => <li key={`${item.projectPath}:${item.taskId}`}><div className="archived-task-list__copy"><h3>{item.title}</h3><p><span title={item.projectPath}>{item.projectName}</span><span aria-hidden="true">·</span><time dateTime={new Date(item.updatedAt).toISOString()}>{archivedTaskDate.format(item.updatedAt)}</time></p></div><button type="button" onClick={() => onRestoreArchivedTask(item)}>Restore</button></li>)}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
