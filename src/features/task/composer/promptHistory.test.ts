import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_HISTORY_CHARS,
  MAX_PROMPT_HISTORY_ENTRIES,
  MAX_PROMPT_HISTORY_ENTRY_CHARS,
  canNavigatePromptHistory,
  navigatePromptHistory,
  normalizePromptHistory,
  prependPromptHistory,
} from "./promptHistory";

describe("prompt history storage", () => {
  it("keeps recent prompts bounded and moves duplicates to the front", () => {
    const entries = Array.from({ length: MAX_PROMPT_HISTORY_ENTRIES + 5 }, (_, index) => `prompt ${index}`);
    const next = prependPromptHistory(entries, "  prompt 20  ");

    expect(next[0]).toBe("prompt 20");
    expect(next).toHaveLength(MAX_PROMPT_HISTORY_ENTRIES);
    expect(next.filter((entry) => entry === "prompt 20")).toHaveLength(1);
  });

  it("caps total storage and skips individual oversized prompts", () => {
    const oversized = "x".repeat(MAX_PROMPT_HISTORY_ENTRY_CHARS + 1);
    expect(prependPromptHistory(["keep"], oversized)).toEqual(["keep"]);

    const entries = Array.from({ length: 50 }, (_, index) => `${index}:${"x".repeat(2_000)}`);
    const normalized = normalizePromptHistory(entries);
    expect(normalized.reduce((total, entry) => total + entry.length, 0))
      .toBeLessThanOrEqual(MAX_PROMPT_HISTORY_CHARS);
  });

  it("rejects malformed persisted values and removes duplicate entries", () => {
    expect(normalizePromptHistory(null)).toEqual([]);
    expect(normalizePromptHistory({ prompt: "nope" })).toEqual([]);
    expect(normalizePromptHistory([" one ", 2, "one", "", "two"])).toEqual(["one", "two"]);
  });
});

describe("prompt history navigation", () => {
  it("walks older prompts and restores the draft after the newest entry", () => {
    const first = navigatePromptHistory({
      direction: "up",
      entries: ["third", "second", "first"],
      historyIndex: -1,
      currentDraft: "draft",
      savedDraft: null,
    });
    expect(first).toMatchObject({
      handled: true,
      historyIndex: 0,
      savedDraft: "draft",
      value: "third",
      cursor: "start",
    });
    if (!first.handled) throw new Error("Expected history navigation");

    const older = navigatePromptHistory({
      direction: "up",
      entries: ["third", "second", "first"],
      historyIndex: first.historyIndex,
      currentDraft: first.value,
      savedDraft: first.savedDraft,
    });
    expect(older).toMatchObject({ handled: true, historyIndex: 1, value: "second" });
    if (!older.handled) throw new Error("Expected older history entry");

    const newer = navigatePromptHistory({
      direction: "down",
      entries: ["third", "second", "first"],
      historyIndex: 0,
      currentDraft: "third",
      savedDraft: "draft",
    });
    expect(newer).toMatchObject({
      handled: true,
      historyIndex: -1,
      savedDraft: null,
      value: "draft",
      cursor: "end",
    });
  });

  it("only takes over arrow keys at safe cursor boundaries", () => {
    expect(canNavigatePromptHistory("up", "", 0, 0, false)).toBe(true);
    expect(canNavigatePromptHistory("up", "draft", 0, 0, false)).toBe(false);
    expect(canNavigatePromptHistory("down", "draft", 5, 5, false)).toBe(true);
    expect(canNavigatePromptHistory("up", "history", 0, 0, true)).toBe(true);
    expect(canNavigatePromptHistory("down", "history", 7, 7, true)).toBe(true);
    expect(canNavigatePromptHistory("up", "history", 2, 2, true)).toBe(false);
    expect(canNavigatePromptHistory("up", "history", 0, 3, true)).toBe(false);
  });
});
