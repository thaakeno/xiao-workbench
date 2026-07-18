import type { ManagedWorktreeSummary } from "../../core/models/workspace";

export const formatDiskBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
};

export const managedWorktreeCleanupMessage = (worktree: ManagedWorktreeSummary) => {
  const size = `${worktree.sizeComplete ? "" : "at least "}${formatDiskBytes(worktree.diskBytes)}`;
  const dirty = worktree.hasChanges
    ? "\n\nThis checkout has uncommitted changes."
    : "";
  return `Remove this Xiao-managed worktree?\n\n${worktree.checkoutPath}\nDisk usage: ${size}${dirty}\n\nThe main project will not be reset.`;
};
