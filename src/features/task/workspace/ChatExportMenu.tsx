import { useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

type ExportOptions = {
  user: boolean;
  assistant: boolean;
  tools: boolean;
  reasoning: boolean;
};

const defaultOptions: ExportOptions = { user: true, assistant: true, tools: false, reasoning: false };

export const serializeChat = (title: string, timeline: TimelineEntry[], options: ExportOptions) => {
  const sections = [`# ${title}`];
  for (const entry of timeline) {
    const user = entry.kind === "user" || entry.kind === "brief";
    const assistant = entry.kind === "result" && entry.title === "Agent response";
    const reasoning = entry.kind === "thought";
    const tool = entry.kind === "command" || entry.kind === "explore" || entry.kind === "change" || (entry.kind === "result" && entry.meta === "Context");
    if ((user && !options.user) || (assistant && !options.assistant) || (reasoning && !options.reasoning) || (tool && !options.tools)) continue;
    if (!user && !assistant && !reasoning && !tool) continue;
    if (user) sections.push(`## You\n\n${entry.body ?? entry.title}`);
    if (assistant) sections.push(`## Xiao\n\n${entry.body ?? ""}`);
    if (reasoning) sections.push(`### Thought${entry.body ? `\n\n${entry.body}` : ""}`);
    if (entry.kind === "command") sections.push(`### Command\n\n\`\`\`shell\n${entry.command ?? entry.title}\n\`\`\`${entry.body ? `\n\n\`\`\`text\n${entry.body}\n\`\`\`` : ""}`);
    if (entry.kind === "explore") sections.push(`### Tools\n\n${(entry.exploration ?? []).map((action) => `- ${action.kind}: ${action.label}`).join("\n") || entry.title}`);
    if (entry.kind === "change") sections.push(`### Edited files\n\n${(entry.files ?? []).map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`).join("\n")}`);
    if (entry.kind === "result" && entry.meta === "Context") sections.push(`### ${entry.title}`);
  }
  return `${sections.join("\n\n")}\n`;
};

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

export function ChatExportMenu({ title, timeline }: { title: string; timeline: TimelineEntry[] }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(defaultOptions);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const content = () => serializeChat(title, timeline, options);
  const copy = () => void copyText(content()).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  });
  const download = () => {
    const url = URL.createObjectURL(new Blob([content()], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "xiao-chat"}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="chat-export" ref={root}>
      <button className="icon-button" type="button" aria-label="Copy or export chat" aria-expanded={open} title="Copy or export chat" onClick={() => setOpen((value) => !value)}><XiaoIcon name="copy" size={15} /></button>
      {open ? <div className="chat-export__menu" role="dialog" aria-label="Copy and export options">
        <header><div><strong>Copy or export</strong><small>Choose what the transcript contains</small></div><XiaoIcon name="copy" size={15} /></header>
        <div className="chat-export__options">
          {([[
            "user", "User messages"], ["assistant", "Agent responses"], ["tools", "Tool calls and edits"], ["reasoning", "Reasoning summaries"]] as Array<[keyof ExportOptions, string]>).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.checked }))} /><span><i />{label}</span></label>)}
        </div>
        <footer><button type="button" onClick={copy}><XiaoIcon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy Markdown"}</button><button type="button" onClick={download}><XiaoIcon name="external" size={14} />Export .md</button></footer>
      </div> : null}
    </div>
  );
}
