import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type { SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";

type TerminalPanelProps = {
  active: boolean;
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  system: SystemInfo;
  transitioning: boolean;
};

type TerminalOutput = { sessionId: string; data: string };
type TerminalExit = { sessionId: string; exitCode: number | null; error: string | null };
type TerminalStatus = "error" | "exited" | "ready" | "starting";

const readTerminalTheme = (): ITheme => {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--code-surface"),
    foreground: token("--text-soft"),
    cursor: token("--success"),
    cursorAccent: token("--code-surface"),
    selectionBackground: token("--surface-strong"),
    black: token("--text"),
    red: token("--danger"),
    green: token("--success"),
    yellow: "#a87627",
    blue: token("--info"),
    magenta: "#8f6abb",
    cyan: "#3a8e91",
    white: token("--text-soft"),
    brightBlack: token("--muted"),
    brightRed: token("--danger"),
    brightGreen: token("--success"),
    brightYellow: "#c4933e",
    brightBlue: token("--info"),
    brightMagenta: "#aa84cf",
    brightCyan: "#58aaad",
    brightWhite: token("--text"),
  };
};

const shellName = (shell: string) => shell.split(/[\\/]/).filter(Boolean).at(-1) ?? shell;

export function TerminalPanel({
  active,
  workspace,
  taskId,
  system,
  transitioning,
}: TerminalPanelProps) {
  const [restartKey, setRestartKey] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const fitTerminal = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!terminal || !fitAddon || !host || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fitAddon.fit();
      const sessionId = sessionIdRef.current;
      if (sessionId && terminal.cols > 0 && terminal.rows > 0) {
        void nativeBridge.resizeTerminal(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
      }
    } catch {
      // The next resize or tab activation will retry once the host has dimensions.
    }
  };

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (transitioning) {
      setStatus("exited");
      setError("Terminal paused while the task execution root changes.");
      return;
    }

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: readTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setStatus("starting");
    setError(null);

    let disposed = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;

    const dataSubscription = terminal.onData((data) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      void nativeBridge.writeTerminal(activeSessionId, data).catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });
    const resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const start = async () => {
      if (!isTauriHost()) {
        setStatus("error");
        setError("Interactive terminal is available in the Xiao desktop app.");
        return;
      }
      try {
        const removeOutputListener = await listen<TerminalOutput>("terminal://output", (event) => {
          if (event.payload.sessionId === sessionId) terminal.write(event.payload.data);
        });
        if (disposed) {
          removeOutputListener();
          return;
        }
        outputUnlisten = removeOutputListener;
        const removeExitListener = await listen<TerminalExit>("terminal://exit", (event) => {
          if (event.payload.sessionId !== sessionId || disposed) return;
          sessionIdRef.current = null;
          if (event.payload.error) {
            setError(event.payload.error);
            setStatus("error");
          } else {
            setStatus("exited");
            terminal.writeln(`\r\n\x1b[2m[process exited ${event.payload.exitCode ?? ""}]\x1b[0m`);
          }
        });
        if (disposed) {
          removeExitListener();
          return;
        }
        exitUnlisten = removeExitListener;
        const proposed = fitAddon.proposeDimensions();
        await nativeBridge.startTerminal(
          sessionId,
          workspace.path,
          taskId,
          system.shell,
          proposed?.cols ?? 100,
          proposed?.rows ?? 30,
        );
        if (disposed) {
          void nativeBridge.stopTerminal(sessionId).catch(() => undefined);
          return;
        }
        setStatus("ready");
        fitTerminal();
        if (active) terminal.focus();
      } catch (reason) {
        if (disposed) return;
        sessionIdRef.current = null;
        void nativeBridge.stopTerminal(sessionId).catch(() => undefined);
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setStatus("error");
        terminal.writeln(`\x1b[31m${message}\x1b[0m`);
      }
    };
    void start();

    return () => {
      disposed = true;
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId === sessionId) {
        sessionIdRef.current = null;
        void nativeBridge.stopTerminal(sessionId).catch(() => undefined);
      }
      outputUnlisten?.();
      exitUnlisten?.();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    restartKey,
    system.shell,
    taskId,
    transitioning,
    workspace.execution.executionRoot,
    workspace.path,
  ]);

  return (
    <section className="shell-workspace shell-workspace--pty">
      <header className="shell-workspace__header">
        <div className="shell-workspace__lights"><i /><i /><i /></div>
        <div><strong>{workspace.name}</strong><small>{shellName(system.shell)}</small></div>
        <div className="shell-workspace__actions">
          <span className={`shell-workspace__status is-${status}`}><i />{status}</span>
          <button type="button" disabled={transitioning} onClick={() => terminalRef.current?.clear()}>Clear</button>
          <button type="button" disabled={transitioning} title="Restart terminal" onClick={() => setRestartKey((key) => key + 1)}>
            <XiaoIcon name="refresh" size={12} />
          </button>
        </div>
      </header>
      <div className="shell-workspace__path" title={workspace.execution.executionRoot}>
        <XiaoIcon name="folderOpen" size={12} />
        <span>{workspace.execution.executionRoot}</span>
      </div>
      <div className="shell-terminal" ref={hostRef} onMouseDown={() => terminalRef.current?.focus()} />
      <footer>
        <span>Interactive PTY · {shellName(system.shell)}</span>
        <span>{error ?? "Ctrl+C to interrupt · scrollback 10k"}</span>
      </footer>
    </section>
  );
}
