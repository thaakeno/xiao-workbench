import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

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

type OpenMenu = "model" | "reasoning" | null;

function OpenAIIcon() {
  return (
    <svg
      className="model-picker__provider-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

export function ModelPicker({
  models,
  selectedModel,
  selectedReasoningEffort,
  fastMode,
  disabled,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
}: ModelPickerProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const reasoningTrigger = useRef<HTMLButtonElement>(null);
  const modelSearch = useRef<HTMLInputElement>(null);
  const defaultModel = models.find((model) => model.isDefault);
  const activeModel =
    (selectedModel ? models.find((model) => model.model === selectedModel) : defaultModel) ??
    defaultModel;
  const reasoningOptions = [
    ...new Map(
      (activeModel?.supportedReasoningEfforts ?? []).map((option) => [option.reasoningEffort, option]),
    ).values(),
  ];
  const effectiveEffort = activeModel
    ? selectedReasoningEffort || activeModel.defaultReasoningEffort
    : "";
  const fastTier = fastServiceTier(activeModel);
  const fastModeEnabled = Boolean(fastMode && fastTier);
  const fastModeTitle = fastTier
    ? `${fastTier.description || "Faster responses with increased usage."} Click to turn Fast mode ${fastModeEnabled ? "off" : "on"}.`
    : `${activeModel?.displayName ?? "This model"} does not offer Fast mode.`;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? models.filter((model) =>
        `${model.displayName} ${model.description}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : models;

  const closeMenu = (restoreFocus = false) => {
    const trigger = openMenu === "model" ? modelTrigger.current : reasoningTrigger.current;
    setOpenMenu(null);
    setQuery("");
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus());
  };

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };
    const focusFrame = window.requestAnimationFrame(() => {
      if (openMenu === "model") {
        modelSearch.current?.focus({ preventScroll: true });
        return;
      }
      root.current
        ?.querySelector<HTMLButtonElement>('.reasoning-picker__menu [aria-checked="true"]')
        ?.focus({ preventScroll: true });
    });
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    if (disabled || !models.length) closeMenu();
  }, [disabled, models.length]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (!items.length) return;
    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? activeIndex <= 0
              ? items.length - 1
              : activeIndex - 1
            : activeIndex >= items.length - 1
              ? 0
              : activeIndex + 1;
    items[nextIndex]?.focus();
  };

  const chooseModel = (model: AgentModelSummary) => {
    onModelChange(model.isDefault ? null : model.model);
    closeMenu(true);
  };

  const chooseEffort = (effort: string | null) => {
    onReasoningEffortChange(effort);
    closeMenu(true);
  };

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => {
    if (openMenu === menu) {
      closeMenu();
      return;
    }
    if (menu === "model") setQuery("");
    setOpenMenu(menu);
  };

  return (
    <div className="run-profile-controls" ref={root}>
      <div className="model-picker">
        <button
          className="model-picker__trigger"
          type="button"
          ref={modelTrigger}
          aria-label="Choose OpenAI model"
          aria-haspopup="dialog"
          aria-expanded={openMenu === "model"}
          disabled={disabled || !models.length}
          onClick={() => toggleMenu("model")}
        >
          <OpenAIIcon />
          <span>{activeModel?.displayName ?? "Codex default"}</span>
          <XiaoIcon name="caret" size={12} />
        </button>

        {openMenu === "model" && (
          <div
            className="picker-menu model-picker__menu"
            role="dialog"
            aria-label="Available models"
            onKeyDown={handleMenuKeyDown}
          >
            <label className="picker-menu__search">
              <XiaoIcon name="search" size={14} />
              <input
                ref={modelSearch}
                type="search"
                value={query}
                aria-label="Search models"
                placeholder="Search models"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="picker-menu__label">Models</span>
            <div className="picker-menu__list" role="listbox" aria-label="Models">
              {filteredModels.map((model) => {
                const selected = selectedModel
                  ? model.model === selectedModel
                  : model.isDefault;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={model.description || undefined}
                    key={model.id}
                    onClick={() => chooseModel(model)}
                  >
                    <span>{model.displayName}</span>
                    {selected ? <XiaoIcon name="check" size={14} strokeWidth={2} /> : null}
                  </button>
                );
              })}
              {!filteredModels.length ? <p>No matching models</p> : null}
            </div>
            <small className="picker-menu__footer">Synced from your Codex account</small>
          </div>
        )}
      </div>

      <div className="reasoning-picker">
        <button
          className={`reasoning-picker__trigger ${effectiveEffort === "ultra" ? "is-ultra" : ""}`}
          type="button"
          ref={reasoningTrigger}
          aria-label="Choose reasoning effort"
          aria-haspopup="menu"
          aria-expanded={openMenu === "reasoning"}
          disabled={disabled || !reasoningOptions.length}
          onClick={() => toggleMenu("reasoning")}
        >
          <span>{effectiveEffort ? reasoningLabel(effectiveEffort) : "Thinking"}</span>
          <XiaoIcon name="caret" size={12} />
        </button>

        {openMenu === "reasoning" && (
          <div
            className="picker-menu reasoning-picker__menu"
            role="menu"
            aria-label="Reasoning effort"
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selectedReasoningEffort === null}
              onClick={() => chooseEffort(null)}
            >
              <span>Default</span>
              {selectedReasoningEffort === null ? (
                <XiaoIcon name="check" size={14} strokeWidth={2} />
              ) : null}
            </button>
            {reasoningOptions.map((option) => {
              const selected = selectedReasoningEffort === option.reasoningEffort;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  title={option.description || undefined}
                  key={option.reasoningEffort}
                  onClick={() => chooseEffort(option.reasoningEffort)}
                >
                  <span>{reasoningLabel(option.reasoningEffort)}</span>
                  {selected ? <XiaoIcon name="check" size={14} strokeWidth={2} /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="fast-mode" title={fastModeTitle}>
        <button
          className={`fast-mode__trigger ${fastModeEnabled ? "is-on" : ""}`}
          type="button"
          aria-label={`Fast mode ${fastModeEnabled ? "on" : "off"}`}
          aria-pressed={fastModeEnabled}
          disabled={disabled || !fastTier}
          onClick={() => onFastModeChange(!fastModeEnabled)}
        >
          <i aria-hidden="true" />
          <span>Fast {fastModeEnabled ? "on" : "off"}</span>
        </button>
      </div>
    </div>
  );
}
