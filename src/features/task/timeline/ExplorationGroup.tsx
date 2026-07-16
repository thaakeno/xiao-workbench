import { XiaoIcon, type XiaoIconName } from "../../../components/icons/XiaoIcon";
import type { AgentExplorationAction, TimelineEntry } from "../../../core/models/agent";

type ExplorationGroupProps = {
  entries: TimelineEntry[];
  index: number;
  expandByDefault: boolean;
};

const iconByAction: Record<AgentExplorationAction["kind"], XiaoIconName> = {
  command: "command",
  list: "folderOpen",
  read: "file",
  search: "search",
  web: "browser",
};

const countLabel = (count: number, singular: string) =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const actionLabel = (action: AgentExplorationAction) => {
  if (action.kind === "command") return "Ran";
  if (action.kind === "read") return "Read";
  if (action.kind === "search") return "Searched";
  if (action.kind === "web") return "Searched web";
  return "Listed";
};

export function ExplorationGroup({ entries, index, expandByDefault }: ExplorationGroupProps) {
  const actions = entries.flatMap((entry) => {
    const projected = entry.exploration?.length
      ? entry.exploration
      : entry.kind === "command"
        ? [{ kind: "command" as const, command: entry.command ?? entry.title, label: entry.title }]
        : [];
    return projected.map((action) => ({
      action,
      entryId: entry.id,
      status: entry.status,
    }));
  });
  const reads = actions.filter(({ action }) => action.kind === "read").length;
  const searches = actions.filter(({ action }) => action.kind === "search").length;
  const lists = actions.filter(({ action }) => action.kind === "list").length;
  const commands = actions.filter(({ action }) => action.kind === "command").length;
  const web = actions.filter(({ action }) => action.kind === "web").length;
  const active = entries.some((entry) => entry.status === "active");
  const failed = entries.some((entry) => entry.status === "error");
  const counts = [
    reads ? countLabel(reads, "read") : null,
    searches ? countLabel(searches, "search") : null,
    lists ? countLabel(lists, "list") : null,
    commands ? countLabel(commands, "command") : null,
    web ? countLabel(web, "web search") : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <article
      className={`activity exploration-group ${active ? "is-active" : ""} ${failed ? "is-error" : ""}`}
      style={{ "--activity-index": index } as React.CSSProperties}
    >
      <details open={active || expandByDefault}>
        <summary>
          <span className="exploration-group__mark">
            <XiaoIcon name="search" size={13} />
          </span>
          <strong>{active ? "Working" : "Worked"}</strong>
          <span>{counts.join(", ") || countLabel(entries.length, "action")}</span>
          {active ? <i className="activity__pulse" /> : null}
          <XiaoIcon className="exploration-group__caret" name="caret" size={12} />
        </summary>
        <div className="exploration-group__items">
          {actions.map(({ action, entryId, status }, actionIndex) => (
            <div
              className={`exploration-group__item is-${status ?? "idle"}`}
              key={`${entryId}-${actionIndex}-${action.command}`}
              title={action.command}
            >
              <span><XiaoIcon name={iconByAction[action.kind]} size={13} /></span>
              <div>
                <strong>{actionLabel(action)}</strong>
                <code>{action.kind === "search" ? action.query || action.label : action.label}</code>
                {action.path && action.path !== action.label ? <small>{action.path}</small> : null}
              </div>
              {status === "active" ? <i className="activity__pulse" /> : null}
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}
