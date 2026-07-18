import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentRateLimitWindow,
  AgentRateLimits,
  AgentThreadTokenUsage,
  CodexThreadSummary,
} from "../../../core/models/agent";

type UsageDetailsDialogProps = {
  rateLimits: AgentRateLimits | null;
  threads: CodexThreadSummary[];
  usage: AgentThreadTokenUsage[];
  onClose: () => void;
};

type Range = 1 | 7 | 30 | 90 | "all";
type Price = { input: number; cached: number; output: number };
type QuotaObservation = {
  at: number;
  sessionUsed: number | null;
  weeklyUsed: number | null;
  credits: number | null;
  event?: string;
};

// Published standard USD rates per million tokens. Request-level long-context
// surcharges cannot be reconstructed from cumulative rollout counters.
const prices: Record<string, Price> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, output: 6 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
};

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const resetTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const quotaHistoryKey = "xiao.quota-observations.v1";
const remainingPercent = (used: number) => Math.max(0, Math.min(100, Number((100 - used).toFixed(1))));

const estimateCost = (row: AgentThreadTokenUsage) => {
  const model = row.model?.toLocaleLowerCase() ?? "";
  const key = Object.keys(prices)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => model === candidate || model.startsWith(`${candidate}-`));
  if (!key) return null;
  const price = prices[key];
  const uncached = Math.max(0, row.inputTokens - row.cachedInputTokens);
  return (uncached * price.input + row.cachedInputTokens * price.cached + row.outputTokens * price.output) / 1_000_000;
};

const readQuotaHistory = (): QuotaObservation[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(quotaHistoryKey) ?? "[]");
    return Array.isArray(value) ? value.slice(-80) : [];
  } catch {
    return [];
  }
};

const countdown = (timestamp: number | null, now: number) => {
  if (!timestamp) return "Reset time unavailable";
  const seconds = Math.max(0, Math.floor(timestamp - now / 1_000));
  if (seconds === 0) return "Resetting now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`;
};

function ResetCountdown({ timestamp }: { timestamp: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timestamp) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timestamp]);
  return <>{countdown(timestamp, now)}</>;
}

function QuotaWindow({ label, value }: { label: string; value: AgentRateLimitWindow }) {
  const remaining = remainingPercent(value.usedPercent);
  const urgency = remaining < 10 ? "is-critical" : remaining < 30 ? "is-warning" : "";
  return (
    <article className={urgency}>
      <header><span>{label} remaining</span><strong>{remaining}%</strong></header>
      <i><b style={{ width: `${remaining}%` }} /></i>
      <small><b><ResetCountdown timestamp={value.resetsAt} /></b>{value.resetsAt ? ` · ${resetTime.format(value.resetsAt * 1_000)}` : ""}</small>
    </article>
  );
}

export function UsageDetailsDialog({ rateLimits, threads, usage, onClose }: UsageDetailsDialogProps) {
  const [range, setRange] = useState<Range>("all");
  const [scope, setScope] = useState<"global" | "app">("global");
  const [rankingLimit, setRankingLimit] = useState(30);
  const [quotaHistory, setQuotaHistory] = useState<QuotaObservation[]>(readQuotaHistory);

  useEffect(() => setRankingLimit(30), [range, scope]);
  useEffect(() => {
    if (!rateLimits) return;
    setQuotaHistory((current) => {
      const previous = current.at(-1);
      if (previous && rateLimits.updatedAt <= previous.at) return current;
      const next: QuotaObservation = {
        at: rateLimits.updatedAt,
        sessionUsed: rateLimits.primary?.usedPercent ?? null,
        weeklyUsed: rateLimits.secondary?.usedPercent ?? null,
        credits: rateLimits.resetCredits?.availableCount ?? null,
      };
      if (previous?.credits != null && next.credits != null && next.credits > previous.credits) {
        const added = next.credits - previous.credits;
        next.event = `${added} reset credit${added === 1 ? "" : "s"} added`;
      } else if (previous?.weeklyUsed != null && next.weeklyUsed != null && previous.weeklyUsed - next.weeklyUsed >= 20) {
        next.event = "Weekly quota refill observed";
      } else if (previous?.sessionUsed != null && next.sessionUsed != null && previous.sessionUsed - next.sessionUsed >= 20) {
        next.event = "Five-hour quota refill observed";
      }
      const updated = [...current, next].slice(-80);
      try { window.localStorage.setItem(quotaHistoryKey, JSON.stringify(updated)); } catch { /* optional cache */ }
      return updated;
    });
  }, [rateLimits]);

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

  const metrics = useMemo(() => {
    const result = { total: 0, input: 0, output: 0, cached: 0, reasoning: 0, cost: 0, pricedTokens: 0 };
    for (const row of rows) {
      result.total += row.totalTokens;
      result.input += row.inputTokens;
      result.output += row.outputTokens;
      result.cached += row.cachedInputTokens;
      result.reasoning += row.reasoningOutputTokens;
      if (row.estimatedCost != null) {
        result.cost += row.estimatedCost;
        result.pricedTokens += row.totalTokens;
      }
    }
    return result;
  }, [rows]);
  const activeDays = useMemo(() => new Set(rows.map((row) => new Date(row.updatedAt * 1_000).toLocaleDateString())).size, [rows]);
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
    return Array.from({ length: 30 }, (_, offset) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (29 - offset));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return { key, label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tokens: totals.get(key) ?? 0 };
    });
  }, [rows]);
  const peakDay = Math.max(1, ...dailyRows.map((day) => day.tokens));
  const tokenFlow = [
    { id: "input", label: "Uncached input", value: Math.max(0, metrics.input - metrics.cached) },
    { id: "cache", label: "Cached input", value: metrics.cached },
    { id: "output", label: "Output", value: Math.max(0, metrics.output - metrics.reasoning) },
    { id: "reasoning", label: "Reasoning", value: metrics.reasoning },
  ];
  const tokenFlowTotal = Math.max(1, tokenFlow.reduce((sum, item) => sum + item.value, 0));

  return createPortal(
    <div className="usage-dialog__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="usage-dialog usage-dialog--dashboard" role="dialog" aria-modal="true" aria-labelledby="usage-dialog-title">
        <header className="usage-dialog__header">
          <div className="usage-dialog__title"><i><XiaoIcon name="runtime" size={22} /></i><div><span>Local Codex analytics</span><h2 id="usage-dialog-title">Usage</h2><p>Quota, token flow, model distribution, and API-equivalent value.</p></div></div>
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
            <div className="usage-dialog__headline"><span>API-equivalent value</span><strong>{money.format(metrics.cost)}</strong><small>{metrics.pricedTokens === metrics.total ? "100% mapped to a published standard rate" : `${Math.round(metrics.pricedTokens / Math.max(1, metrics.total) * 100)}% mapped to a published rate`}</small></div>
            <div className="usage-dialog__token-total"><span>Recorded tokens</span><strong>{compact.format(metrics.total)}</strong><small>{compact.format(metrics.input)} input <b>·</b> {compact.format(metrics.output)} output</small></div>
            <dl className="usage-dialog__quick-stats"><div><dt>Sessions</dt><dd>{number.format(rows.length)}</dd></div><div><dt>Active days</dt><dd>{number.format(activeDays)}</dd></div><div><dt>Cache share</dt><dd>{metrics.input ? Math.round(metrics.cached / metrics.input * 100) : 0}%</dd></div><div><dt>Average</dt><dd>{compact.format(rows.length ? metrics.total / rows.length : 0)}</dd></div></dl>
            <div className="usage-dialog__quota-stack">
              {rateLimits?.primary ? <QuotaWindow label={rateLimits.primary.windowDurationMins ? `${Math.round(rateLimits.primary.windowDurationMins / 60)}-hour` : "Five-hour"} value={rateLimits.primary} /> : null}
              {rateLimits?.secondary ? <QuotaWindow label="Weekly" value={rateLimits.secondary} /> : null}
            </div>
          </section>

          <section className="usage-dialog__reset-center" aria-label="Rate limit resets">
            <div className="usage-dialog__reset-summary"><span><XiaoIcon name="refresh" size={16} /></span><div><small>Banked resets</small><strong>{rateLimits?.resetCredits?.availableCount ?? 0} available</strong><p>Reported directly by Codex and cached locally.</p></div></div>
            <div className="usage-dialog__credit-list">{rateLimits?.resetCredits?.credits?.length ? rateLimits.resetCredits.credits.map((credit) => <article key={credit.id}><div><strong>{credit.title ?? "Full rate-limit reset"}</strong><small>{credit.description ?? credit.status}</small></div><span>{credit.expiresAt ? `Expires ${resetTime.format(credit.expiresAt * 1_000)}` : "No expiry reported"}</span></article>) : <p>No detailed reset credits are currently reported.</p>}</div>
            <div className="usage-dialog__quota-events"><small>Recent local observations</small>{quotaHistory.filter((item) => item.event).slice(-3).reverse().map((item) => <span key={item.at}><i />{item.event}<time>{new Date(item.at).toLocaleString()}</time></span>)}{!quotaHistory.some((item) => item.event) ? <p>Refills and new credits will appear here when Codex reports them.</p> : null}</div>
          </section>

          <section className="usage-dialog__activity">
            <header><div><span>Resource flow</span><h3>Tokens by channel</h3></div><small><b>{compact.format(peakDay)}</b> peak recorded day</small></header>
            <div className="usage-dialog__token-flow" aria-label="Token flow breakdown"><div>{tokenFlow.filter((item) => item.value > 0).map((item) => <i className={`is-${item.id}`} key={item.id} style={{ width: `${item.value / tokenFlowTotal * 100}%` }} />)}</div><ul>{tokenFlow.map((item) => <li className={`is-${item.id}`} key={item.id}><i /><span>{item.label}</span><strong>{compact.format(item.value)}</strong><small>{Math.round(item.value / tokenFlowTotal * 100)}%</small></li>)}</ul></div>
            <div className="usage-dialog__trend">{dailyRows.map((day, index) => <button type="button" key={day.key} aria-label={`${day.label}: ${number.format(day.tokens)} tokens`} data-tooltip={`${day.label} · ${number.format(day.tokens)} tokens`}><i><b style={{ height: `${Math.max(day.tokens ? 3 : 1, day.tokens / peakDay * 100)}%` }} /></i>{index % 7 === 0 || index === 29 ? <small>{day.label}</small> : null}</button>)}</div>
          </section>

          <section className="usage-dialog__ranking"><header><div><span>Conversation ranking</span><h3>Most tokens used</h3></div><small>{rows.length} recorded sessions</small></header>{rows.length ? <><div className="usage-dialog__rows">{rows.slice(0, rankingLimit).map((row, index) => <article key={row.threadId}><span className="usage-dialog__rank">{index + 1}</span><div className="usage-dialog__conversation"><strong title={row.title}>{row.title}</strong><small>{row.project} · {row.model ?? "model unavailable"}</small><i><b style={{ width: `${Math.max(1, row.totalTokens / largest * 100)}%` }} /></i></div><div className="usage-dialog__tokens"><strong>{compact.format(row.totalTokens)}</strong><small>{row.estimatedCost == null ? "Cost unavailable" : money.format(row.estimatedCost)}</small></div></article>)}</div>{rankingLimit < rows.length ? <button className="usage-dialog__ranking-more" type="button" onClick={() => setRankingLimit((value) => Math.min(rows.length, value + 30))}>Show {Math.min(30, rows.length - rankingLimit)} more conversations</button> : null}</> : <div className="usage-dialog__empty"><XiaoIcon name="runtime" size={22} /><strong>No token records in this period</strong><p>Some older Codex sessions did not persist token-count events.</p></div>}</section>
          <section className="usage-dialog__models"><header><span>By model</span><h3>Token and cost mix</h3></header><div>{modelRows.map(([model, value]) => <article key={model} style={{ "--model-share": `${value.tokens / Math.max(1, metrics.total) * 100}%` } as React.CSSProperties}><strong>{model}<i><b /></i></strong><span>{compact.format(value.input)} in</span><span>{compact.format(value.output)} out</span><span>{compact.format(value.cached)} cached</span><b>{value.cost == null ? "—" : money.format(value.cost)}<small>{Math.round(value.tokens / Math.max(1, metrics.total) * 100)}%</small></b></article>)}</div></section>
        </div>
        <footer><span>Tokens are exact cumulative rollout counters. Cost uses published standard rates without unverifiable long-context tiers or historical price changes; it is not your subscription bill.</span>{rateLimits?.updatedAt ? <span>Quota updated {new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(rateLimits.updatedAt)}</span> : null}</footer>
      </section>
    </div>,
    document.body,
  );
}
