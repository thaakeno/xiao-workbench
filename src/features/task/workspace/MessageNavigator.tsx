import { useState } from "react";

import type { TimelineEntry } from "../../../core/models/agent";

type MessageStop = {
  id: string;
  user: string;
  assistant: string;
  timestamp: number | null;
  files: Array<{ path: string; additions: number; deletions: number }>;
};

const preview = (value: string | undefined, fallback: string) => (value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 150);
const shortPath = (path: string) => path.replaceAll("\\", "/").split("/").at(-1) ?? path;

export function MessageNavigator({ timeline, onJump }: { timeline: TimelineEntry[]; onJump: (id: string) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const stops: MessageStop[] = [];
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
    stops.push({ id: user.id, user: preview(user.body, user.title), assistant: preview(response?.body, "No agent response recorded"), timestamp: user.createdAt ?? null, files: [...files.values()].slice(0, 3) });
  }
  if (stops.length < 2) return null;
  return <nav className="message-navigator" aria-label="Jump to a message" onMouseLeave={() => setHovered(null)}>
    {stops.map((stop, index) => {
      const distance = hovered == null ? 9 : Math.min(9, Math.abs(index - hovered));
      return <button type="button" key={stop.id} data-distance={distance} aria-label={`Jump to message ${index + 1}`} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} onBlur={() => setHovered(null)} onClick={() => onJump(stop.id)}>
        <i /><span>
          {stop.timestamp ? <time dateTime={new Date(stop.timestamp).toISOString()}>{new Date(stop.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time> : null}
          <strong>{stop.user}</strong>
          <small>{stop.assistant}</small>
          {stop.files.length ? <em>{stop.files.map((file) => <b key={file.path}><span>{shortPath(file.path)}</span><i>+{file.additions}</i><u>-{file.deletions}</u></b>)}</em> : null}
        </span>
      </button>;
    })}
  </nav>;
}
