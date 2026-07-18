import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("routine ownership boundary", () => {
  it("keeps authoritative schedule timers and storage out of the renderer", () => {
    const app = source("../../app/App.tsx");
    const panel = source("./components/SchedulePanel.tsx");
    const hook = source("./hooks/useRoutines.ts");

    expect(app).not.toContain("scheduleStorageKey");
    expect(app).not.toContain("readScheduledTasks");
    expect(app).not.toContain("setInterval(");
    expect(panel).not.toContain("localStorage");
    expect(hook).toContain("nativeBridge.listXiaoRoutines");
    expect(hook).toContain('"xiao://routine-update"');
  });
});
