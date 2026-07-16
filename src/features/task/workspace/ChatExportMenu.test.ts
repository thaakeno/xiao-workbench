import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { serializeChat } from "./ChatExportMenu";

const timeline: TimelineEntry[] = [
  { id: "u", kind: "user", title: "You", body: "Please fix it", createdAt: 1 },
  { id: "t", kind: "thought", title: "Inspecting", body: "Checking the cause", createdAt: 2 },
  { id: "c", kind: "command", title: "Ran command", command: "npm test", createdAt: 3 },
  { id: "a", kind: "result", title: "Agent response", body: "Fixed and verified.", createdAt: 4 },
];

describe("serializeChat", () => {
  it("exports a clean transcript by default", () => {
    const value = serializeChat("A task", timeline, { user: true, assistant: true, tools: false, reasoning: false });
    expect(value).toContain("## You\n\nPlease fix it");
    expect(value).toContain("## Xiao\n\nFixed and verified.");
    expect(value).not.toContain("npm test");
    expect(value).not.toContain("Checking the cause");
  });

  it("includes optional tool calls and published reasoning summaries", () => {
    const value = serializeChat("A task", timeline, { user: false, assistant: false, tools: true, reasoning: true });
    expect(value).toContain("### Thought");
    expect(value).toContain("npm test");
    expect(value).not.toContain("Please fix it");
  });
});
