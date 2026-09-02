import React from "react";

import { CanvasPane } from "../../web/src/CanvasPane.tsx";
import { ChiaroApiContext } from "../../web/src/ChiaroApi.ts";
import { SettingsPanel } from "../../web/src/SettingsPanel.tsx";
import { readSettings, SETTINGS, writeSetting } from "../../web/src/settings.mjs";
import { TerminalPanel } from "../../web/src/TerminalPanel.tsx";
import "../../web/src/styles.css";
import { resolveWorkspaceId } from "./canvas-logic.mjs";
import { createDshChiaroApi } from "./chiaro-api.ts";
import "./chunk.css";

const BUILD_VERSION = __CHIARO_BUILD_VERSION__;
const DEFAULT_TERMINAL_WIDTH = 420;
const MIN_TERMINAL_WIDTH = 280;

console.info(`[dsh-openchiaro] 前端构建版本 ${BUILD_VERSION}`);

function storedSettings() {
  try {
    return readSettings(window.localStorage);
  } catch (error) {
    console.warn("Chiaro 设置读取失败", error);
    return readSettings();
  }
}

function storeSetting(setValues, setting, value) {
  setValues((current) => {
    let next = value;
    try {
      next = writeSetting(window.localStorage, setting, value);
    } catch (error) {
      console.warn(`Chiaro 设置保存失败：${setting.key}`, error);
    }
    return { ...current, [setting.id]: next };
  });
}

function useCurrentCwd(ctx) {
  const sessions = React.useSyncExternalStore(
    (notify) => ctx.sessions.list.subscribe(notify),
    () => ctx.sessions.list.getSnapshot(),
  );
  return sessions.current ? sessions.byId[sessions.current]?.cwd : undefined;
}

const topicStorageKey = (workspaceId) => `dsh.openchiaro.topic.${workspaceId}`;

function storedTopic(workspaceId, topics) {
  try {
    const topic = window.localStorage.getItem(topicStorageKey(workspaceId));
    return topics.includes(topic) ? topic : topics[0] || "";
  } catch {
    return topics[0] || "";
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function clampTerminalWidth(width) {
  return Math.min(
    Math.max(MIN_TERMINAL_WIDTH, window.innerWidth * 0.6),
    Math.max(MIN_TERMINAL_WIDTH, width),
  );
}

export function ChiaroSettings({ ctx }) {
  const cwd = useCurrentCwd(ctx);
  const [info, setInfo] = React.useState(null);
  const [values, setValues] = React.useState(storedSettings);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    setInfo(null);
    if (!cwd) {
      setError("当前 DSH 会话没有 workspace 路径");
      return () => controller.abort();
    }
    void (async () => {
      try {
        const [catalog, build] = await Promise.all([
          requestJson("/api/chiaro/health", { signal: controller.signal, cache: "no-store" }),
          requestJson("/chiaro/bundle/build-version.json", {
            signal: controller.signal,
            cache: "no-store",
          }),
        ]);
        const workspaceId = resolveWorkspaceId(catalog.workspaces, cwd);
        const health = catalog.workspaceId === workspaceId
          ? catalog
          : await requestJson(`/api/chiaro/health?workspaceId=${encodeURIComponent(workspaceId)}`, {
            signal: controller.signal,
            cache: "no-store",
          });
        const workspace = health.workspaces.find((item) => item.id === workspaceId);
        const panelHealth = await createDshChiaroApi(workspaceId).loadHealth();
        setInfo({
          buildHash: BUILD_VERSION.split("+", 2)[1] || "开发构建",
          consistent: panelHealth.version === BUILD_VERSION.split("+", 1)[0]
            && build.version === BUILD_VERSION,
          health: panelHealth,
          hostVersion: health.version,
          topic: storedTopic(workspaceId, health.topics),
          workspace,
        });
        setError("");
      } catch (cause) {
        if (cause.name !== "AbortError") setError(`Chiaro 信息读取失败：${cause.message}`);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  return (
    <div className="chiaro-settings-section" data-theme={values.theme}>
      {info && (
        <SettingsPanel
          about={(
            <dl className="settings-about">
              <div><dt>dsh-openchiaro</dt><dd>{info.hostVersion}</dd></div>
              <div><dt>构建哈希</dt><dd>{info.buildHash}</dd></div>
              <div><dt>host / chunk</dt><dd>{info.consistent ? "一致" : "不一致"}</dd></div>
              <div><dt>workspace</dt><dd>{info.workspace?.path || "—"}</dd></div>
              <div><dt>topic</dt><dd>{info.topic || "—"}</dd></div>
            </dl>
          )}
          buildVersion={BUILD_VERSION}
          embedded
          health={info.health}
          onChange={(id, value) => {
            const setting = SETTINGS.find((item) => item.id === id);
            if (setting) storeSetting(setValues, setting, value);
          }}
          topic={info.topic}
          values={values}
        />
      )}
      {error
        ? <p className="chiaro-settings-error" role="alert">{error}</p>
        : !info && <p role="status">正在加载 Chiaro 设置…</p>}
    </div>
  );
}

export function ChiaroCanvas({ ctx, onClose }) {
  const cwd = useCurrentCwd(ctx);
  const [workspaces, setWorkspaces] = React.useState([]);
  const [workspace, setWorkspace] = React.useState(null);
  const [topics, setTopics] = React.useState([]);
  const [topicsLoaded, setTopicsLoaded] = React.useState(false);
  const [topic, setTopic] = React.useState("");
  const [newTopic, setNewTopic] = React.useState("");
  const [creatingTopic, setCreatingTopic] = React.useState(false);
  const [focusLabels, setFocusLabels] = React.useState([]);
  const [error, setError] = React.useState("");
  const [versionError, setVersionError] = React.useState("");
  const [settings, setSettings] = React.useState(storedSettings);
  const [terminalWidth, setTerminalWidth] = React.useState(DEFAULT_TERMINAL_WIDTH);
  const [terminalCollapsed, setTerminalCollapsed] = React.useState(false);
  const api = React.useMemo(
    () => workspace ? createDshChiaroApi(workspace.id) : null,
    [workspace],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    setWorkspaces([]);
    setWorkspace(null);
    if (!cwd) {
      setError("当前 DSH 会话没有 workspace 路径；请先打开一个 DSH workspace 后重试");
      return () => controller.abort();
    }
    void Promise.all([
      requestJson("/api/chiaro/health", { signal: controller.signal, cache: "no-store" }),
      requestJson("/chiaro/bundle/build-version.json", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ]).then(([health, build]) => {
      if (!Array.isArray(health.workspaces) || health.workspaces.length === 0) {
        throw new Error("DSH 没有注册任何 workspace");
      }
      const workspaceId = resolveWorkspaceId(health.workspaces, cwd);
      setVersionError(build.version === BUILD_VERSION ? "" : "前端版本不匹配，请刷新页面");
      setWorkspaces(health.workspaces);
      setWorkspace(health.workspaces.find((item) => item.id === workspaceId));
      setError("");
    }).catch((cause) => {
      if (cause.name !== "AbortError") {
        setError(`无法读取 workspace 列表：${cause.message}；请确认当前会话已关联 DSH workspace 后重试`);
      }
    });
    return () => controller.abort();
  }, [cwd]);

  React.useEffect(() => {
    if (!api || !workspace) return undefined;
    const controller = new AbortController();
    setTopics([]);
    setTopicsLoaded(false);
    setTopic("");
    setFocusLabels([]);
    api.loadTopics().then((catalog) => {
      if (controller.signal.aborted) return;
      setTopics(catalog.topics);
      setTopic(storedTopic(workspace.id, catalog.topics));
      setTopicsLoaded(true);
      setError("");
    }).catch((cause) => {
      if (cause.name !== "AbortError") {
        setError(`无法读取 ${workspace.title || workspace.path} 的 topic：${cause.message}`);
      }
    });
    return () => controller.abort();
  }, [api, workspace]);

  React.useEffect(() => {
    if (!workspace || !topic) return;
    try {
      window.localStorage.setItem(topicStorageKey(workspace.id), topic);
    } catch (cause) {
      console.warn("Chiaro topic 保存失败", cause);
    }
  }, [workspace, topic]);

  const submitTopic = async (event) => {
    event.preventDefault();
    if (!api) return;
    setCreatingTopic(true);
    try {
      const created = await api.createTopic(newTopic.trim());
      setTopics(created.topics);
      setTopic(created.topic);
      setNewTopic("");
      setError("");
    } catch (cause) {
      setError(`新建 topic 失败：${cause.message}；名称只能使用 ASCII 字母、数字、点、下划线和短横线`);
    } finally {
      setCreatingTopic(false);
    }
  };

  const startResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = terminalWidth;
    const onMove = (moveEvent) => {
      setTerminalWidth(clampTerminalWidth(startWidth + startX - moveEvent.clientX));
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

  const zoomTerminal = (delta) => {
    const setting = SETTINGS.find((item) => item.id === "terminalFontSize");
    if (!setting) return;
    setSettings((current) => {
      let next = current.terminalFontSize + delta;
      try {
        next = writeSetting(window.localStorage, setting, next);
      } catch (cause) {
        console.warn(`Chiaro 设置保存失败：${setting.key}`, cause);
      }
      return { ...current, terminalFontSize: next };
    });
  };

  return (
    <main className="app-shell chiaro-page" data-theme={settings.theme}>
      <section className="canvas-shell">
        <header className="topic-bar">
          <div className="topic-brand"><strong>Chiaro</strong></div>
          <label className="topic-picker dsh-workspace-picker">
            <span className="topic-label">workspace</span>
            <select
              aria-label="Chiaro workspace"
              disabled={workspaces.length === 0}
              onChange={(event) => setWorkspace(
                workspaces.find((item) => item.id === event.target.value) || null,
              )}
              value={workspace?.id || ""}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>{item.title || item.id} — {item.path}</option>
              ))}
            </select>
          </label>
          <label className="topic-picker">
            <span className="topic-label">topic</span>
            <select
              aria-label="Chiaro topic"
              disabled={topics.length === 0}
              onChange={(event) => {
                setFocusLabels([]);
                setTopic(event.target.value);
              }}
              value={topic}
            >
              {topics.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <div className="topic-actions">
            <button className="dsh-close" onClick={onClose} type="button">关闭</button>
          </div>
        </header>
        {api && topic ? (
          <ChiaroApiContext.Provider value={api}>
            <CanvasPane
              key={`${workspace.id}:${topic}`}
              onApiReady={() => {}}
              onFocusChange={setFocusLabels}
              theme={settings.theme}
              topic={topic}
            />
          </ChiaroApiContext.Provider>
        ) : workspace && topicsLoaded && topics.length === 0 ? (
          <section className="topic-empty">
            <strong>此 workspace 还没有 Chiaro topic</strong>
            <form onSubmit={(event) => void submitTopic(event)}>
              <label>
                新建 topic
                <input
                  aria-label="新建 topic"
                  disabled={creatingTopic}
                  onChange={(event) => setNewTopic(event.target.value)}
                  pattern="[A-Za-z0-9._-]+"
                  required
                  value={newTopic}
                />
              </label>
              <button disabled={creatingTopic} type="submit">
                {creatingTopic ? "新建中…" : "新建并打开"}
              </button>
            </form>
          </section>
        ) : (
          <div className="canvas-fatal">{error || "正在加载画布…"}</div>
        )}
        {(versionError || (error && workspace)) && (
          <div className="canvas-error" role="alert">{versionError || error}</div>
        )}
      </section>
      {api && topic && (
        <ChiaroApiContext.Provider value={api}>
          <TerminalPanel
            collapsed={terminalCollapsed}
            focusLabels={focusLabels}
            fontSize={settings.terminalFontSize}
            key={`${workspace.id}:${topic}`}
            onFontZoom={zoomTerminal}
            onResetWidth={() => setTerminalWidth(clampTerminalWidth(DEFAULT_TERMINAL_WIDTH))}
            onResizeBy={(delta) => setTerminalWidth((current) => clampTerminalWidth(current + delta))}
            onResizeStart={startResize}
            onToggleCollapse={() => setTerminalCollapsed((current) => !current)}
            theme={settings.theme}
            topic={topic}
            width={terminalWidth}
          />
        </ChiaroApiContext.Provider>
      )}
    </main>
  );
}
