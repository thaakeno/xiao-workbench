import { describe, expect, it } from "vitest";

import type { ManagedWorktreeSummary } from "../../core/models/workspace";
import { managedWorktreeCleanupMessage } from "./taskEnvironment";

const worktree = (overrides: Partial<ManagedWorktreeSummary> = {}): ManagedWorktreeSummary => ({
  id: "worktree",
  taskId: "task",
  branch: "xiao/task/worktree",
  checkoutPath: "C:/Xiao/managed/worktree/checkout",
  executionRoot: "C:/Xiao/managed/worktree/checkout",
  status: "active",
  baseCommit: "abc",
  failureReason: null,
  diskBytes: 2 * 1024 * 1024,
  sizeComplete: true,
  hasChanges: false,
  createdAt: 1,
  ...overrides,
});

describe("task environment cleanup", () => {
  it("shows the exact owned path and measured disk usage", () => {
    const message = managedWorktreeCleanupMessage(worktree());

    expect(message).toContain("C:/Xiao/managed/worktree/checkout");
    expect(message).toContain("Disk usage: 2.0 MiB");
    expect(message).toContain("main project will not be reset");
  });

  it("warns for bounded size and uncommitted changes", () => {
    const message = managedWorktreeCleanupMessage(worktree({
      diskBytes: 1536,
      sizeComplete: false,
      hasChanges: true,
    }));

    expect(message).toContain("at least 1.5 KiB");
    expect(message).toContain("uncommitted changes");
  });
});
