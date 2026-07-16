import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRateLimits, AgentThreadTokenUsage, CodexThreadSummary } from "../../../core/models/agent";

type UsageDetailsDialogProps = {
  rateLimits: AgentRateLimits | null;
  threads: CodexThreadSummary[];
  usage: AgentThreadTokenUsage[];
  onClose: () => void;
};

type Range = 1 | 7 | 30 | 90 | "all";
type Price = {
  input: number;
  cached: number;
  output: number;
};

// Standard USD rates per million tokens. Rollouts do not expose enough request-level
// context to apply long-context surcharges without risking an inflated estimate.
const prices: Record<string, Price> = {
  "gpt-5.6-sol": { input: 5, cached: .5, output: 30 },
  "gpt-5.5": { input: 5, cached: .5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: .25, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: .1, output: 6 },
  "gpt-5.4": { input: 2.5, cached: .25, output: 15 },
  "gpt-5.4-mini": { input: .75, cached: .075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cached: .175, output: 14 },
};

const number = new Intl.NumberFormat(undefined);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const resetTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const remainingPercent = (used: number) => Math.max(0, Math.min(100, Number((100 - used).toFixed(1))));
const estimateCost = (row: AgentThreadTokenUsage) => {
  const basePrice = row.model ? prices[row.model.toLocaleLowerCase()] : undefined;
  if (!basePrice) return null;
  const uncached = Math.max(0, row.inputTokens - row.cachedInputTokens);
  return (uncached * basePrice.input + row.cachedInputTokens * basePrice.cached + row.outputTokens * basePrice.output) / 1_000_000;
};

export function UsageDetailsDialog({ rateLimits, threads, usage, onClose }: UsageDetailsDialogProps) {
  const [range, setRange] = useState<Range>("all");
  const [scope, setScope] = useState<"global" | "app">("global");
  const rows = useMemo(() => {
    const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
    const cutoff = range === "all" ? 0 : Date.now() - range * 86_400_000;
    return usage
      .filter((item) => item.updatedAt * 1_000 >= cutoff && (scope === "global" || item.originator?.toLocaleLowerCase().includes("xiao")))
      .map((item) => {
        const thread = threadMap.get(item.threadId);
        return {
          ...item,
          title: thread?.title ?? "Codex task",
          project: thread?.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Unknown project",
          estimatedCost: estimateCost(item),
        };
      })
      .sort((left, right) => right.totalTokens - left.totalTokens);
  }, [range, scope, threads, usage]);

  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const input = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const output = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const cached = rows.reduce((sum, row) => sum + row.cachedInputTokens, 0);
  const costRows = rows.filter((row) => row.estimatedCost != null);
  const cost = costRows.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0);
  const pricedTokens = costRows.reduce((sum, row) => sum + row.totalTokens, 0);
  const activeDays = new Set(rows.map((row) => new Date(row.updatedAt * 1_000).toLocaleDateString())).size;
  const largest = Math.max(1, ...rows.map((row) => row.totalTokens));

  const modelRows = useMemo(() => {
    const models = new Map<string, { tokens: number; input: number; cached: number; output: number; cost: number | null }>();
    for (const row of rows) {
      const model = row.model ?? "Unknown model";
      const current = models.get(model) ?? { tokens: 0, input: 0, cached: 0, output: 0, cost: 0 };
      current.tokens += row.totalTokens;
      current.input += row.inputTokens;
      current.cached += row.cachedInputTokens;
      current.output += row.outputTokens;
      current.cost = row.estimatedCost == null || current.cost == null ? null : current.cost + row.estimatedCost;
      models.set(model, current);
    }
    return [...models].sort((left, right) => right[1].tokens - left[1].tokens);
  }, [rows]);

  const dailyRows = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of rows) for (const bucket of row.dailyUsageBuckets ?? []) {
      totals.set(bucket.startDate, (totals.get(bucket.startDate) ?? 0) + bucket.tokens);
    }
    const days = range === "all" ? 90 : Math.max(7, range);
    return Array.from({ length: days }, (_, offset) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (days - offset - 1));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return { key, label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tokens: totals.get(key) ?? 0 };
    });
  }, [range, rows]);
  const peakDay = Math.max(1, ...dailyRows.map((day) => day.tokens));
  const windows = [
    rateLimits?.primary ? { label: "Session", value: rateLimits.primary } : null,
    rateLimits?.secondary ? { label: "Weekly", value: rateLimits.secondary } : null,
  ].filter((item): item is NonNullable<typeof item> => item != null);

  return createPortal(
    <div className="usage-dialog__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="usage-dialog usage-dialog--dashboard" role="dialog" aria-modal="true" aria-labelledby="usage-dialog-title">
        <header className="usage-dialog__header">
          <div className="usage-dialog__title"><i><XiaoIcon name="runtime" size={22} /></i><div><span>Local Codex analytics</span><h2 id="usage-dialog-title">Usage</h2><p>Live limits, cumulative processed tokens, model mix, and a standard-rate estimate.</p></div></div>
          <button type="button" aria-label="Close usage details" onClick={onClose}><XiaoIcon name="close" size={16} /></button>
        </header>
        <div className="usage-dialog__body">
          <nav className="usage-dialog__filters" aria-label="Usage period">
            <button className={scope === "global" ? "is-active" : ""} onClick={() => setScope("global")}>Global</button>
            <button className={scope === "app" ? "is-active" : ""} onClick={() => setScope("app")}>App</button>
            {([1, 7, 30, 90, "all"] as Range[]).map((value) => <button className={range === value ? "is-active" : ""} key={value} onClick={() => setRange(value)}>{value === "all" ? "All" : `${value}d`}</button>)}
            <small>Sessions last active in this period</small>
          </nav>

          <section className="usage-dialog__overview">
            <div className="usage-dialog__headline"><span>Standard-rate estimate</span><strong>{money.format(cost)}</strong><small>{pricedTokens === total ? "100% mapped to a published standard rate" : `${Math.round(pricedTokens / Math.max(1, total) * 100)}% mapped to a published rate`}</small></div>
            <div className="usage-dialog__token-total"><span>Cumulative tokens</span><strong>{compact.format(total)}</strong><small>{compact.format(input)} input <b>·</b> {compact.format(output)} output</small></div>
            <dl className="usage-dialog__quick-stats">
              <div><dt>Sessions</dt><dd>{number.format(rows.length)}</dd></div><div><dt>Active days</dt><dd>{number.format(activeDays)}</dd></div><div><dt>Cache share</dt><dd>{input ? Math.round(cached / input * 100) : 0}%</dd></div><div><dt>Average</dt><dd>{compact.format(rows.length ? total / rows.length : 0)}</dd></div>
            </dl>
            <div className="usage-dialog__quota-stack">
              {windows.map(({ label, value }) => { const remaining = remainingPercent(value.usedPercent); const urgency = remaining < 10 ? "is-critical" : remaining < 30 ? "is-warning" : ""; return <article className={urgency} key={label}><header><span>{label}</span><strong>{remaining}%</strong></header><i><b style={{ width: `${remaining}%` }} /></i><small>{value.resetsAt ? `Resets ${resetTime.format(value.resetsAt * 1_000)}` : "Reset unavailable"}</small></article>; })}
            </div>
          </section>

          <section className="usage-dialog__activity">
            <header><div><span>Activity</span><h3>Daily recorded tokens</h3></div><small><b>{compact.format(peakDay)}</b> peak day</small></header>
            <div className="usage-dialog__heatmap">{dailyRows.map((day) => <button type="button" key={day.key} aria-label={`${day.label}: ${number.format(day.tokens)} tokens`} data-tooltip={`${day.label} · ${number.format(day.tokens)} tokens`} style={{ "--usage-level": day.tokens ? Math.max(.12, day.tokens / peakDay) : 0 } as React.CSSProperties} />)}</div>
            <div className="usage-dialog__trend">{dailyRows.slice(-30).map((day, index) => <button type="button" key={day.key} aria-label={`${day.label}: ${number.format(day.tokens)} tokens`} data-tooltip={`${day.label} · ${number.format(day.tokens)} tokens`}><i><b style={{ height: `${Math.max(day.tokens ? 3 : 1, day.tokens / peakDay * 100)}%` }} /></i>{index % 7 === 0 || index === 29 ? <small>{day.label}</small> : null}</button>)}</div>
          </section>

          <section className="usage-dialog__ranking"><header><div><span>Conversation ranking</span><h3>Most tokens used</h3></div><small>{rows.length} recorded sessions</small></header>{rows.length ? <div className="usage-dialog__rows">{rows.slice(0, 100).map((row, index) => <article key={row.threadId}><span className="usage-dialog__rank">{index + 1}</span><div className="usage-dialog__conversation"><strong title={row.title}>{row.title}</strong><small>{row.project} · {row.model ?? "model unavailable"}</small><i><b style={{ width: `${Math.max(1, row.totalTokens / largest * 100)}%` }} /></i></div><div className="usage-dialog__tokens"><strong>{compact.format(row.totalTokens)}</strong><small>{row.estimatedCost == null ? "Cost unavailable" : money.format(row.estimatedCost)}</small></div></article>)}</div> : <div className="usage-dialog__empty"><XiaoIcon name="runtime" size={22} /><strong>No token records in this period</strong><p>Some older Codex sessions did not persist token-count events.</p></div>}</section>
          <section className="usage-dialog__models"><header><span>By model</span><h3>Token and cost mix</h3></header><div>{modelRows.map(([model, value]) => <article key={model}><strong>{model}</strong><span>{compact.format(value.input)} in</span><span>{compact.format(value.output)} out</span><span>{compact.format(value.cached)} cached</span><b>{value.cost == null ? "—" : money.format(value.cost)}</b></article>)}</div></section>
        </div>
        <footer><span>Tokens are exact cumulative rollout counters. Cost applies current standard rates, without unverifiable long-context tiers or historical price changes; it is not your subscription bill.</span>{rateLimits?.updatedAt ? <span>Quota updated {new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(rateLimits.updatedAt)}</span> : null}</footer>
      </section>
    </div>,
    document.body,
  );
}
