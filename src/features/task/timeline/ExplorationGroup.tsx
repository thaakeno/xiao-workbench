import { useEffect, useMemo, useState } from "react";

import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type { AgentExplorationAction, TimelineEntry } from "../../../core/models/agent";

type ExplorationGroupProps = {
  entries: TimelineEntry[];
  index: number;
  startedAt: number | null;
};

type ProjectedAction = {
  action: AgentExplorationAction;
  entryId: string;
  status: TimelineEntry["status"];
  provider: string | null;
  operation: string | null;
};

const iconByAction: Record<AgentExplorationAction["kind"], XiaoIconName> = {
  command: "command",
  list: "folderOpen",
  read: "file",
  search: "search",
  web: "browser",
};

const actionLabel = (action: AgentExplorationAction) => {
  if (action.kind === "command") return "Ran";
  if (action.kind === "read") return "Read";
  if (action.kind === "search") return "Searched";
  if (action.kind === "web") return "Searched";
  return "Listed";
};

const elapsedLabel = (elapsedMs: number) => {
  const seconds = Math.max(1, Math.floor(elapsedMs / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const operationLabel = (operation: string, count: number) =>
  `${operation.charAt(0).toUpperCase()}${operation.slice(1)} ${count} ${count === 1 ? "time" : "times"}`;

export function ExplorationGroup({ entries, index, startedAt }: ExplorationGroupProps) {
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(Boolean(startedAt));
  const actions = useMemo<ProjectedAction[]>(() => entries.flatMap((entry) => {
    const plugin = entry.meta === "Plugin tool";
    const [provider, operation] = plugin ? entry.title.split(" · ", 2) : [null, null];
    const projected = entry.exploration?.length
      ? entry.exploration
      : entry.kind === "command"
        ? [{ kind: "command" as const, command: entry.command ?? entry.title, label: operation ?? entry.title }]
        : [];
    return projected.map((action) => ({ action, entryId: entry.id, status: entry.status, provider, operation }));
  }), [entries]);
  const active = startedAt != null || entries.some((entry) => entry.status === "active");
  const failed = entries.some((entry) => entry.status === "error");
  const firstEventAt = entries.find((entry) => entry.createdAt)?.createdAt ?? null;
  const lastEventAt = [...entries].reverse().find((entry) => entry.createdAt)?.createdAt ?? null;
  const recordedDuration = Math.max(0, ...entries.map((entry) => entry.durationMs ?? 0));
  const start = startedAt ?? firstEventAt ?? now;
  const inferredEnd = lastEventAt && lastEventAt > start ? lastEventAt : start + Math.max(1, actions.length) * 1_000;
  const elapsed = elapsedLabel(recordedDuration || Math.max(1_000, (active ? now : inferredEnd) - start));
  const toolProviders = useMemo(() => {
    const grouped = new Map<string, ProjectedAction[]>();
    actions.filter((item) => item.provider).forEach((item) => grouped.set(item.provider!, [...(grouped.get(item.provider!) ?? []), item]));
    return [...grouped];
  }, [actions]);
  const webActions = actions.filter(({ action, provider }) => !provider && action.kind === "web");
  const otherActions = actions.filter(({ action, provider }) => !provider && action.kind !== "web");
  const commentary = entries.filter((entry) => entry.kind === "result" && entry.messagePhase === "commentary" && entry.body?.trim());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    setOpen(active);
  }, [active]);

  const actionRow = ({ action, entryId, status }: ProjectedAction, actionIndex: number) => (
    <div className={`exploration-group__item is-${status ?? "idle"} is-${action.kind}`} key={`${entryId}-${actionIndex}-${action.command}`} title={action.command}>
      <span><XiaoIcon name={iconByAction[action.kind]} size={13} /></span>
      <div><strong>{actionLabel(action)}</strong><code>{action.kind === "search" || action.kind === "web" ? action.query || action.label : action.label}</code>{action.path && action.path !== action.label ? <small>{action.path}</small> : null}</div>
      {status === "active" ? <i className="activity__pulse" /> : null}
    </div>
  );

  return (
    <article className={`activity exploration-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""}`} style={{ "--activity-index": index } as React.CSSProperties}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary><strong>{active ? "Working for" : "Worked for"} {elapsed}</strong>{active ? <i className="activity__pulse" /> : null}<XiaoIcon className="exploration-group__caret" name="caret" size={12} /></summary>
        <div className="exploration-group__items">
          {toolProviders.map(([provider, providerActions]) => {
            const counts = new Map<string, number>();
            providerActions.forEach(({ operation }) => counts.set(operation ?? "use", (counts.get(operation ?? "use") ?? 0) + 1));
            return <details className="exploration-tool-group" key={provider} open={active}>
              <summary><XiaoIcon name="capability" size={15} /><strong>{provider}</strong><XiaoIcon name="caret" size={12} /></summary>
              <div>{[...counts].map(([operation, count]) => <span key={operation}>{operationLabel(operation, count)}</span>)}</div>
            </details>;
          })}
          {webActions.length ? <details className="exploration-tool-group is-web" open={active}>
            <summary><XiaoIcon name="browser" size={15} /><strong>Web search</strong><small>Searched {webActions.length} {webActions.length === 1 ? "time" : "times"}</small><XiaoIcon name="caret" size={12} /></summary>
            <div className="exploration-tool-group__queries">{webActions.map(actionRow)}</div>
          </details> : null}
          {otherActions.map(actionRow)}
          {commentary.map((message) => <div className="exploration-group__commentary markdown-body" key={message.id}>{message.body}</div>)}
        </div>
      </details>
    </article>
  );
}
