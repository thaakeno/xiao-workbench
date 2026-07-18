import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { AgentRuntimeState } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";

type Skill = { name: string; description: string; path: string; enabled: boolean };
type Plugin = {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  availability?: "AVAILABLE" | "DISABLED_BY_ADMIN";
  installPolicy?: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  interface?: { displayName: string | null; shortDescription: string | null } | null;
  marketplaceName: string;
  marketplacePath: string | null;
};
type App = { id: string; name: string; description: string | null; isAccessible: boolean; isEnabled: boolean };
type McpServer = {
  name: string;
  displayName: string;
  toolCount: number;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
};
type McpServerResponse = Omit<McpServer, "displayName" | "toolCount"> & {
  serverInfo: { title?: string | null } | null;
  tools: Record<string, unknown>;
};
type CapabilitySource = "apps" | "mcp" | "plugins" | "skills";
type CapabilityIssue = { message: string; tone: "error" | "notice" };
type CapabilitySnapshot = { skills: Skill[]; plugins: Plugin[]; apps: App[]; mcpServers: McpServer[] };

type ExtensionsPanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  runtime: AgentRuntimeState;
};

const conciseError = (reason: unknown) => {
  const value = reason instanceof Error ? reason.message : String(reason);
  const withoutHtml = value.replace(/<!doctype html[\s\S]*/i, "").replace(/<html[\s\S]*/i, "").trim();
  return (withoutHtml || "Capability source is temporarily unavailable.").replace(/\s+/g, " ").slice(0, 180);
};

const sourceIssue = (source: CapabilitySource, reason: unknown): CapabilityIssue => {
  if (source === "apps") {
    return {
      message: "Apps are temporarily unavailable from ChatGPT. Skills, plugins, and MCP servers still work.",
      tone: "notice",
    };
  }
  const label = source === "mcp" ? "MCP servers" : `${source[0].toUpperCase()}${source.slice(1)}`;
  return { message: `${label} could not be loaded. ${conciseError(reason)}`, tone: "error" };
};

const isAccessDenied = (reason: unknown) => /\b(?:401|403)\b|forbidden|unauthorized/i.test(conciseError(reason));

const mcpDescription = (server: McpServer) => {
  const tools = `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`;
  if (server.authStatus === "notLoggedIn") return `${tools} · Sign-in required`;
  if (server.authStatus === "oAuth") return `${tools} · OAuth connected`;
  if (server.authStatus === "bearerToken") return `${tools} · Token connected`;
  return tools;
};

const pluginAction = (plugin: Plugin) => {
  if (plugin.installed) return "Uninstall";
  if (plugin.availability === "DISABLED_BY_ADMIN" || plugin.installPolicy === "NOT_AVAILABLE") return undefined;
  return "Install";
};

const capabilityCacheKey = (path: string) => `xiao.capabilities.v2:${path.toLocaleLowerCase()}`;
const readCapabilitySnapshot = (path: string): CapabilitySnapshot => {
  try {
    const value = JSON.parse(localStorage.getItem(capabilityCacheKey(path)) ?? "null") as Partial<CapabilitySnapshot> | null;
    return {
      skills: Array.isArray(value?.skills) ? value.skills : [],
      plugins: Array.isArray(value?.plugins) ? value.plugins : [],
      apps: Array.isArray(value?.apps) ? value.apps : [],
      mcpServers: Array.isArray(value?.mcpServers) ? value.mcpServers : [],
    };
  } catch {
    return { skills: [], plugins: [], apps: [], mcpServers: [] };
  }
};
const decodeBase64 = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
const encodeBase64 = (value: string) => {
  let binary = "";
  new TextEncoder().encode(value).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};
const withTimeout = <T,>(promise: Promise<T>, milliseconds: number, label: string) => Promise.race([
  promise,
  new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(`${label} timed out; cached data is still shown.`)), milliseconds)),
]);

const highlightMarkdownLine = (line: string, index: number) => {
  if (/^#{1,6}\s/.test(line)) return <span className="syntax-heading" key={index}>{line}</span>;
  if (/^\s*[-*+]\s/.test(line)) return <span className="syntax-list" key={index}>{line}</span>;
  if (/^---+$/.test(line.trim())) return <span className="syntax-rule" key={index}>{line}</span>;
  const fragments = line.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\)]+\)|\$\{[^}]+\})/g);
  return <span key={index}>{fragments.map((fragment, part) => {
    const className = fragment.startsWith("`") ? "syntax-code" : fragment.startsWith("**") ? "syntax-strong" : fragment.startsWith("[") ? "syntax-link" : fragment.startsWith("${") ? "syntax-variable" : undefined;
    return <i className={className} key={part}>{fragment}</i>;
  })}</span>;
};

export function ExtensionsPanel({ workspace, taskId, runtime }: ExtensionsPanelProps) {
  const runtimeAvailable = runtime.phase === "ready" || runtime.phase === "working";
  const initialSnapshot = useMemo(() => readCapabilitySnapshot(workspace.path), [workspace.path]);
  const [skills, setSkills] = useState<Skill[]>(initialSnapshot.skills);
  const [plugins, setPlugins] = useState<Plugin[]>(initialSnapshot.plugins);
  const [apps, setApps] = useState<App[]>(initialSnapshot.apps);
  const [mcpServers, setMcpServers] = useState<McpServer[]>(initialSnapshot.mcpServers);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Partial<Record<CapabilitySource, CapabilityIssue>>>({});
  const refreshEpoch = useRef(0);
  const appAccessBlocked = useRef(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [skillSource, setSkillSource] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);

  useEffect(() => {
    const snapshot = readCapabilitySnapshot(workspace.path);
    setSkills(snapshot.skills); setPlugins(snapshot.plugins); setApps(snapshot.apps); setMcpServers(snapshot.mcpServers);
  }, [workspace.path]);

  useEffect(() => {
    localStorage.setItem(capabilityCacheKey(workspace.path), JSON.stringify({ skills, plugins, apps, mcpServers }));
  }, [apps, mcpServers, plugins, skills, workspace.path]);

  const refresh = useCallback(async (force = false) => {
    const requestId = ++refreshEpoch.current;
    if (!runtimeAvailable || !taskId) {
      appAccessBlocked.current = false;
      setLoading(false);
      return;
    }
    setLoading(!skills.length && !plugins.length && !apps.length && !mcpServers.length);
    setError(null);
    try {
      const appRequest = appAccessBlocked.current && !force
        ? Promise.resolve(null)
        : nativeBridge.agentRequest<{ data: App[] }>(
            "app/list",
            { forceRefetch: force, limit: 100 },
            { projectPath: workspace.path, taskId },
          );
      const [skillResult, pluginResult, mcpResult, appResult] = await Promise.allSettled([
        nativeBridge.agentRequest<{ data: Array<{ skills: Skill[] }> }>(
          "skills/list",
          { cwds: [workspace.path], forceReload: force },
          { projectPath: workspace.path, taskId },
        ),
        nativeBridge.agentRequest<{
          marketplaces: Array<{ name: string; path: string | null; plugins: Omit<Plugin, "marketplaceName" | "marketplacePath">[] }>;
          marketplaceLoadErrors?: Array<{ message: string }>;
        }>(
          "plugin/list",
          { cwds: [workspace.path] },
          { projectPath: workspace.path, taskId },
        ),
        withTimeout(nativeBridge.agentRequest<{ data: McpServerResponse[] }>(
          "mcpServerStatus/list",
          { detail: "toolsAndAuthOnly", limit: 100 },
          { projectPath: workspace.path, taskId },
        ), 2_500, "MCP status"),
        appRequest,
      ]);
      if (requestId !== refreshEpoch.current) return;

      const nextIssues: Partial<Record<CapabilitySource, CapabilityIssue>> = {};
      if (skillResult.status === "fulfilled") {
        setSkills(skillResult.value.data.flatMap((entry) => entry.skills));
      } else {
        nextIssues.skills = sourceIssue("skills", skillResult.reason);
      }
      if (pluginResult.status === "fulfilled") {
        setPlugins(
          pluginResult.value.marketplaces.flatMap((marketplace) =>
            marketplace.plugins.map((plugin) => ({
              ...plugin,
              marketplaceName: marketplace.name,
              marketplacePath: marketplace.path,
            })),
          ),
        );
        if (pluginResult.value.marketplaceLoadErrors?.length) {
          nextIssues.plugins = {
            message: `${pluginResult.value.marketplaceLoadErrors.length} plugin marketplace ${pluginResult.value.marketplaceLoadErrors.length === 1 ? "error was" : "errors were"} skipped.`,
            tone: "notice",
          };
        }
      } else {
        nextIssues.plugins = sourceIssue("plugins", pluginResult.reason);
      }
      if (mcpResult.status === "fulfilled") {
        setMcpServers(mcpResult.value.data.map((server) => ({
          name: server.name,
          displayName: server.serverInfo?.title || server.name,
          toolCount: Object.keys(server.tools ?? {}).length,
          authStatus: server.authStatus,
        })));
      } else {
        nextIssues.mcp = sourceIssue("mcp", mcpResult.reason);
      }
      if (appResult.status === "fulfilled" && appResult.value) {
        appAccessBlocked.current = false;
        setApps(appResult.value.data);
      } else if (appResult.status === "rejected") {
        appAccessBlocked.current = isAccessDenied(appResult.reason);
        nextIssues.apps = sourceIssue("apps", appResult.reason);
      } else {
        nextIssues.apps = sourceIssue("apps", null);
      }
      setIssues(nextIssues);
    } catch (reason) {
      if (requestId === refreshEpoch.current) setError(conciseError(reason));
    } finally {
      if (requestId === refreshEpoch.current) setLoading(false);
    }
  }, [apps.length, mcpServers.length, plugins.length, runtimeAvailable, skills.length, taskId, workspace.execution.executionRoot, workspace.path]);

  useEffect(() => {
    void refresh();
    return () => { refreshEpoch.current += 1; };
  }, [refresh]);

  const updateSkill = async (skill: Skill) => {
    setBusy(`skill:${skill.path}`);
    try {
      if (!taskId) throw new Error("Open a persisted task before changing skills.");
      await nativeBridge.agentRequest(
        "skills/config/write",
        { path: skill.path, enabled: !skill.enabled },
        { projectPath: workspace.path, taskId },
      );
      await refresh();
    } catch (reason) {
      setError(conciseError(reason));
    } finally {
      setBusy(null);
    }
  };

  const updatePlugin = async (plugin: Plugin) => {
    setBusy(`plugin:${plugin.id}`);
    try {
      if (!taskId) throw new Error("Open a persisted task before changing plugins.");
      if (plugin.installed) {
        await nativeBridge.agentRequest(
          "plugin/uninstall",
          { pluginId: plugin.id },
          { projectPath: workspace.path, taskId },
        );
      } else {
        await nativeBridge.agentRequest(
          "plugin/install",
          {
            pluginName: plugin.name,
            marketplacePath: plugin.marketplacePath,
            remoteMarketplaceName: plugin.marketplacePath ? null : plugin.marketplaceName,
          },
          { projectPath: workspace.path, taskId },
        );
      }
      await refresh();
    } catch (reason) {
      setError(conciseError(reason));
    } finally {
      setBusy(null);
    }
  };

  const openSkillEditor = async (skill: Skill) => {
    if (!taskId) return;
    setEditingSkill(skill);
    setSkillSource("");
    setEditorBusy(true);
    setError(null);
    try {
      const response = await nativeBridge.agentRequest<{ dataBase64: string }>(
        "fs/readFile",
        { path: skill.path },
        { projectPath: workspace.path, taskId },
      );
      setSkillSource(decodeBase64(response.dataBase64));
    } catch (reason) {
      setError(conciseError(reason));
      setEditingSkill(null);
    } finally {
      setEditorBusy(false);
    }
  };

  const saveSkill = async () => {
    if (!editingSkill || !taskId) return;
    setEditorBusy(true);
    try {
      await nativeBridge.agentRequest(
        "fs/writeFile",
        { path: editingSkill.path, dataBase64: encodeBase64(skillSource) },
        { projectPath: workspace.path, taskId },
      );
      setEditingSkill(null);
      await refresh(true);
    } catch (reason) {
      setError(conciseError(reason));
    } finally {
      setEditorBusy(false);
    }
  };

  const normalized = query.trim().toLowerCase();
  const filter = <T extends { name: string }>(items: T[]) =>
    normalized ? items.filter((item) => item.name.toLowerCase().includes(normalized)) : items;
  const visible = useMemo(
    () => ({ skills: filter(skills), plugins: filter(plugins), mcp: filter(mcpServers), apps: filter(apps) }),
    [apps, mcpServers, normalized, plugins, skills],
  );

  return (
    <section className="rail-section extensions-panel">
      <header className="rail-section__header">
        <div><span>Capabilities</span><h2>Skills, plugins, MCP, and apps</h2></div>
        <button className="icon-button" type="button" disabled={loading} onClick={() => void refresh(true)} aria-label="Refresh capabilities">
          <XiaoIcon className={loading ? "spin" : undefined} name="refresh" size={17} />
        </button>
      </header>
      <label className="rail-search">
        <XiaoIcon name="search" size={15} />
        <input type="search" value={query} aria-label="Filter capabilities" placeholder="Filter capabilities" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {error && <p className="rail-error">{error}</p>}
      {loading ? <div className="file-skeleton"><span /><span /><span /></div> : (
        <>
          <CapabilityGroup title={`Skills (${visible.skills.length})`} empty="No skills found." issue={issues.skills}>
            {visible.skills.map((skill) => (
              <CapabilityRow key={skill.path} name={skill.name} description={skill.description} active={skill.enabled}
                busy={busy === `skill:${skill.path}`} action={skill.enabled ? "Disable" : "Enable"}
                onAction={() => void updateSkill(skill)} secondaryAction="Edit"
                onSecondaryAction={() => void openSkillEditor(skill)} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`Plugins (${visible.plugins.length})`} empty="No plugins found." issue={issues.plugins}>
            {visible.plugins.map((plugin) => (
              <CapabilityRow key={`${plugin.marketplaceName}:${plugin.id}`} name={plugin.interface?.displayName || plugin.name}
                description={plugin.availability === "DISABLED_BY_ADMIN" ? "Disabled by administrator" : plugin.interface?.shortDescription ?? plugin.marketplaceName}
                active={plugin.installed && plugin.enabled}
                busy={busy === `plugin:${plugin.id}`} action={pluginAction(plugin)}
                onAction={() => void updatePlugin(plugin)} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`MCP servers (${visible.mcp.length})`} empty="No MCP servers configured." issue={issues.mcp}>
            {visible.mcp.map((server) => (
              <CapabilityRow key={server.name} name={server.displayName}
                description={mcpDescription(server)} active={server.authStatus !== "notLoggedIn"} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`Apps (${visible.apps.length})`} empty="No apps available." issue={issues.apps}>
            {visible.apps.map((app) => (
              <CapabilityRow key={app.id} name={app.name} description={app.description ?? "Connected app"}
                active={app.isAccessible && app.isEnabled} />
            ))}
          </CapabilityGroup>
        </>
      )}
      {editingSkill ? (
        <div className="skill-editor-backdrop" role="presentation" onPointerDown={(event) => {
          if (event.currentTarget === event.target && !editorBusy) setEditingSkill(null);
        }}>
          <section className="skill-editor" role="dialog" aria-modal="true" aria-label={`Edit ${editingSkill.name}`}>
            <header>
              <div><span>Skill instructions</span><strong>{editingSkill.name}</strong><small>{editingSkill.path}</small></div>
              <button className="icon-button" type="button" disabled={editorBusy} onClick={() => setEditingSkill(null)} aria-label="Close editor"><XiaoIcon name="close" size={16} /></button>
            </header>
            <div className="skill-editor__surface">
              <div className="skill-editor__gutter" aria-hidden="true">{skillSource.split("\n").map((_, index) => <span key={index}>{index + 1}</span>)}</div>
              <div className="skill-editor__code"><pre aria-hidden="true">{skillSource.split("\n").map(highlightMarkdownLine)}</pre><textarea aria-label="Skill Markdown instructions" spellCheck={false} value={skillSource} disabled={editorBusy && !skillSource} onChange={(event) => setSkillSource(event.target.value)} /></div>
            </div>
            <footer><small>Markdown · saved directly to your local Codex skill</small><button className="button button--quiet" type="button" disabled={editorBusy} onClick={() => setEditingSkill(null)}>Cancel</button><button className="button" type="button" disabled={editorBusy || !skillSource.trim()} onClick={() => void saveSkill()}>{editorBusy ? "Saving…" : "Save skill"}</button></footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CapabilityGroup({ title, children, empty, issue }: {
  title: string;
  children: ReactNode;
  empty: string;
  issue?: CapabilityIssue;
}) {
  const hasChildren = Boolean(Children.count(children));
  return (
    <div className="capability-group">
      <h3>{title}</h3>
      <div>
        {issue && hasChildren ? (
          <p className={`capability-state ${issue.tone === "error" ? "is-error" : ""}`} role={issue.tone === "error" ? "alert" : "status"}>
            {issue.message}
          </p>
        ) : null}
        {hasChildren ? children : (
          <p className={`capability-state ${issue?.tone === "error" ? "is-error" : ""}`} role={issue?.tone === "error" ? "alert" : "status"}>
            {issue?.message ?? empty}
          </p>
        )}
      </div>
    </div>
  );
}

function CapabilityRow({ name, description, active, busy, action, onAction, secondaryAction, onSecondaryAction }: {
  name: string; description: string; active: boolean; busy?: boolean; action?: string; onAction?: () => void; secondaryAction?: string; onSecondaryAction?: () => void;
}) {
  return (
    <article className="capability-row">
      <span className={active ? "is-active" : ""}><XiaoIcon name="capability" size={15} /></span>
      <div><strong>{name}</strong><small>{description}</small></div>
      {secondaryAction && <button className="button button--quiet" type="button" onClick={onSecondaryAction}>{secondaryAction}</button>}
      {action && <button className="button button--quiet" type="button" disabled={busy} onClick={onAction}>{busy ? "…" : action}</button>}
    </article>
  );
}
