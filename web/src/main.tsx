import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";

import { CanvasPane } from "./CanvasPane";
import { loadHealth } from "./bridge";
import { TerminalPanel } from "./TerminalPanel";
import "./styles.css";

const SIDEBAR_STORAGE_KEY = "adw.sidebar.width";
const DEFAULT_SIDEBAR_WIDTH = 380;
const MIN_SIDEBAR_WIDTH = 280;

function clampSidebarWidth(width: number) {
  const max = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth * 0.6);
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function storedSidebarWidth() {
  try {
    const width = Number(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    return Number.isFinite(width) && width > 0
      ? clampSidebarWidth(width)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch (error) {
    console.warn("侧栏宽度读取失败", error);
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function App() {
  const requestedTopic = new URLSearchParams(window.location.search).get("topic");
  const [hubIdentity, setHubIdentity] = useState<{
    actualTopic?: string;
    error?: string;
    checked: boolean;
  }>({ checked: requestedTopic === null });
  const [focusLabels, setFocusLabels] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadHealth().then(
      ({ topic }) => !cancelled && setHubIdentity({ actualTopic: topic, checked: true }),
      (error) => !cancelled && setHubIdentity({ error: error.message, checked: true }),
    );
    return () => { cancelled = true; };
  }, [requestedTopic]);

  useEffect(() => {
    const identityFailed = hubIdentity.error
      || (requestedTopic !== null && hubIdentity.actualTopic !== requestedTopic);
    const topic = hubIdentity.actualTopic || requestedTopic;
    document.title = !hubIdentity.checked
      ? "正在验证 Hub · openchiaro"
      : identityFailed
        ? "Hub 身份异常 · openchiaro"
        : topic ? `${topic} · openchiaro` : "openchiaro";
  }, [hubIdentity, requestedTopic]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(sidebarWidth)));
    } catch (error) {
      console.warn("侧栏宽度保存失败", error);
    }
  }, [sidebarWidth]);

  const resizeSidebarBy = (delta: number) => {
    setSidebarWidth((current) => clampSidebarWidth(current + delta));
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + startX - moveEvent.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  if (!hubIdentity.checked) {
    return <main className="app-shell"><div className="hub-identity-check">正在验证 Hub 身份…</div></main>;
  }
  if (requestedTopic !== null && (hubIdentity.error || hubIdentity.actualTopic !== requestedTopic)) {
    const actual = hubIdentity.actualTopic || "无法读取";
    return (
      <main className="app-shell">
        <div className="hub-identity-error" role="alert">
          地址请求的 topic 是「{requestedTopic}」，实际 Hub topic 是「{actual}」。
          {hubIdentity.error
            ? `身份校验失败：${hubIdentity.error}`
            : `请打开 /?topic=${encodeURIComponent(actual)}。`}
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <CanvasPane
        onApiReady={() => {}}
        onFocusChange={setFocusLabels}
      />
      <TerminalPanel
        collapsed={sidebarCollapsed}
        focusLabels={focusLabels}
        onResetWidth={() => setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH))}
        onResizeBy={resizeSidebarBy}
        onResizeStart={startSidebarResize}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
        topic={hubIdentity.actualTopic || requestedTopic || "openchiaro"}
        width={sidebarWidth}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("页面缺少 #root 容器");
createRoot(root).render(<App />);
