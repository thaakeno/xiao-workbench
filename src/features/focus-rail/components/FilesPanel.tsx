import { useEffect, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { FileNode, WorkspaceSnapshot } from "../../../core/models/workspace";

type FilesPanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  loading: boolean;
  onLoadDirectory: (path: string) => Promise<FileNode[]>;
};

type FileTreeNodeProps = {
  node: FileNode;
  depth?: number;
  childrenByPath: Map<string, FileNode[]>;
  loadingPaths: Set<string>;
  errorsByPath: Map<string, string>;
  onToggle: (node: FileNode) => Promise<void>;
  onOpenFile: (node: FileNode) => void;
};

function FileTreeNode({
  node,
  depth = 0,
  childrenByPath,
  loadingPaths,
  errorsByPath,
  onToggle,
  onOpenFile,
}: FileTreeNodeProps) {
  const [open, setOpen] = useState(depth < 1);
  const directory = node.kind === "directory";
  const children = childrenByPath.get(node.path) ?? node.children;
  const loading = loadingPaths.has(node.path);
  const error = errorsByPath.get(node.path);

  useEffect(() => {
    if (directory && open && !childrenByPath.has(node.path)) void onToggle(node);
  }, [childrenByPath, directory, node, onToggle, open]);

  return (
    <div className="file-node">
      <button
        className="file-node__row"
        style={{ paddingLeft: `${10 + depth * 15}px` }}
        onClick={() => directory ? setOpen((value) => !value) : onOpenFile(node)}
      >
        {directory ? (
          <XiaoIcon className={open ? "is-open" : ""} name="caret" size={11} />
        ) : (
          <span className="file-node__space" />
        )}
        {directory ? (
          open ? <XiaoIcon name="folderOpen" size={15} /> : <XiaoIcon name="folder" size={15} />
        ) : (
          <XiaoIcon name="file" size={15} />
        )}
        <span>{node.name}{loading ? " …" : ""}</span>
      </button>
      {directory && open && children.length > 0 && (
        <div>
          {children.map((child) => (
            <FileTreeNode
              node={child}
              depth={depth + 1}
              key={child.path}
              childrenByPath={childrenByPath}
              loadingPaths={loadingPaths}
              errorsByPath={errorsByPath}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
      {directory && open && error && (
        <p className="file-node__error" style={{ paddingLeft: `${31 + depth * 15}px` }}>{error}</p>
      )}
    </div>
  );
}

export function FilesPanel({ workspace, taskId, loading, onLoadDirectory }: FilesPanelProps) {
  const [childrenByPath, setChildrenByPath] = useState(new Map<string, FileNode[]>());
  const [loadingPaths, setLoadingPaths] = useState(new Set<string>());
  const [errorsByPath, setErrorsByPath] = useState(new Map<string, string>());
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    setChildrenByPath(new Map());
    setLoadingPaths(new Set());
    setErrorsByPath(new Map());
    setPreview(null);
    setPreviewError(null);
  }, [workspace.path]);

  const loadNode = async (node: FileNode) => {
    if (childrenByPath.has(node.path) || loadingPaths.has(node.path)) return;
    setLoadingPaths((current) => new Set(current).add(node.path));
    setErrorsByPath((current) => {
      const next = new Map(current);
      next.delete(node.path);
      return next;
    });
    try {
      const children = await onLoadDirectory(node.path);
      setChildrenByPath((current) => new Map(current).set(node.path, children));
    } catch (reason) {
      setErrorsByPath((current) =>
        new Map(current).set(node.path, reason instanceof Error ? reason.message : String(reason)),
      );
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(node.path);
        return next;
      });
    }
  };

  const openFile = async (node: FileNode) => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview({
        path: node.path,
        content: await nativeBridge.readWorkspaceFile(workspace.path, taskId, node.path),
      });
    } catch (reason) {
      setPreview(null);
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <section className="rail-section rail-section--flush">
      <header className="rail-section__header rail-section__header--padded">
        <div>
          <span>Workspace</span>
          <h2>{workspace.name}</h2>
        </div>
        <XiaoIcon name="folderOpen" size={20} />
      </header>

      <p className="workspace-path">{workspace.execution.executionRoot}</p>
      {loading ? (
        <div className="file-skeleton" aria-label="Loading files">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : workspace.files.length > 0 ? (
        <div className="file-tree">
          {workspace.files.map((node) => (
            <FileTreeNode
              node={node}
              key={node.path}
              childrenByPath={childrenByPath}
              loadingPaths={loadingPaths}
              errorsByPath={errorsByPath}
              onToggle={loadNode}
              onOpenFile={(node) => void openFile(node)}
            />
          ))}
        </div>
      ) : (
        <div className="rail-empty">
          <XiaoIcon name="folder" size={24} />
          <strong>No visible files</strong>
          <p>Add a workspace with source files to populate this view.</p>
        </div>
      )}
      {(preview || previewLoading || previewError) && (
        <div className="file-preview">
          <header>
            <strong>{preview?.path ?? "Preview"}</strong>
            <button className="icon-button" aria-label="Close preview" onClick={() => { setPreview(null); setPreviewError(null); }}>
              <XiaoIcon name="close" size={13} />
            </button>
          </header>
          {previewLoading ? <p>Loading preview…</p> : previewError ? <p className="rail-error">{previewError}</p> : <pre>{preview?.content}</pre>}
        </div>
      )}
    </section>
  );
}
