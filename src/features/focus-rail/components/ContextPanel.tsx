import { useEffect, useMemo, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  contextUsedPercent,
  normalizeThreadTokenUsage,
  type AgentModelSummary,
  type ThreadTokenUsage,
  type TimelineEntry,
} from "../../../core/models/agent";

type ContextPanelProps = {
  taskTitle: string;
  taskCreatedAt: number;
  timeline: TimelineEntry[];
  threadId: string | null;
  models: AgentModelSummary[];
  selectedModel: string | null;
  usage: ThreadTokenUsage | null;
};

type MessageKind = "all" | "assistant" | "tools" | "user";

const pageSize = 18;
const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const messageKind = (entry: TimelineEntry): Exclude<MessageKind, "all"> => {
  if (entry.kind === "user" || entry.kind === "brief") return "user";
  if (
    entry.kind === "command" ||
    entry.kind === "explore" ||
    entry.kind === "change" ||
    entry.kind === "approval"
  ) return "tools";
  return "assistant";
};

const messageLabel = (kind: Exclude<MessageKind, "all">) => {
  if (kind === "user") return "User";
  if (kind === "tools") return "Tool";
  return "Assistant";
};

export function ContextPanel({
  taskTitle,
  taskCreatedAt,
  timeline,
  threadId,
  models,
  selectedModel,
  usage,
}: ContextPanelProps) {
  const [filter, setFilter] = useState<MessageKind>("all");
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const defaultModel = models.find((model) => model.isDefault);
  const model = (selectedModel ? models.find((item) => item.model === selectedModel) : defaultModel) ?? defaultModel;
  const normalizedUsage = normalizeThreadTokenUsage(usage, model?.contextWindow);
  const contextLimit = normalizedUsage?.modelContextWindow ?? model?.contextWindow ?? null;
  const contextUsage = contextUsedPercent(normalizedUsage, model?.contextWindow);
  const filtered = useMemo(
    () => timeline.filter((entry) => filter === "all" || messageKind(entry) === filter),
    [filter, timeline],
  );
  const visible = filtered.slice(-visibleCount);
  const counts = useMemo(
    () => ({
      user: timeline.filter((entry) => messageKind(entry) === "user").length,
      assistant: timeline.filter((entry) => messageKind(entry) === "assistant").length,
      tools: timeline.filter((entry) => messageKind(entry) === "tools").length,
    }),
    [timeline],
  );
  const lastActivity = [...timeline].reverse().find((entry) => entry.createdAt)?.createdAt ?? taskCreatedAt;

  useEffect(() => setVisibleCount(pageSize), [filter, taskTitle]);

  const sessionUsage = normalizedUsage?.total ?? null;
  const activeUsage = normalizedUsage?.last ?? null;
  const total = activeUsage?.totalTokens ?? 0;
  const cached = Math.min(total, activeUsage?.cachedInputTokens ?? 0);
  const input = Math.min(Math.max(0, total - cached), Math.max(0, (activeUsage?.inputTokens ?? 0) - cached));
  const reasoning = Math.min(Math.max(0, total - cached - input), activeUsage?.reasoningOutputTokens ?? 0);
  const output = Math.min(
    Math.max(0, total - cached - input - reasoning),
    Math.max(0, (activeUsage?.outputTokens ?? 0) - reasoning),
  );
  const other = Math.max(0, total - cached - input - reasoning - output);
  const segments = [
    { id: "input", label: "Input", value: input },
    { id: "cache", label: "Cache", value: cached },
    { id: "output", label: "Output", value: output },
    { id: "reasoning", label: "Reasoning", value: reasoning },
    { id: "other", label: "Other", value: other },
  ];

  return (
    <section className="context-panel">
      <header className="context-panel__hero">
        <div>
          <span>Session context</span>
          <h2>{taskTitle}</h2>
          <p>Live context from this Xiao task, not account-wide usage.</p>
        </div>
        <div
          className="context-panel__meter"
          style={{ "--context-progress": `${contextUsage ?? 0}%` } as React.CSSProperties}
          aria-label={contextUsage === null ? "Context limit unavailable" : `${contextUsage}% context used`}
          title={normalizedUsage ? `${number.format(normalizedUsage.last.totalTokens)} tokens in the active context` : undefined}
        >
          <strong>{contextUsage === null ? "--" : `${contextUsage}%`}</strong>
          <small>used</small>
        </div>
      </header>

      <div className="context-facts">
        <div><span>Messages</span><strong>{number.format(timeline.length)}</strong></div>
        <div><span>Model</span><strong>{model?.displayName ?? selectedModel ?? "Default"}</strong></div>
        <div><span>Session tokens</span><strong>{sessionUsage ? number.format(sessionUsage.totalTokens) : "Not reported"}</strong></div>
        <div><span>Context limit</span><strong>{contextLimit ? number.format(contextLimit) : "Not reported"}</strong></div>
        <div><span>Thread</span><strong>{threadId ? threadId.slice(0, 12) : "Not started"}</strong></div>
        <div><span>Last activity</span><strong>{time.format(lastActivity)}</strong></div>
      </div>

      <section className="context-breakdown" aria-labelledby="context-breakdown-title">
        <header>
          <div><span>Composition</span><h3 id="context-breakdown-title">Token flow</h3></div>
          <strong>{activeUsage ? number.format(total) : "--"}</strong>
        </header>
        {activeUsage ? (
          <>
            <div className="context-breakdown__bar" aria-hidden="true">
              {segments.filter((segment) => segment.value > 0).map((segment) => (
                <i
                  className={`is-${segment.id}`}
                  key={segment.id}
                  style={{ width: `${(segment.value / Math.max(1, total)) * 100}%` }}
                />
              ))}
            </div>
            <div className="context-breakdown__legend">
              {segments.map((segment) => (
                <span className={`is-${segment.id}`} key={segment.id}>
                  <i />{segment.label} <b>{Math.round((segment.value / Math.max(1, total)) * 100)}%</b>
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="context-breakdown__empty">Live token composition appears after Codex reports the first turn update.</p>
        )}
      </section>

      <section className="context-messages" aria-labelledby="context-messages-title">
        <header>
          <div>
            <span>Event index</span>
            <h3 id="context-messages-title">Raw messages</h3>
          </div>
          <div className="context-message-filters" aria-label="Filter raw messages">
            {(["all", "user", "assistant", "tools"] as MessageKind[]).map((kind) => (
              <button
                className={filter === kind ? "is-active" : undefined}
                key={kind}
                type="button"
                onClick={() => setFilter(kind)}
              >
                {kind === "all" ? "All" : messageLabel(kind)}
                <small>{kind === "all" ? timeline.length : counts[kind]}</small>
              </button>
            ))}
          </div>
        </header>

        {visible.length > 0 ? (
          <div className="context-message-list">
            {visible.map((entry) => {
              const kind = messageKind(entry);
              const details = entry.body ?? entry.command;
              return (
                <details key={entry.id}>
                  <summary>
                    <span className={`context-message-list__role is-${kind}`}>{messageLabel(kind)}</span>
                    <code title={entry.id}>{entry.id}</code>
                    <time>{entry.createdAt ? time.format(entry.createdAt) : "Saved event"}</time>
                    <XiaoIcon name="caret" size={12} />
                  </summary>
                  <div>
                    <strong>{entry.title}</strong>
                    {details && <pre>{details}</pre>}
                    {entry.files?.length ? (
                      <ul>{entry.files.map((file) => <li key={file.path}>{file.path} <b>+{file.additions}</b> <em>-{file.deletions}</em></li>)}</ul>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="rail-empty rail-empty--compact">
            <XiaoIcon name="result" size={22} />
            <strong>No {filter === "all" ? "session" : filter} messages</strong>
            <p>Events appear here as Xiao works.</p>
          </div>
        )}

        {filtered.length > visibleCount && (
          <button className="context-messages__more" type="button" onClick={() => setVisibleCount((count) => count + pageSize)}>
            Show {Math.min(pageSize, filtered.length - visibleCount)} more
            <small>{filtered.length - visibleCount} remaining</small>
          </button>
        )}
        {visibleCount > pageSize && (
          <button className="context-messages__collapse" type="button" onClick={() => setVisibleCount(pageSize)}>
            Collapse to latest batch
          </button>
        )}
      </section>
    </section>
  );
}
