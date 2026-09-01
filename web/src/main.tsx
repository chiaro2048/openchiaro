import { useEffect, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";

import { CanvasPane } from "./CanvasPane";
import { createTopic, loadHealth, loadTopics } from "./bridge";
import type { HubHealth } from "./bridge";
import { SettingsPanel } from "./SettingsPanel";
import { readSettings, SETTINGS, writeSetting } from "./settings.mjs";
import type { SettingValue, SettingsValues } from "./settings.mjs";
import { TerminalPanel } from "./TerminalPanel";
import "./styles.css";

const SIDEBAR_STORAGE_KEY = "adw.sidebar.width";
const DEFAULT_SIDEBAR_WIDTH = 380;
const MIN_SIDEBAR_WIDTH = 280;
const BUILD_VERSION = __CHIARO_BUILD_VERSION__;

console.info(`[openchiaro] 前端构建版本 ${BUILD_VERSION}`);

async function checkBuildVersion() {
  if (!import.meta.env.PROD) return;
  const response = await fetch("/build-version.json", { cache: "no-store" });
  const body = await response.json() as { version?: unknown };
  if (!response.ok || body.version !== BUILD_VERSION) {
    throw new Error("前端版本不匹配，请刷新页面");
  }
}

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

function storedSettings() {
  try {
    return readSettings(window.localStorage);
  } catch (error) {
    console.warn("设置读取失败", error);
    return readSettings();
  }
}

const initialSettings = storedSettings();
document.documentElement.dataset.theme = initialSettings.theme;

function App() {
  const [requestedTopic] = useState(() => new URLSearchParams(window.location.search).get("topic"));
  const [hubIdentity, setHubIdentity] = useState<{
    error?: string;
    checked: boolean;
  }>({ checked: false });
  const [health, setHealth] = useState<HubHealth | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [topicError, setTopicError] = useState("");
  const [focusLabels, setFocusLabels] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settings, setSettings] = useState<SettingsValues>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadHealth(), loadTopics(), checkBuildVersion()]).then(([health, catalog]) => {
      if (cancelled) return;
      if (requestedTopic !== null && catalog.topics.length > 0
          && !catalog.topics.includes(requestedTopic)) {
        throw new Error(`topic 不存在：${requestedTopic}`);
      }
      const selected = requestedTopic !== null && catalog.topics.includes(requestedTopic)
        ? requestedTopic
        : (catalog.topics.includes(health.topic) ? health.topic : catalog.topics[0] || "");
      setTopics(catalog.topics);
      setTopic(selected);
      setHealth(health);
      setHubIdentity({ checked: true });
    }).catch((error) => {
      if (!cancelled) setHubIdentity({ error: error.message, checked: true });
    });
    return () => { cancelled = true; };
  }, [requestedTopic]);

  useEffect(() => {
    document.title = !hubIdentity.checked
      ? "正在验证 Hub · openchiaro"
      : hubIdentity.error
        ? "Hub 身份异常 · openchiaro"
        : topic ? `${topic} · openchiaro` : "openchiaro";
  }, [hubIdentity, topic]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

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

  const changeSetting = (id: string, value: SettingValue) => {
    const definition = SETTINGS.find((setting) => setting.id === id);
    if (!definition) return;
    setSettings((current) => {
      let next = value;
      try {
        next = writeSetting(window.localStorage, definition, value);
      } catch (error) {
        console.warn(`设置保存失败：${definition.key}`, error);
      }
      return { ...current, [id]: next };
    });
  };

  const changeSettingBy = (id: string, delta: number) => {
    const definition = SETTINGS.find((setting) => setting.id === id);
    if (!definition) return;
    setSettings((current) => {
      const currentValue = current[id];
      if (typeof currentValue !== "number") return current;
      let next: SettingValue = currentValue + delta;
      try {
        next = writeSetting(window.localStorage, definition, next);
      } catch (error) {
        console.warn(`设置保存失败：${definition.key}`, error);
      }
      return { ...current, [id]: next };
    });
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

  const selectTopic = (nextTopic: string) => {
    setFocusLabels([]);
    setTopic(nextTopic);
    window.history.replaceState(null, "", `/?topic=${encodeURIComponent(nextTopic)}`);
  };

  const submitTopic = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = newTopic.trim();
    if (!candidate) return;
    setCreatingTopic(true);
    try {
      const created = await createTopic(candidate);
      setTopics(created.topics);
      setNewTopic("");
      setTopicError("");
      selectTopic(created.topic);
    } catch (error) {
      setTopicError(`新建画布失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreatingTopic(false);
    }
  };

  if (!hubIdentity.checked) {
    return <main className="app-shell"><div className="hub-identity-check">正在验证 Hub 身份…</div></main>;
  }
  if (hubIdentity.error) {
    return (
      <main className="app-shell">
        <div className="hub-identity-error" role="alert">
          Hub 初始化失败：{hubIdentity.error}
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="canvas-shell">
        <header className="topic-bar">
          <label>
            画布
            <select
              aria-label="当前画布"
              disabled={topics.length === 0}
              onChange={(event) => selectTopic(event.target.value)}
              value={topic}
            >
              {topics.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button
            aria-label="打开设置"
            className="settings-trigger"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            type="button"
          >
            ⚙
          </button>
        </header>
        {topic ? (
          <CanvasPane
            key={topic}
            onApiReady={() => {}}
            onFocusChange={setFocusLabels}
            theme={settings.theme}
            topic={topic}
          />
        ) : (
          <section className="topic-empty">
            <strong>这个 project 还没有画布</strong>
            <form onSubmit={(event) => void submitTopic(event)}>
              <label>
                新建画布
                <input
                  aria-label="新建画布"
                  autoFocus
                  disabled={creatingTopic}
                  onChange={(event) => setNewTopic(event.target.value)}
                  placeholder="workbench"
                  required
                  value={newTopic}
                />
              </label>
              <button disabled={creatingTopic} type="submit">
                {creatingTopic ? "正在新建…" : "新建并打开"}
              </button>
            </form>
            {topicError && <p role="alert">{topicError}</p>}
          </section>
        )}
      </section>
      {topic && (
        <TerminalPanel
          collapsed={sidebarCollapsed}
          focusLabels={focusLabels}
          fontSize={settings.terminalFontSize}
          key={topic}
          onResetWidth={() => setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH))}
          onResizeBy={resizeSidebarBy}
          onResizeStart={startSidebarResize}
          onFontZoom={(delta) => changeSettingBy("terminalFontSize", delta)}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          theme={settings.theme}
          topic={topic}
          width={sidebarWidth}
        />
      )}
      {settingsOpen && health && (
        <SettingsPanel
          buildVersion={BUILD_VERSION}
          health={health}
          onChange={changeSetting}
          onClose={() => setSettingsOpen(false)}
          topic={topic}
          values={settings}
        />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("页面缺少 #root 容器");
createRoot(root).render(<App />);
