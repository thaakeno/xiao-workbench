import { useMemo, useRef, useState } from "react";

import type { TimelineEntry } from "../../../core/models/agent";

type MessageStop = {
  id: string;
  user: string;
  assistant: string;
  timestamp: number | null;
  files: Array<{ path: string; additions: number; deletions: number }>;
};

const preview = (value: string | undefined, fallback: string) => (value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 180);
const shortPath = (path: string) => path.replaceAll("\\", "/").split("/").at(-1) ?? path;

export function MessageNavigator({ timeline, onJump }: { timeline: TimelineEntry[]; onJump: (id: string) => void }) {
  const hostRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const stops = useMemo<MessageStop[]>(() => {
    const result: MessageStop[] = [];
    for (let index = 0; index < timeline.length; index += 1) {
      const user = timeline[index];
      if (user.kind !== "user" && user.kind !== "brief") continue;
      const segment: TimelineEntry[] = [];
      for (let cursor = index + 1; cursor < timeline.length; cursor += 1) {
        if (timeline[cursor].kind === "user" || timeline[cursor].kind === "brief") break;
        segment.push(timeline[cursor]);
      }
      const response = [...segment].reverse().find((entry) => entry.kind === "result" && entry.title === "Agent response");
      const files = new Map<string, { path: string; additions: number; deletions: number }>();
      for (const entry of segment) for (const file of entry.files ?? []) {
        const current = files.get(file.path);
        files.set(file.path, current ? { ...current, additions: current.additions + file.additions, deletions: current.deletions + file.deletions } : file);
      }
      result.push({ id: user.id, user: preview(user.body, user.title), assistant: preview(response?.body, "No agent response recorded"), timestamp: user.createdAt ?? null, files: [...files.values()].slice(0, 3) });
    }
    return result;
  }, [timeline]);
  if (stops.length < 2) return null;
  const active = hovered == null ? null : stops[hovered];
  return <nav ref={hostRef} className="message-navigator" aria-label="Jump to a message" onMouseLeave={() => setHovered(null)}>
    <div className="message-navigator__track">
      {stops.map((stop, index) => {
        const activate = (node: HTMLButtonElement) => {
          const host = hostRef.current?.getBoundingClientRect();
          const mark = node.getBoundingClientRect();
          setHovered(index);
          if (host) setTooltipTop(Math.max(72, Math.min(host.height - 72, mark.top + mark.height / 2 - host.top)));
        };
        return <button type="button" key={stop.id} aria-label={`Jump to message ${index + 1}`} onMouseEnter={(event) => activate(event.currentTarget)} onFocus={(event) => activate(event.currentTarget)} onBlur={() => setHovered(null)} onClick={() => onJump(stop.id)}><i /></button>;
      })}
    </div>
    {active ? <aside className="message-navigator__preview" style={{ top: tooltipTop }}>
      {active.timestamp ? <time dateTime={new Date(active.timestamp).toISOString()}>{new Date(active.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time> : null}
      <strong>{active.user}</strong>
      <small>{active.assistant}</small>
      {active.files.length ? <em>{active.files.map((file) => <b key={file.path}><span>{shortPath(file.path)}</span><i>+{file.additions}</i><u>-{file.deletions}</u></b>)}</em> : null}
    </aside> : null}
  </nav>;
}
