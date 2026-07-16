import { invoke } from "@tauri-apps/api/core";

import type {
  AgentAccountSummary,
  AgentAccountUsage,
  AgentModelSummary,
  AgentSessionStart,
  AgentThreadTokenUsage,
  XiaoHistoryItem,
} from "../models/agent";
import type {
  CodexUpdateResult,
  CodexUpdateStatus,
  FileNode,
  WorkspaceSnapshot,
  SystemInfo,
} from "../models/workspace";
import type { XiaoProjectSummary, XiaoWorkspaceDocument } from "../models/xiao";

export const isTauriHost = () => "__TAURI_INTERNALS__" in window;

export const nativeBridge = {
  getWorkspace(path?: string) {
    return invoke<WorkspaceSnapshot>("get_workspace_snapshot", { path });
  },

  listWorkspaceFiles(workspacePath: string, relativePath: string) {
    return invoke<FileNode[]>("list_workspace_files", { workspacePath, relativePath });
  },

  getSystemInfo() {
    return invoke<SystemInfo>("get_system_info");
  },

  checkCodexUpdate() {
    return invoke<CodexUpdateStatus>("check_codex_update");
  },

  updateCodexCli() {
    return invoke<CodexUpdateResult>("update_codex_cli");
  },

  startAgent() {
    return invoke<{ version: string; alreadyRunning: boolean }>("start_agent_runtime");
  },

  stopAgent() {
    return invoke<void>("stop_agent_runtime");
  },

  agentRequest<T = Record<string, unknown>>(method: string, params: Record<string, unknown> | null = {}) {
    return invoke<T>("agent_request", { method, params });
  },

  replyToAgent(requestId: number | string, result: Record<string, unknown>) {
    return invoke<void>("agent_reply", { requestId, result });
  },

  readAgentAccount() {
    return invoke<AgentAccountSummary>("read_agent_account");
  },

  readAgentUsage() {
    return invoke<AgentAccountUsage>("read_agent_usage");
  },

  readAgentThreadUsage() {
    return invoke<AgentThreadTokenUsage[]>("read_agent_thread_usage");
  },

  listAgentModels() {
    return invoke<AgentModelSummary[]>("list_agent_models");
  },

  startXiaoSession(
    workspacePath: string,
    model: string | null,
    history: XiaoHistoryItem[],
    threadId: string | null,
    approvalPolicy: string,
    sandbox: string,
  ) {
    return invoke<AgentSessionStart>("start_xiao_session", {
      workspacePath,
      model,
      history,
      threadId,
      approvalPolicy,
      sandbox,
    });
  },

  readWorkspaceFile(workspacePath: string, relativePath: string) {
    return invoke<string>("read_workspace_file", { workspacePath, relativePath });
  },

  mutateGit(
    workspacePath: string,
    action: "commit" | "discard" | "stage" | "stage-all" | "switch" | "unstage",
    paths: string[],
    message?: string,
  ) {
    return invoke<string>("mutate_git", { workspacePath, action, paths, message });
  },

  getGitWorktrees(workspacePath: string) {
    return invoke<Array<{ path: string; branch: string; head: string; isMain: boolean }>>(
      "get_git_worktrees",
      { workspacePath },
    );
  },

  addGitWorktree(workspacePath: string, targetPath: string, branch: string) {
    return invoke<void>("add_git_worktree", { workspacePath, targetPath, branch });
  },

  applyGitPatch(workspacePath: string, patch: string, reverse: boolean, checkOnly: boolean) {
    return invoke<void>("apply_git_patch", { workspacePath, patch, reverse, checkOnly });
  },

  createGitCheckpoint(workspacePath: string) {
    return invoke<string>("create_git_checkpoint", { workspacePath });
  },

  finishGitCheckpoint(workspacePath: string, token: string) {
    return invoke<string>("finish_git_checkpoint", { workspacePath, token });
  },

  discardGitCheckpoint(token: string) {
    return invoke<void>("discard_git_checkpoint", { token });
  },

  startTerminal(
    sessionId: string,
    workspacePath: string,
    shell: string,
    cols: number,
    rows: number,
  ) {
    return invoke<{ sessionId: string; shell: string }>("start_terminal", {
      sessionId,
      workspacePath,
      shell,
      cols,
      rows,
    });
  },

  writeTerminal(sessionId: string, data: string) {
    return invoke<void>("write_terminal", { sessionId, data });
  },

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    return invoke<void>("resize_terminal", { sessionId, cols, rows });
  },

  stopTerminal(sessionId: string) {
    return invoke<void>("stop_terminal", { sessionId });
  },

  navigateBrowser(url: string, label = "xiao-browser") {
    return invoke<void>("navigate_browser", { url, label });
  },

  goBackBrowser(label = "xiao-browser") {
    return invoke<void>("go_back_browser", { label });
  },

  goForwardBrowser(label = "xiao-browser") {
    return invoke<void>("go_forward_browser", { label });
  },

  reloadBrowser(label = "xiao-browser") {
    return invoke<void>("reload_browser", { label });
  },

  getBrowserUrl(label = "xiao-browser") {
    return invoke<string>("get_browser_url", { label });
  },

  setBrowserMuted(label: string, muted: boolean) {
    return invoke<void>("set_browser_muted", { label, muted });
  },

  loadXiaoWorkspace(workspacePath: string) {
    return invoke<XiaoWorkspaceDocument | null>("load_xiao_workspace", { workspacePath });
  },

  saveXiaoWorkspace(document: XiaoWorkspaceDocument) {
    return invoke<void>("save_xiao_workspace", { document });
  },

  listXiaoProjects() {
    return invoke<XiaoProjectSummary[]>("list_xiao_projects");
  },

  openXiaoProject(path: string) {
    return invoke<void>("open_xiao_project", { path });
  },
};
