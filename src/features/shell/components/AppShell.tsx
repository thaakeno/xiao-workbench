import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import "../styles/shell.css";

type AppShellProps = {
  titleBar: ReactNode;
  sidebar: ReactNode;
  content: ReactNode;
  focusRail?: ReactNode;
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
};

const defaultSidebarWidth = 280;
const minSidebarWidth = 210;
const sidebarWidthStorageKey = "xiao.sidebar.width";
const defaultFocusRailWidth = 520;
const minFocusRailWidth = 480;
const minTaskWidth = 450;
const focusRailWidthStorageKey = "xiao.focus-rail.width";

const maxSidebarWidth = () =>
  Math.max(minSidebarWidth, Math.min(460, Math.floor(window.innerWidth * 0.45)));

const clampSidebarWidth = (width: number) =>
  Math.min(maxSidebarWidth(), Math.max(minSidebarWidth, width));

const readSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(sidebarWidthStorageKey));
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : clampSidebarWidth(defaultSidebarWidth);
  } catch {
    return clampSidebarWidth(defaultSidebarWidth);
  }
};

const readFocusRailWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(focusRailWidthStorageKey));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(minFocusRailWidth, stored)
      : defaultFocusRailWidth;
  } catch {
    return defaultFocusRailWidth;
  }
};

export function AppShell({
  titleBar,
  sidebar,
  content,
  focusRail,
  sidebarOpen,
  onCloseSidebar,
}: AppShellProps) {
  const focusRailOpen = Boolean(focusRail);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [focusRailWidth, setFocusRailWidth] = useState(readFocusRailWidth);
  const [focusRailMaxWidth, setFocusRailMaxWidth] = useState(defaultFocusRailWidth);
  const [focusRailOverlay, setFocusRailOverlay] = useState(true);
  const [resizingFocusRail, setResizingFocusRail] = useState(false);
  const sidebarResizeStart = useRef({ pointerX: 0, sidebarWidth: defaultSidebarWidth });
  const sidebarWidthRef = useRef(sidebarWidth);
  const pendingSidebarWidth = useRef(sidebarWidth);
  const sidebarResizeFrame = useRef<number | null>(null);
  const focusRailResizeStart = useRef({ pointerX: 0, focusRailWidth: defaultFocusRailWidth });
  const frameRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const clampFocusRailWidth = (width: number) =>
    Math.min(focusRailMaxWidth, Math.max(minFocusRailWidth, width));

  useEffect(() => {
    if (resizingSidebar) return;
    try {
      window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
    } catch {
      // Keep the resized width for this session when storage is unavailable.
    }
  }, [resizingSidebar, sidebarWidth]);

  useEffect(() => {
    if (resizingFocusRail) return;
    try {
      window.localStorage.setItem(focusRailWidthStorageKey, String(focusRailWidth));
    } catch {
      // Keep the resized width for this session when storage is unavailable.
    }
  }, [focusRailWidth, resizingFocusRail]);

  useEffect(() => {
    const keepWidthInViewport = () => setSidebarWidth((width) => {
      const next = clampSidebarWidth(width);
      sidebarWidthRef.current = next;
      pendingSidebarWidth.current = next;
      return next;
    });
    window.addEventListener("resize", keepWidthInViewport);
    return () => window.removeEventListener("resize", keepWidthInViewport);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeCompactSidebar = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 760px)").matches) {
        onCloseSidebar();
      }
    };
    window.addEventListener("keydown", closeCompactSidebar);
    return () => window.removeEventListener("keydown", closeCompactSidebar);
  }, [onCloseSidebar, sidebarOpen]);

  useEffect(() => {
    if (!resizingSidebar) return;

    const resize = (event: PointerEvent) => {
      pendingSidebarWidth.current = clampSidebarWidth(
        sidebarResizeStart.current.sidebarWidth +
          event.clientX -
          sidebarResizeStart.current.pointerX,
      );
      if (sidebarResizeFrame.current !== null) return;
      sidebarResizeFrame.current = window.requestAnimationFrame(() => {
        sidebarResizeFrame.current = null;
        frameRef.current?.style.setProperty(
          "--sidebar-width",
          `${pendingSidebarWidth.current}px`,
        );
      });
    };
    const stopResizing = () => {
      if (sidebarResizeFrame.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrame.current);
        sidebarResizeFrame.current = null;
      }
      const next = pendingSidebarWidth.current;
      frameRef.current?.style.setProperty("--sidebar-width", `${next}px`);
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
      setResizingSidebar(false);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
    return () => {
      if (sidebarResizeFrame.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrame.current);
        sidebarResizeFrame.current = null;
      }
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
    };
  }, [resizingSidebar]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !focusRailOpen) return;

    const keepFocusRailInWorkspace = () => {
      const overlaysTask =
        window.matchMedia("(max-width: 1040px)").matches ||
        workspace.clientWidth < minTaskWidth + minFocusRailWidth;
      const nextMax = Math.max(
        minFocusRailWidth,
        workspace.clientWidth - (overlaysTask ? 0 : minTaskWidth),
      );
      setFocusRailOverlay(overlaysTask);
      setFocusRailMaxWidth(nextMax);
      setFocusRailWidth((width) => Math.min(nextMax, Math.max(minFocusRailWidth, width)));
    };
    keepFocusRailInWorkspace();
    const observer = new ResizeObserver(keepFocusRailInWorkspace);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [focusRailOpen]);

  useEffect(() => {
    if (!resizingFocusRail) return;

    const resize = (event: PointerEvent) => {
      setFocusRailWidth(
        clampFocusRailWidth(
          focusRailResizeStart.current.focusRailWidth -
            (event.clientX - focusRailResizeStart.current.pointerX),
        ),
      );
    };
    const stopResizing = () => setResizingFocusRail(false);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
    };
  }, [focusRailMaxWidth, resizingFocusRail]);

  return (
    <div
      ref={frameRef}
      className={`app-frame ${resizingSidebar ? "app-frame--resizing-sidebar" : ""} ${
        resizingFocusRail ? "app-frame--resizing-focus-rail" : ""
      }`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--focus-rail-width": `${focusRailWidth}px`,
        } as CSSProperties
      }
    >
      {titleBar}
      <div className={`app-layout ${sidebarOpen ? "" : "app-layout--sidebar-hidden"}`}>
        {sidebar}
        {sidebarOpen ? (
          <button
            className="sidebar-backdrop"
            type="button"
            aria-label="Close navigation"
            onClick={onCloseSidebar}
          />
        ) : null}
        {sidebarOpen ? (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={minSidebarWidth}
            aria-valuemax={maxSidebarWidth()}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onDoubleClick={() => {
              const next = clampSidebarWidth(defaultSidebarWidth);
              sidebarWidthRef.current = next;
              pendingSidebarWidth.current = next;
              setSidebarWidth(next);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = clampSidebarWidth(
                sidebarWidthRef.current + (event.key === "ArrowLeft" ? -10 : 10),
              );
              sidebarWidthRef.current = next;
              pendingSidebarWidth.current = next;
              setSidebarWidth(next);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              sidebarResizeStart.current = {
                pointerX: event.clientX,
                sidebarWidth: sidebarWidthRef.current,
              };
              pendingSidebarWidth.current = sidebarWidthRef.current;
              setResizingSidebar(true);
            }}
          />
        ) : null}
        <div
          className={`app-workspace ${focusRailOpen ? "app-workspace--split" : ""} ${
            focusRailOpen && focusRailOverlay ? "app-workspace--focus-overlay" : ""
          }`}
          ref={workspaceRef}
        >
          <main className="app-content">{content}</main>
          {focusRailOpen ? (
            <div
              className="focus-rail-resizer"
              role="separator"
              aria-label="Resize review panel"
              aria-orientation="vertical"
              aria-valuemin={minFocusRailWidth}
              aria-valuemax={focusRailMaxWidth}
              aria-valuenow={focusRailWidth}
              tabIndex={0}
              onDoubleClick={() =>
                setFocusRailWidth(clampFocusRailWidth(defaultFocusRailWidth))
              }
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setFocusRailWidth((width) =>
                  clampFocusRailWidth(width + (event.key === "ArrowLeft" ? 10 : -10)),
                );
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                focusRailResizeStart.current = { pointerX: event.clientX, focusRailWidth };
                setResizingFocusRail(true);
              }}
            />
          ) : null}
          {focusRail ?? null}
        </div>
      </div>
    </div>
  );
}
