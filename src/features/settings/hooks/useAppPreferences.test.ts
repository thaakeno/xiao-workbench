import { describe, expect, it } from "vitest";

import {
  defaultTaskRunDefaults,
  normalizeAppPreferences,
} from "./useAppPreferences";

describe("normalizeAppPreferences", () => {
  it("restores every saved task run setting", () => {
    const preferences = normalizeAppPreferences({
      showReasoningSummaries: false,
      expandToolOutput: true,
      focusNewTasks: false,
      wrapCode: true,
      notifyCompletions: false,
      notifyErrors: false,
      notifyApprovals: false,
      hiddenModels: ["hidden-model"],
      taskRunDefaults: {
        model: "gpt-custom",
        reasoningEffort: "high",
        mode: "plan",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
    });

    expect(preferences).toEqual({
      importCodexHistory: true,
      showChatExport: true,
      showReasoningSummaries: false,
      expandToolOutput: true,
      focusNewTasks: false,
      wrapCode: true,
      notifyCompletions: false,
      notifyErrors: false,
      notifyApprovals: false,
      hiddenModels: ["hidden-model"],
      taskRunDefaults: {
        model: "gpt-custom",
        reasoningEffort: "high",
        mode: "plan",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
    });
  });

  it("adds safe task defaults to preferences saved by older versions", () => {
    expect(normalizeAppPreferences({ wrapCode: true }).taskRunDefaults).toEqual(
      defaultTaskRunDefaults,
    );
  });

  it("keeps valid partial defaults and rejects invalid enum values", () => {
    expect(normalizeAppPreferences({
      taskRunDefaults: {
        approvalPolicy: "never",
        sandboxMode: "outside-the-sandbox",
      },
    }).taskRunDefaults).toEqual({
      ...defaultTaskRunDefaults,
      approvalPolicy: "never",
    });
  });
});
