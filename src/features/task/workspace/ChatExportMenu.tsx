import { useEffect, useMemo, useRef, useState } from "react";
import { encode } from "gpt-tokenizer";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { TimelineEntry } from "../../../core/models/agent";

type ExportCategory = "user" | "assistant" | "tools" | "commands" | "outputs" | "reasoning";
type ExportOptions = Record<ExportCategory, boolean>;
type ExportBlock = { category: ExportCategory; markdown: string };
const defaults: ExportOptions = { user: true, assistant: true, tools: false, commands: false, outputs: false, reasoning: false };
const choices: Array<[ExportCategory, string, string]> = [
  ["user", "User messages", "Prompts and attachments"], ["assistant", "Agent responses", "Final answers from Xiao"],
  ["tools", "Tools and file edits", "Searches, reads, and changes"], ["commands", "Commands", "Shell commands without output"],
  ["outputs", "Command output", "Captured stdout and stderr"], ["reasoning", "Reasoning summaries", "Visible summaries, when recorded"],
];

const blocksFor = (entry: TimelineEntry): ExportBlock[] => {
  const body = entry.body ?? entry.title;
  if (entry.kind === "user" || entry.kind === "brief") return [{ category: "user", markdown: `## You\n\n${body}` }];
  if (entry.kind === "result" && entry.title === "Agent response") return [{ category: "assistant", markdown: `## Xiao\n\n${entry.body ?? ""}` }];
  if (entry.kind === "thought") return [{ category: "reasoning", markdown: `### Reasoning\n\n${body}` }];
  if (entry.kind === "command") return [
    { category: "commands", markdown: `### Command\n\n\`\`\`shell\n${entry.command ?? entry.title}\n\`\`\`` },
    ...(entry.body ? [{ category: "outputs" as const, markdown: `### Command output\n\n\`\`\`text\n${entry.body}\n\`\`\`` }] : []),
  ];
  if (entry.kind === "explore") return [{ category: "tools", markdown: `### Tools\n\n${(entry.exploration ?? []).map((action) => `- ${action.kind}: ${action.label}`).join("\n") || entry.title}` }];
  if (entry.kind === "change") return [{ category: "tools", markdown: `### Edited files\n\n${(entry.files ?? []).map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`).join("\n")}` }];
  if (entry.kind === "result" && entry.meta === "Context") return [{ category: "tools", markdown: `### ${entry.title}\n\n${entry.body ?? ""}` }];
  return [];
};
const allBlocks = (timeline: TimelineEntry[]) => timeline.flatMap(blocksFor);
const countTokens = (value: string) => encode(value).length;
export const serializeChat = (title: string, timeline: TimelineEntry[], options: Partial<ExportOptions>) =>
  [`# ${title}`, ...allBlocks(timeline).filter((block) => options[block.category] || (options.tools && (block.category === "commands" || block.category === "outputs"))).map((block) => block.markdown)].join("\n\n") + "\n";

const copyText = async (value: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = Object.assign(document.createElement("textarea"), { value });
  document.body.appendChild(textarea); textarea.select(); document.execCommand("copy"); textarea.remove();
};

export function ChatExportMenu({ title, timeline }: { title: string; timeline: TimelineEntry[] }) {
  const [open, setOpen] = useState(false), [options, setOptions] = useState(defaults), [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null), blocks = useMemo(() => allBlocks(timeline), [timeline]);
  const stats = useMemo(() => Object.fromEntries(choices.map(([key]) => {
    const group = blocks.filter((block) => block.category === key);
    return [key, { items: group.length, tokens: group.reduce((sum, block) => sum + countTokens(block.markdown), 0) }];
  })) as Record<ExportCategory, { items: number; tokens: number }>, [blocks]);
  const content = useMemo(() => serializeChat(title, timeline, options), [options, timeline, title]);
  const itemCount = choices.reduce((sum, [key]) => sum + (options[key] ? stats[key].items : 0), 0);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  const copy = () => void copyText(content).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); });
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    Object.assign(document.createElement("a"), { href: url, download: `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "xiao-chat"}.md` }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="chat-export" ref={root}>
    <button className="icon-button" type="button" aria-label="Copy or export chat" aria-expanded={open} onClick={() => setOpen((value) => !value)}><XiaoIcon name="copy" size={15} /></button>
    {open ? <div className="chat-export__menu" role="dialog" aria-label="Copy and export options">
      <header><div><strong>Copy or export</strong><small>Build a clean transcript</small></div><span>{itemCount} items</span></header>
      <div className="chat-export__options">{choices.map(([key, label, description]) => <label key={key} title={`${stats[key].tokens.toLocaleString()} exact tokens in exported visible text`}>
        <input type="checkbox" checked={options[key]} disabled={!stats[key].items} onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.checked }))} />
        <span><i /><b><strong>{label}</strong><small>{description}</small></b><em>{stats[key].items}<small>{stats[key].tokens.toLocaleString()} tok</small></em></span>
      </label>)}</div>
      <div className="chat-export__total"><span>Selected transcript</span><strong>{countTokens(content).toLocaleString()} tokens</strong><small>Exact tokenizer count for exported text</small></div>
      <footer><button type="button" disabled={!itemCount} onClick={copy}><XiaoIcon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy Markdown"}</button><button type="button" disabled={!itemCount} onClick={download}><XiaoIcon name="external" size={14} />Export .md</button></footer>
    </div> : null}
  </div>;
}
