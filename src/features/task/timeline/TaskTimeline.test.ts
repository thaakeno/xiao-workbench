import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../core/models/agent";
import { compactTimelineChanges } from "./TaskTimeline";

const change = (id: string, path: string, additions: number, deletions: number): TimelineEntry => ({
  id,
  kind: "change",
  title: "Edited a file",
  createdAt: 1,
  files: [{ path, additions, deletions }],
});

describe("compactTimelineChanges", () => {
  it("batches file edits from the same turn into one completed card", () => {
    const result = compactTimelineChanges([
      { id: "user-1", kind: "user", title: "You", body: "Fix it", createdAt: 0 },
      change("change-1", "src/a.ts", 3, 1),
      change("change-2", "src/b.ts", 4, 2),
    ]);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      kind: "change",
      title: "Updated 2 files",
      files: [
        { path: "src/a.ts", additions: 3, deletions: 1 },
        { path: "src/b.ts", additions: 4, deletions: 2 },
      ],
    });
  });

  it("hides edit cards from an active turn", () => {
    const timeline = [
      { id: "user-1", kind: "user", title: "You", body: "Fix it", createdAt: 0 } as TimelineEntry,
      change("change-1", "src/a.ts", 3, 1),
    ];
    expect(compactTimelineChanges(timeline, 0)).toEqual([timeline[0]]);
  });
});
