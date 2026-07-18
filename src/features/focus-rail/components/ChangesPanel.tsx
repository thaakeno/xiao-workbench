import { useEffect, useMemo, useState } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { GitBranch, GitSummary, WorkspaceSnapshot } from "../../../core/models/workspace";

type ChangesPanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  transitioning: boolean;
  onRefresh: () => void;
};

type Worktree = { path: string; branch: string; head: string; isMain: boolean };

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const directory = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

export function ChangesPanel({
  workspace,
  taskId,
  transitioning,
  onRefresh,
}: ChangesPanelProps) {
  const git = workspace.git;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [comparison, setComparison] = useState<GitSummary | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = busy || transitioning;
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const visibleGit = baseBranch ? comparison : git;
  const comparisonMode = Boolean(baseBranch);
  const preferredChange = visibleGit?.changes.find((change) => !change.patch.startsWith("Binary file")) ?? visibleGit?.changes[0] ?? null;
  const selectedChange = visibleGit?.changes.find((change) => change.path === selectedPath) ?? preferredChange;
  const filteredChanges = useMemo(() => {
    const value = query.trim().toLowerCase();
    return visibleGit?.changes.filter((change) => !value || change.path.toLowerCase().includes(value)) ?? [];
  }, [visibleGit?.changes, query]);

  useEffect(() => {
    setSelectedPath(preferredChange?.path ?? null);
    setQuery("");
  }, [visibleGit, workspace.path]);

  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    setBaseBranch("");
    setComparison(null);
    setBranchError(null);
    if (!git) return;
    void nativeBridge.getGitBranches(workspace.path, taskId).then((items) => {
      if (!cancelled) setBranches(items);
    }).catch((reason) => {
      if (!cancelled) setBranchError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [git?.branch, taskId, workspace.path]);

  useEffect(() => {
    let cancelled = false;
    if (!git || !baseBranch) {
      setComparison(null);
      setComparisonLoading(false);
      setComparisonError(null);
      return;
    }
    setComparisonLoading(true);
    setComparisonError(null);
    void nativeBridge.compareGitBranch(workspace.path, taskId, baseBranch).then((result) => {
      if (!cancelled) setComparison(result);
    }).catch((reason) => {
      if (!cancelled) {
        setComparison(null);
        setComparisonError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!cancelled) setComparisonLoading(false);
    });
    return () => { cancelled = true; };
  }, [baseBranch, git, taskId, workspace.path]);

  const refreshWorktrees = async () => {
    if (!git) return;
    try {
      setWorktrees(await nativeBridge.getGitWorktrees(workspace.path, taskId));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => { void refreshWorktrees(); }, [workspace.path, taskId, Boolean(git)]);

  const runAction = async (
    action: "commit" | "discard" | "stage" | "stage-all" | "switch" | "unstage",
    paths: string[] = [],
    message?: string,
  ) => {
    if (transitioning) return;
    setBusy(true);
    setActionError(null);
    setActionResult(null);
    try {
      const result = await nativeBridge.mutateGit(
        workspace.path,
        taskId,
        action,
        paths,
        message,
      );
      setActionResult(result.trim() || `${action} completed.`);
      if (action === "commit") setCommitMessage("");
      if (action === "switch") {
        setBranchName("");
        setBaseBranch("");
        setComparison(null);
      }
      onRefresh();
      await refreshWorktrees();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createWorktree = async () => {
    if (transitioning) return;
    setBusy(true);
    setActionError(null);
    try {
      await nativeBridge.addGitWorktree(workspace.path, worktreePath.trim(), branchName.trim());
      setWorktreePath("");
      setBranchName("");
      setActionResult("Worktree created.");
      await refreshWorktrees();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createDraftPr = async () => {
    if (transitioning) return;
    if (!window.confirm("Create a draft pull request for the current branch using GitHub CLI?")) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await nativeBridge.agentRequest<{ exitCode: number; stdout: string; stderr: string }>(
        "command/exec",
        { command: ["gh", "pr", "create", "--draft", "--fill"], cwd: workspace.path, timeoutMs: 120000 },
        { projectPath: workspace.path, taskId },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || "GitHub CLI could not create the pull request.");
      setActionResult(result.stdout.trim() || "Draft pull request created.");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!git) {
    return <div className="rail-empty"><XiaoIcon name="branch" size={24} /><strong>Git context unavailable</strong><p>Initialize a Git repository to unlock review and repository actions.</p></div>;
  }

  return (
    <section className="changes-review">
      <header className="changes-review__header">
        <div className="changes-review__branch" title={git.repositoryRoot}>
          <XiaoIcon name="branch" size={14} />
          <strong>{git.branch}</strong>
          <span>vs</span>
          <select
            aria-label="Compare changes against branch"
            title={branchError ?? "Compare without checking out another branch"}
            value={baseBranch}
            disabled={blocked || comparisonLoading}
            onChange={(event) => {
              setComparison(null);
              setBaseBranch(event.target.value);
            }}
          >
            <option value="">HEAD</option>
            {branches.filter((branch) => !branch.current).map((branch) => (
              <option key={branch.name} value={branch.name}>{branch.name}</option>
            ))}
          </select>
          {comparisonLoading ? <XiaoIcon className="spin" name="pending" size={12} /> : null}
          {git.workspaceScoped && <small>workspace scope</small>}
        </div>
        <div className="changes-review__totals">
          <span className="is-add">+{visibleGit?.changes.reduce((sum, change) => sum + change.additions, 0) ?? 0}</span>
          <span className="is-delete">-{visibleGit?.changes.reduce((sum, change) => sum + change.deletions, 0) ?? 0}</span>
        </div>
        <button className="icon-button" type="button" aria-label="Refresh changes" disabled={blocked} onClick={onRefresh}><XiaoIcon name="refresh" size={14} /></button>
      </header>

      {comparisonLoading ? (
        <div className="changes-review__state"><XiaoIcon className="spin" name="pending" size={18} /><strong>Comparing branches</strong><p>Reading changes against {baseBranch} without checking it out.</p></div>
      ) : comparisonError ? (
        <div className="changes-review__state is-error"><XiaoIcon name="close" size={18} /><strong>Comparison unavailable</strong><p>{comparisonError}</p></div>
      ) : visibleGit?.changes.length ? (
        <div className="changes-review__workspace">
          <aside className="change-file-browser">
            <label><XiaoIcon name="search" size={14} /><input value={query} placeholder="Filter changed files" onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear change filter"><XiaoIcon name="close" size={11} /></button>}</label>
            <div className="change-file-browser__list">
              {filteredChanges.map((change) => (
                <button className={change.path === selectedChange?.path ? "is-active" : undefined} key={change.path} title={change.path} onClick={() => setSelectedPath(change.path)}>
                  <span className={`change-file-browser__status is-${change.status}`}>{change.status[0].toUpperCase()}</span>
                  <FileTypeIcon path={change.path} size={15} />
                  <span className="change-file-browser__path"><small>{directory(change.path)}</small><strong>{fileName(change.path)}</strong></span>
                  <span className="change-file-browser__stats"><b>+{change.additions}</b><em>-{change.deletions}</em></span>
                </button>
              ))}
              {!filteredChanges.length && <p>No files match “{query}”.</p>}
            </div>
            <footer>
              <span>{filteredChanges.length} of {visibleGit.changes.length} files</span>
              {comparisonMode ? <span>Read only</span> : <button type="button" disabled={blocked} onClick={() => void runAction("stage-all")}>Stage all</button>}
            </footer>
          </aside>

          <main className="change-diff-viewer">
            {selectedChange ? (
              <>
                <header>
                  <div className="change-diff-viewer__file"><FileTypeIcon path={selectedChange.path} size={15} /><span><strong>{selectedChange.path}</strong><small>{selectedChange.status}{selectedChange.patchTruncated ? " · truncated" : ""}</small></span></div>
                  <div>
                    {comparisonMode ? <span className="change-diff-viewer__readonly">Compared with {baseBranch}</span> : (
                      <>
                        <button type="button" disabled={blocked} onClick={() => void runAction("stage", [selectedChange.path])}>Stage</button>
                        <button type="button" disabled={blocked} onClick={() => void runAction("unstage", [selectedChange.path])}>Unstage</button>
                        <button className="is-danger" type="button" disabled={blocked || selectedChange.status === "untracked"} onClick={() => window.confirm(`Discard changes in ${selectedChange.path}?`) && void runAction("discard", [selectedChange.path])}>Discard</button>
                      </>
                    )}
                  </div>
                </header>
                <code className="change-diff-viewer__code">
                  {selectedChange.patch ? selectedChange.patch.split("\n").map((line, index) => (
                    <span className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-delete" : line.startsWith("@@") ? "diff-hunk" : "diff-context"} key={`${index}-${line}`}>
                      <i>{index + 1}</i><b>{line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : ""}</b>{line || " "}
                    </span>
                  )) : <span className="diff-context"><i /><b />No textual patch is available.</span>}
                </code>
              </>
            ) : null}
          </main>
        </div>
      ) : (
        <div className="changes-review__clean"><span><XiaoIcon name="check" size={22} /></span><strong>{comparisonMode ? "Branches match" : "Working tree is clean"}</strong><p>{comparisonMode ? `No changes against ${baseBranch} in this workspace scope.` : "No changes in this workspace scope."}</p></div>
      )}

      <details className="repository-drawer">
        <summary><span><XiaoIcon name="branch" size={14} /><strong>Repository actions</strong></span><small>{worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}</small><XiaoIcon name="caret" size={12} /></summary>
        <div>
          <section><label htmlFor="xiao-commit-message">Commit staged changes</label><div><input id="xiao-commit-message" value={commitMessage} placeholder="Commit message" onChange={(event) => setCommitMessage(event.target.value)} /><button className="button button--primary" disabled={blocked || !commitMessage.trim()} onClick={() => void runAction("commit", [], commitMessage)}>Commit</button></div></section>
          <section><label htmlFor="xiao-branch-name">Branch or manual worktree (not Xiao-managed)</label><div><input id="xiao-branch-name" value={branchName} placeholder="Branch name" onChange={(event) => setBranchName(event.target.value)} /><button className="button button--quiet" disabled={blocked || !branchName.trim() || workspace.execution.workspaceMode === "managed-worktree"} title={workspace.execution.workspaceMode === "managed-worktree" ? "Branch switching is disabled in Xiao-managed worktrees" : undefined} onClick={() => void runAction("switch", [], branchName)}>Switch</button></div><div><input value={worktreePath} placeholder="New worktree path" onChange={(event) => setWorktreePath(event.target.value)} /><button className="button button--quiet" disabled={blocked || !branchName.trim() || !worktreePath.trim()} onClick={() => void createWorktree()}>Add</button></div></section>
          <button
            className="repository-drawer__pr"
            disabled={blocked || !taskId}
            title={taskId ? undefined : "Create a task before opening a pull request"}
            onClick={() => void createDraftPr()}
          ><XiaoIcon name="external" size={13} />Create draft pull request</button>
          {actionError && <p className="rail-error">{actionError}</p>}
          {actionResult && <p className="git-action-result">{actionResult}</p>}
          {worktrees.length > 0 && <div className="worktree-list"><strong>Git worktrees · unowned</strong>{worktrees.map((item) => <span key={item.path}><b>{item.branch}</b><small>{item.path}{item.isMain ? " · main" : ""}</small></span>)}</div>}
        </div>
      </details>
    </section>
  );
}
