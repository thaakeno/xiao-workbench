import { useEffect, useMemo, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentModelSummary } from "../../../core/models/agent";
import { fastServiceTier } from "../../agent/hooks/agentProtocol";
import { reasoningLabel } from "./ReasoningControl";
import "./model-picker.css";

type ModelPickerProps = {
  models: AgentModelSummary[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  fastMode: boolean;
  disabled: boolean;
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onFastModeChange: (fastMode: boolean) => void;
};

const apiPricing: Record<string, { input: number; cached: number | null; output: number }> = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
};

function OpenAIIcon() {
  return <svg className="model-picker__provider-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" d="M12 3.1a4.2 4.2 0 0 1 4.1 3.2 4.2 4.2 0 0 1 2.7 6.9 4.2 4.2 0 0 1-4.1 5.7A4.2 4.2 0 0 1 8 18.4a4.2 4.2 0 0 1-2.7-6.9A4.2 4.2 0 0 1 9.4 5.8 4.1 4.1 0 0 1 12 3.1Z"/><path fill="none" stroke="currentColor" strokeWidth="1.8" d="m8.4 8.2 3.6-2.1 3.6 2.1v4.2L12 14.5l-3.6-2.1V8.2Zm0 4.2v4.1m7.2-8.3 3.2 1.8M12 14.5v4.1"/></svg>;
}

export function ModelPicker(props: ModelPickerProps) {
  const { models, selectedModel, selectedReasoningEffort, fastMode, disabled, onModelChange, onReasoningEffortChange, onFastModeChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const defaultModel = models.find((model) => model.isDefault);
  const activeModel = (selectedModel ? models.find((model) => model.model === selectedModel) : defaultModel) ?? defaultModel;
  const effort = activeModel ? selectedReasoningEffort || activeModel.defaultReasoningEffort : "";
  const effortOptions = useMemo(() => [...new Map((activeModel?.supportedReasoningEfforts ?? []).map((item) => [item.reasoningEffort, item])).values()], [activeModel]);
  const fastAvailable = Boolean(fastServiceTier(activeModel));
  const fastEnabled = fastAvailable && fastMode;
  const filtered = query.trim() ? models.filter((model) => `${model.displayName} ${model.model}`.toLowerCase().includes(query.trim().toLowerCase())) : models;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className="run-profile-controls unified-profile" ref={root}>
    <button className="unified-profile__trigger" type="button" disabled={disabled || !models.length} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
      <OpenAIIcon /><span>{activeModel?.displayName ?? "Codex default"} <i>·</i> {effort ? reasoningLabel(effort) : "Thinking"} <i>·</i> {fastEnabled ? "Fast" : "Standard"}</span><XiaoIcon name="caret" size={12} />
    </button>
    {open ? <section className="unified-profile__menu picker-menu" role="dialog" aria-label="Model and run configuration">
      <header><div><strong>Run configuration</strong><small>Synced with your Codex account</small></div><button type="button" aria-label="Close" onClick={() => setOpen(false)}><XiaoIcon name="close" size={15}/></button></header>
      <label className="picker-menu__search"><XiaoIcon name="search" size={14}/><input autoFocus type="search" value={query} placeholder="Search models" onChange={(event) => setQuery(event.target.value)}/></label>
      <div className="unified-profile__models">
        {filtered.map((model) => {
          const selected = selectedModel ? model.model === selectedModel : model.isDefault;
          const price = apiPricing[model.model];
          return <button type="button" className={selected ? "is-selected" : ""} key={model.id} onClick={() => onModelChange(model.isDefault ? null : model.model)}>
            <span className="model-picker__row-icon"><OpenAIIcon /></span>
            <span><strong>{model.displayName}</strong><small>{model.description}</small></span>
            <span className="model-price" title={price ? `Official API price per 1M tokens: $${price.input} input, ${price.cached == null ? "no cached rate" : `$${price.cached} cached`}, $${price.output} output.` : "This Codex account model has no published API-equivalent price."}>{price ? <><b>${price.input}</b> in <i>·</i> <b>${price.output}</b> out</> : "No public API price"}</span>
            {selected ? <XiaoIcon name="check" size={14}/> : null}
          </button>;
        })}
      </div>
      <div className="unified-profile__section"><div><strong>Reasoning</strong><small>Faster</small><small>Smarter</small></div><div className="effort-slider" style={{ "--effort-count": Math.max(1, effortOptions.length) } as React.CSSProperties}>{effortOptions.map((option) => <button type="button" className={option.reasoningEffort === effort ? "is-selected" : ""} title={option.description} key={option.reasoningEffort} onClick={() => onReasoningEffortChange(option.reasoningEffort === activeModel?.defaultReasoningEffort ? null : option.reasoningEffort)}>{reasoningLabel(option.reasoningEffort)}</button>)}</div></div>
      <label className={`unified-profile__toggle ${fastEnabled ? "is-on" : ""}`}><span><strong>Fast mode</strong><small>{fastAvailable ? "Prioritize lower latency with increased usage" : "Unavailable for this model"}</small></span><input type="checkbox" checked={fastEnabled} disabled={!fastAvailable} onChange={(event) => onFastModeChange(event.target.checked)}/><i /></label>
      <footer>Public prices are official API rates per 1M tokens, not your Codex subscription cost.</footer>
    </section> : null}
  </div>;
}
