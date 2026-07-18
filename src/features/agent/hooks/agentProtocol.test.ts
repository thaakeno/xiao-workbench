import { describe, expect, it } from "vitest";

import type { AgentModelSummary } from "../../../core/models/agent";
import {
  approvalResponse,
  contextCompactionTimelineEntry,
  fastServiceTier,
  invalidateUndoHistory,
  latestUndoableTurn,
  mcpElicitationDeclineResponse,
  needsAgentSession,
  permissionGrantFromRequest,
  reconcilePendingApprovalEntries,
  serviceTierForFastMode,
  threadCompactRequest,
  userInput,
} from "./agentProtocol";

describe("userInput", () => {
  it("sends attached file and directory paths as model-visible text", () => {
    expect(userInput("Summarize this", [
      { name: "report.pdf", path: "C:\\Documents\\report.pdf", kind: "file" },
      { name: "notes", path: "C:\\Documents\\notes", kind: "directory" },
    ])).toEqual([
      { type: "text", text: "Summarize this", text_elements: [] },
      { type: "text", text: "Attached file: C:\\Documents\\report.pdf", text_elements: [] },
      { type: "text", text: "Attached directory: C:\\Documents\\notes", text_elements: [] },
    ]);
  });

  it("keeps image attachments on the native image inputs", () => {
    expect(userInput("Describe these", [
      { name: "disk.png", path: "C:\\Images\\disk.png", kind: "image" },
      { name: "paste.png", path: "clipboard:1", kind: "image", url: "data:image/png;base64,abc" },
    ])).toEqual([
      { type: "text", text: "Describe these", text_elements: [] },
      { type: "localImage", path: "C:\\Images\\disk.png" },
      { type: "image", url: "data:image/png;base64,abc" },
    ]);
  });
});

describe("approvalResponse", () => {
  it("declines command and file approvals under Never ask", () => {
    expect(approvalResponse("action", undefined, "decline")).toEqual({
      decision: "decline",
    });
  });

  it("grants only the permissions requested for the current turn", () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["C:/workspace"], write: null },
    };

    expect(approvalResponse("permissions", permissions, "accept")).toEqual({
      permissions,
      scope: "turn",
    });
    expect(approvalResponse("permissions", permissions, "decline")).toEqual({
      permissions: {},
      scope: "turn",
    });
  });
});

describe("pending approval reconciliation", () => {
  const approval = (id: string, runId: string, pendingInputId?: string) => ({
    id,
    kind: "approval" as const,
    title: "Approval",
    status: "warning" as const,
    meta: "Waiting for your decision",
    runId,
    pendingInputId,
  });

  it("expires only callbacks that are terminal or absent from native pending inputs", () => {
    const active = approval("active", "run-active", "pending-active");
    const stale = approval("stale", "run-stale", "pending-stale");
    const terminal = approval("terminal", "run-terminal", "pending-terminal");

    const reconciled = reconcilePendingApprovalEntries(
      [active, stale, terminal],
      new Set(["pending-active", "pending-terminal"]),
      "run-terminal",
    );

    expect(reconciled[0]).toEqual(active);
    expect(reconciled[1]).toMatchObject({ status: "error", meta: "Request expired" });
    expect(reconciled[2]).toMatchObject({ status: "error", meta: "Request expired" });
  });
});

describe("permissionGrantFromRequest", () => {
  it("drops null and unknown permission fields", () => {
    expect(permissionGrantFromRequest({
      network: { enabled: true },
      fileSystem: null,
      unexpected: { enabled: true },
    })).toEqual({ network: { enabled: true } });
  });
});

describe("mcpElicitationDeclineResponse", () => {
  it("returns a terminal protocol response instead of leaving the turn waiting", () => {
    expect(mcpElicitationDeclineResponse()).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });
});

describe("Fast service tier", () => {
  const model = (serviceTiers: AgentModelSummary["serviceTiers"]): AgentModelSummary => ({
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Test model",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    serviceTiers,
  });

  it("uses the exact Fast tier advertised by the Codex model catalog", () => {
    const activeModel = model([
      { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
    ]);

    expect(fastServiceTier(activeModel)).toEqual(activeModel.serviceTiers[0]);
    expect(serviceTierForFastMode(activeModel, true)).toBe("priority");
    expect(serviceTierForFastMode(activeModel, false)).toBeNull();
  });

  it("does not infer Fast support from a model name", () => {
    expect(fastServiceTier(model([]))).toBeNull();
    expect(serviceTierForFastMode(model([]), true)).toBeNull();
  });

  it("accepts legacy catalog tier ids when the display name is unavailable", () => {
    expect(fastServiceTier(model([
      { id: "fast", name: "Priority", description: "Faster responses" },
    ]))?.id).toBe("fast");
  });
});

describe("needsAgentSession", () => {
  it("does not resume a default-model thread after its null selection is cached", () => {
    expect(needsAgentSession("thread-1", true, null, null, "local", "local")).toBe(false);
  });

  it("resumes when the thread is new or the requested model changes", () => {
    expect(needsAgentSession(undefined, true, null, null, "local", "local")).toBe(true);
    expect(needsAgentSession("thread-1", false, undefined, null, "local", "local")).toBe(true);
    expect(needsAgentSession("thread-1", true, "gpt-old", "gpt-new", "local", "local")).toBe(true);
    expect(needsAgentSession("thread-1", true, null, null, "local", "managed:one")).toBe(true);
  });
});

describe("undo history", () => {
  const changedTurn = {
    id: "user-1",
    kind: "user" as const,
    title: "Change a file",
    turnId: "turn-1",
    turnDiff: "diff --git a/file b/file",
  };

  it("treats an empty captured patch as an undoable latest turn", () => {
    const noFileTurn = {
      id: "user-2",
      kind: "user" as const,
      title: "Explain the code",
      turnId: "turn-2",
      turnDiff: "",
    };

    expect(latestUndoableTurn([changedTurn, noFileTurn])).toBe(noFileTurn);
  });

  it("does not skip an untracked latest turn to roll back an older turn", () => {
    const injectedTurn = {
      id: "user-2",
      kind: "user" as const,
      title: "History from an isolated session",
      turnId: "old-turn",
    };

    expect(latestUndoableTurn([changedTurn, injectedTurn])).toBeNull();
  });

  it("invalidates patches that belong to a previous or compacted session", () => {
    const timeline = invalidateUndoHistory([changedTurn]);

    expect(timeline[0]).not.toHaveProperty("turnDiff");
    expect(latestUndoableTurn(timeline)).toBeNull();
  });
});

describe("threadCompactRequest", () => {
  it("uses the native app-server compaction method and thread payload", () => {
    expect(threadCompactRequest("thread-1")).toEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" },
    });
  });
});

describe("contextCompactionTimelineEntry", () => {
  it("projects the official item lifecycle without inventing a summary prompt", () => {
    const item = { type: "contextCompaction", id: "compact-1" };

    expect(contextCompactionTimelineEntry(item, "started")).toMatchObject({
      id: "compact-1",
      kind: "result",
      title: "Compacting context",
      meta: "Context",
      status: "active",
    });
    expect(contextCompactionTimelineEntry(item, "completed")).toMatchObject({
      id: "compact-1",
      kind: "result",
      title: "Context compacted",
      meta: "Context",
      status: "success",
    });
  });

  it("ignores unrelated or malformed items", () => {
    expect(contextCompactionTimelineEntry({ type: "agentMessage", id: "message-1" }, "completed"))
      .toBeNull();
    expect(contextCompactionTimelineEntry({ type: "contextCompaction" }, "completed"))
      .toBeNull();
  });
});
