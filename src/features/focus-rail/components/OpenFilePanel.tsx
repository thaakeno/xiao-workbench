import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { AgentAttachment } from "../../../core/models/agent";
import type { FileNode, WorkspaceSnapshot } from "../../../core/models/workspace";

type OpenFilePanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  loading: boolean;
  activeFile: string | null;
  onActiveFileChange: (path: string | null) => void;
  onLoadDirectory: (path: string) => Promise<FileNode[]>;
  reviewContext: AgentAttachment[];
  onStageReviewContext: (attachment: AgentAttachment) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
};

type TreeNodeProps = {
  node: FileNode;
  depth?: number;
  query: string;
  activeFile: string | null;
  childrenByPath: Map<string, FileNode[]>;
  loadingPaths: Set<string>;
  onLoad: (node: FileNode) => Promise<void>;
  onOpen: (node: FileNode) => void;
};

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const nodeMatches = (node: FileNode, query: string, childrenByPath: Map<string, FileNode[]>): boolean => {
  if (!query) return true;
  if (`${node.name} ${node.path}`.toLowerCase().includes(query)) return true;
  const children = childrenByPath.get(node.path) ?? node.children;
  return children.some((child) => nodeMatches(child, query, childrenByPath));
};

function TreeNode({
  node,
  depth = 0,
  query,
  activeFile,
  childrenByPath,
  loadingPaths,
  onLoad,
  onOpen,
}: TreeNodeProps) {
  const directory = node.kind === "directory";
  const [open, setOpen] = useState(Boolean(query) || depth < 1);
  const children = childrenByPath.get(node.path) ?? node.children;
  const visibleChildren = children.filter((child) => nodeMatches(child, query, childrenByPath));

  useEffect(() => {
    if (!directory || !open || childrenByPath.has(node.path) || node.children.length > 0) return;
    void onLoad(node);
  }, [childrenByPath, directory, node, onLoad, open]);

  useEffect(() => {
    if (query) setOpen(true);
  }, [query]);

  if (!nodeMatches(node, query, childrenByPath)) return null;

  return (
    <div className="open-file-tree__node">
      <button
        className={activeFile === node.path ? "is-active" : undefined}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        type="button"
        onClick={() => {
          if (!directory) {
            onOpen(node);
            return;
          }
          setOpen((value) => !value);
        }}
      >
        {directory ? (
          <XiaoIcon className={open ? "is-open" : ""} name="caret" size={11} />
        ) : (
          <span className="open-file-tree__indent" />
        )}
        {directory ? (
          <XiaoIcon name={open ? "folderOpen" : "folder"} size={14} />
        ) : (
          <FileTypeIcon path={node.path} size={15} />
        )}
        <span className="open-file-tree__label">{node.name}</span>
        {loadingPaths.has(node.path) && <XiaoIcon className="is-spinning" name="pending" size={11} />}
      </button>
      {directory && open && visibleChildren.length > 0 ? (
        <div>
          {visibleChildren.map((child) => (
            <TreeNode
              activeFile={activeFile}
              childrenByPath={childrenByPath}
              depth={depth + 1}
              key={child.path}
              loadingPaths={loadingPaths}
              node={child}
              query={query}
              onLoad={onLoad}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const highlightLine = (line: string, extension: string): ReactNode => {
  if (/^(?:md|mdx)$/i.test(extension) && /^\s*#{1,6}\s/.test(line)) {
    return <span className="syntax-heading">{line}</span>;
  }
  const pattern = /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|return|switch|throw|true|try|type|undefined|while)\b|\b\d+(?:\.\d+)?\b)/g;
  return line.split(pattern).map((part, index) => {
    if (!part) return null;
    const className =
      /^(?:\/\/|#)/.test(part)
        ? "syntax-comment"
        : /^["'`]/.test(part)
          ? "syntax-string"
          : /^\d/.test(part)
            ? "syntax-number"
            : /^(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|return|switch|throw|true|try|type|undefined|while)$/.test(part)
              ? "syntax-keyword"
              : undefined;
    return className ? <span className={className} key={`${index}-${part}`}>{part}</span> : part;
  });
};

export function OpenFilePanel({
  workspace,
  taskId,
  loading,
  activeFile,
  onActiveFileChange,
  onLoadDirectory,
  reviewContext,
  onStageReviewContext,
  onRemoveReviewContext,
}: OpenFilePanelProps) {
  const [childrenByPath, setChildrenByPath] = useState(new Map<string, FileNode[]>());
  const [loadingPaths, setLoadingPaths] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [comment, setComment] = useState("");
  const [stagedNotice, setStagedNotice] = useState<string | null>(null);
  const [visibleLines, setVisibleLines] = useState(1200);
  const executionRootRef = useRef(workspace.execution.executionRoot);
  const fileRequestId = useRef(0);

  const lines = useMemo(() => content?.replace(/\r\n?/g, "\n").split("\n") ?? [], [content]);
  const extension = activeFile?.split(".").at(-1) ?? "text";

  useEffect(() => {
    executionRootRef.current = workspace.execution.executionRoot;
    fileRequestId.current += 1;
    setChildrenByPath(new Map());
    setLoadingPaths(new Set());
    setQuery("");
    setContent(null);
    setError(null);
    setTreeError(null);
    setSelection(null);
    setStagedNotice(null);
    setVisibleLines(1200);
    onActiveFileChange(null);
  }, [onActiveFileChange, taskId, workspace.execution.executionRoot]);

  const loadNode = async (node: FileNode) => {
    if (childrenByPath.has(node.path) || loadingPaths.has(node.path)) return;
    const executionRoot = workspace.execution.executionRoot;
    setLoadingPaths((current) => new Set(current).add(node.path));
    setTreeError(null);
    try {
      const children = await onLoadDirectory(node.path);
      if (executionRootRef.current !== executionRoot) return;
      setChildrenByPath((current) => new Map(current).set(node.path, children));
    } catch (reason) {
      if (executionRootRef.current !== executionRoot) return;
      setTreeError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (executionRootRef.current === executionRoot) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(node.path);
          return next;
        });
      }
    }
  };

  const openFile = async (node: FileNode) => {
    const requestId = ++fileRequestId.current;
    const executionRoot = workspace.execution.executionRoot;
    onActiveFileChange(node.path);
    setFileLoading(true);
    setContent(null);
    setError(null);
    setSelection(null);
    setComment("");
    setStagedNotice(null);
    setVisibleLines(1200);
    try {
      const nextContent = await nativeBridge.readWorkspaceFile(workspace.path, taskId, node.path);
      if (requestId !== fileRequestId.current || executionRootRef.current !== executionRoot) return;
      setContent(nextContent);
    } catch (reason) {
      if (requestId !== fileRequestId.current || executionRootRef.current !== executionRoot) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === fileRequestId.current) setFileLoading(false);
    }
  };

  const closeFile = () => {
    fileRequestId.current += 1;
    setFileLoading(false);
    setContent(null);
    setError(null);
    setSelection(null);
    setStagedNotice(null);
    onActiveFileChange(null);
  };

  const selectLine = (line: number, extend: boolean) => {
    setSelection((current) => {
      if (!extend || !current) return { start: line, end: line };
      return { start: Math.min(current.start, line), end: Math.max(current.end, line) };
    });
    setComment("");
    setStagedNotice(null);
  };

  const stageComment = () => {
    if (!activeFile || !selection || !comment.trim()) return;
    const preview = lines
      .slice(selection.start - 1, selection.end)
      .map((line, index) => `${selection.start + index} | ${line}`)
      .join("\n");
    onStageReviewContext({
      id: crypto.randomUUID(),
      name: `${fileName(activeFile)}:${selection.start}`,
      path: activeFile,
      kind: "review",
      lineStart: selection.start,
      lineEnd: selection.end,
      comment: comment.trim(),
      preview,
    });
    setStagedNotice(`${fileName(activeFile)}:${selection.start}${selection.end !== selection.start ? `-${selection.end}` : ""} added to the prompt`);
    setComment("");
    setSelection(null);
  };

  return (
    <section className={`open-file-panel ${activeFile ? "has-active-file" : ""}`}>
      <aside className="open-file-browser">
        <header>
          <strong>{workspace.name}</strong>
          <small>{workspace.execution.executionRoot}</small>
        </header>
        <label className="open-file-search">
          <XiaoIcon name="search" size={14} />
          <input
            autoFocus={!activeFile}
            value={query}
            placeholder="Filter files"
            aria-label="Filter files"
            onChange={(event) => setQuery(event.target.value.toLowerCase())}
          />
          {query && <button type="button" aria-label="Clear file filter" onClick={() => setQuery("")}><XiaoIcon name="close" size={12} /></button>}
        </label>
        <div className="open-file-tree">
          {treeError && <p className="open-file-tree__error">{treeError}</p>}
          {loading ? (
            <div className="file-skeleton"><span /><span /><span /><span /></div>
          ) : workspace.files.length ? (
            workspace.files.map((node) => (
              <TreeNode
                activeFile={activeFile}
                childrenByPath={childrenByPath}
                key={node.path}
                loadingPaths={loadingPaths}
                node={node}
                query={query}
                onLoad={loadNode}
                onOpen={(file) => void openFile(file)}
              />
            ))
          ) : (
            <div className="rail-empty rail-empty--compact"><strong>No visible files</strong><p>This workspace is empty.</p></div>
          )}
        </div>
      </aside>

      <div className="open-file-editor">
        {!activeFile ? (
          <div className="open-file-editor__empty">
            <span><XiaoIcon name="folderOpen" size={25} /></span>
            <strong>Open a file</strong>
            <p>Select a file to read it and attach line comments to Xiao.</p>
          </div>
        ) : fileLoading ? (
          <div className="open-file-editor__empty" role="status"><XiaoIcon className="is-spinning" name="pending" size={20} /><strong>Reading file</strong></div>
        ) : error ? (
          <div className="open-file-editor__empty" role="alert"><XiaoIcon name="file" size={22} /><strong>Preview unavailable</strong><p>{error}</p></div>
        ) : (
          <>
            <header className="open-file-editor__header">
              <div>
                <button className="open-file-editor__back" type="button" aria-label="Show files" onClick={closeFile}><XiaoIcon name="sidebar" size={13} /></button>
                <FileTypeIcon path={activeFile} size={15} /><strong>{activeFile}</strong>
              </div>
              <small>{numberWithUnit(lines.length, "line")}</small>
            </header>
            {stagedNotice && <div className="open-file-editor__notice"><XiaoIcon name="check" size={13} />{stagedNotice}</div>}
            <div className="code-reader" role="region" aria-label={`Contents of ${activeFile}`}>
              {lines.slice(0, visibleLines).map((line, index) => {
                const lineNumber = index + 1;
                const selected = selection && lineNumber >= selection.start && lineNumber <= selection.end;
                const commentAfter = selection && lineNumber === selection.end;
                const stagedComments = reviewContext.filter(
                  (attachment) =>
                    attachment.kind === "review" &&
                    attachment.path === activeFile &&
                    (attachment.lineEnd ?? attachment.lineStart) === lineNumber,
                );
                return (
                  <div className="code-reader__group" key={lineNumber}>
                    <div className={`code-reader__line ${selected ? "is-selected" : ""}`}>
                      <button
                        className="code-reader__comment"
                        type="button"
                        aria-label={`Comment on line ${lineNumber}`}
                        onClick={() => selectLine(lineNumber, false)}
                      >+</button>
                      <button
                        className="code-reader__number"
                        type="button"
                        onClick={(event) => selectLine(lineNumber, event.shiftKey)}
                      >{lineNumber}</button>
                      <code onClick={(event) => selectLine(lineNumber, event.shiftKey)}>{highlightLine(line, extension) || " "}</code>
                    </div>
                    {stagedComments.map((staged) => (
                      <article className="staged-line-comment" key={staged.id}>
                        <span><XiaoIcon name="check" size={12} /></span>
                        <div><strong>Staged for Xiao</strong><p>{staged.comment}</p></div>
                        <button type="button" aria-label="Remove staged line comment" onClick={() => staged.id && onRemoveReviewContext(staged.id)}><XiaoIcon name="close" size={12} /></button>
                      </article>
                    ))}
                    {commentAfter && (
                      <form className="line-comment" onSubmit={(event) => { event.preventDefault(); stageComment(); }}>
                        <label htmlFor="xiao-line-comment">Comment</label>
                        <textarea
                          id="xiao-line-comment"
                          autoFocus
                          rows={3}
                          value={comment}
                          placeholder="Tell Xiao what should change"
                          onChange={(event) => setComment(event.target.value)}
                          onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") stageComment();
                            if (event.key === "Escape") setSelection(null);
                          }}
                        />
                        <footer>
                          <small>line {selection.start}{selection.end !== selection.start ? `-${selection.end}` : ""}</small>
                          <button type="button" onClick={() => setSelection(null)}>Cancel</button>
                          <button className="button button--primary" type="submit" disabled={!comment.trim()}>Comment</button>
                        </footer>
                      </form>
                    )}
                  </div>
                );
              })}
              {lines.length > visibleLines && (
                <button className="code-reader__more" type="button" onClick={() => setVisibleLines((count) => count + 1200)}>
                  Show {Math.min(1200, lines.length - visibleLines).toLocaleString()} more lines
                  <small>{(lines.length - visibleLines).toLocaleString()} remaining</small>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const numberWithUnit = (value: number, unit: string) => `${new Intl.NumberFormat().format(value)} ${unit}${value === 1 ? "" : "s"}`;
