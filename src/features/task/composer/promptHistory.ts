export const MAX_PROMPT_HISTORY_ENTRIES = 50;
export const MAX_PROMPT_HISTORY_ENTRY_CHARS = 16_384;
export const MAX_PROMPT_HISTORY_CHARS = 65_536;

export const normalizePromptHistory = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const entries: string[] = [];
  const seen = new Set<string>();
  let storedChars = 0;

  for (const item of value) {
    if (typeof item !== "string") continue;
    const prompt = item.trim();
    if (
      !prompt ||
      prompt.length > MAX_PROMPT_HISTORY_ENTRY_CHARS ||
      seen.has(prompt) ||
      storedChars + prompt.length > MAX_PROMPT_HISTORY_CHARS
    ) {
      continue;
    }

    entries.push(prompt);
    seen.add(prompt);
    storedChars += prompt.length;
    if (entries.length === MAX_PROMPT_HISTORY_ENTRIES) break;
  }

  return entries;
};

export const prependPromptHistory = (entries: string[], prompt: string): string[] => {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || normalizedPrompt.length > MAX_PROMPT_HISTORY_ENTRY_CHARS) {
    return normalizePromptHistory(entries);
  }
  return normalizePromptHistory([
    normalizedPrompt,
    ...entries.filter((entry) => entry.trim() !== normalizedPrompt),
  ]);
};

type PromptHistoryNavigation = {
  direction: "up" | "down";
  entries: string[];
  historyIndex: number;
  currentDraft: string;
  savedDraft: string | null;
};

type PromptHistoryNavigationResult =
  | {
      handled: false;
      historyIndex: number;
      savedDraft: string | null;
    }
  | {
      handled: true;
      historyIndex: number;
      savedDraft: string | null;
      value: string;
      cursor: "start" | "end";
    };

export const navigatePromptHistory = (
  input: PromptHistoryNavigation,
): PromptHistoryNavigationResult => {
  if (input.direction === "up") {
    if (!input.entries.length) {
      return {
        handled: false,
        historyIndex: input.historyIndex,
        savedDraft: input.savedDraft,
      };
    }
    const nextIndex = input.historyIndex === -1 ? 0 : input.historyIndex + 1;
    const value = input.entries[nextIndex];
    if (value === undefined) {
      return {
        handled: false,
        historyIndex: input.historyIndex,
        savedDraft: input.savedDraft,
      };
    }
    return {
      handled: true,
      historyIndex: nextIndex,
      savedDraft: input.historyIndex === -1 ? input.currentDraft : input.savedDraft,
      value,
      cursor: "start",
    };
  }

  if (input.historyIndex > 0) {
    const nextIndex = input.historyIndex - 1;
    return {
      handled: true,
      historyIndex: nextIndex,
      savedDraft: input.savedDraft,
      value: input.entries[nextIndex] ?? "",
      cursor: "end",
    };
  }
  if (input.historyIndex === 0) {
    return {
      handled: true,
      historyIndex: -1,
      savedDraft: null,
      value: input.savedDraft ?? "",
      cursor: "end",
    };
  }
  return {
    handled: false,
    historyIndex: input.historyIndex,
    savedDraft: input.savedDraft,
  };
};

export const canNavigatePromptHistory = (
  direction: "up" | "down",
  text: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  inHistory: boolean,
) => {
  if (selectionStart === null || selectionEnd === null || selectionStart !== selectionEnd) {
    return false;
  }
  const atStart = selectionStart === 0;
  const atEnd = selectionEnd === text.length;
  if (inHistory) return atStart || atEnd;
  if (direction === "up") return atStart && text.length === 0;
  return atEnd;
};
