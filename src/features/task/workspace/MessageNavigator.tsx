import type { TimelineEntry } from "../../../core/models/agent";

type MessageStop = { id: string; user: string; assistant: string };

const preview = (value: string | undefined, fallback: string) => (value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 150);

export function MessageNavigator({ timeline, onJump }: { timeline: TimelineEntry[]; onJump: (id: string) => void }) {
  const stops: MessageStop[] = [];
  let nextResponse = "No agent response recorded";
  const responseAfter = new Map<number, string>();
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.kind === "result" && entry.title === "Agent response") nextResponse = preview(entry.body, entry.title);
    responseAfter.set(index, nextResponse);
  }
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (entry.kind !== "user" && entry.kind !== "brief") continue;
    stops.push({ id: entry.id, user: preview(entry.body, entry.title), assistant: responseAfter.get(index + 1) ?? "No agent response recorded" });
  }
  if (stops.length < 2) return null;
  return <nav className="message-navigator" aria-label="Jump to a message">
    {stops.map((stop, index) => <button type="button" key={stop.id} aria-label={`Jump to message ${index + 1}`} onClick={() => onJump(stop.id)}><i /><span><strong>{stop.user}</strong><small>{stop.assistant}</small></span></button>)}
  </nav>;
}
