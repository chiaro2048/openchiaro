import React from "react";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import { labelsForSelection, resolveWorkspaceId, sceneSignature } from "./canvas-logic.mjs";
import "./chunk.css";

const h = React.createElement;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.latestVersion = body.latestVersion;
    throw error;
  }
  return body;
}

const queryFor = (workspaceId, topic) => new URLSearchParams({ workspaceId, topic }).toString();

export function ChiaroCanvas({ ctx, onClose }) {
  const sessions = React.useSyncExternalStore(
    (notify) => ctx.sessions.list.subscribe(notify),
    () => ctx.sessions.list.getSnapshot(),
  );
  const cwd = sessions.current ? sessions.byId[sessions.current]?.cwd : undefined;
  const [workspace, setWorkspace] = React.useState(null);
  const [topics, setTopics] = React.useState([]);
  const [topic, setTopic] = React.useState("");
  const [snapshot, setSnapshot] = React.useState(null);
  const [error, setError] = React.useState("");
  const apiRef = React.useRef(null);
  const versionRef = React.useRef(0);
  const signatureRef = React.useRef("");
  const selectionRef = React.useRef("");
  const dirtyRef = React.useRef(false);
  const saveTimerRef = React.useRef();
  const focusTimerRef = React.useRef();
  const pendingFocusRef = React.useRef();
  const lastFocusAtRef = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setWorkspace(null);
    setTopics([]);
    setTopic("");
    setSnapshot(null);
    if (!cwd) {
      setError("当前 DSH 会话没有 workspace 路径");
      return () => controller.abort();
    }
    void (async () => {
      try {
        const health = await requestJson("/api/chiaro/health", { signal: controller.signal, cache: "no-store" });
        const workspaceId = resolveWorkspaceId(health.workspaces, cwd);
        const current = health.workspaces.find((item) => item.id === workspaceId);
        const list = await requestJson(`/api/chiaro/topics?workspaceId=${encodeURIComponent(workspaceId)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!Array.isArray(list.topics) || list.topics.length === 0) {
          throw new Error("当前 workspace 还没有 Chiaro topic");
        }
        setWorkspace(current);
        setTopics(list.topics);
        setTopic(list.topics[0]);
        setError("");
      } catch (cause) {
        if (cause.name !== "AbortError") setError(`画布入口加载失败：${cause.message}`);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const loadScene = React.useCallback(async ({ external = false, signal } = {}) => {
    if (!workspace || !topic) return;
    if (external && dirtyRef.current) {
      setError("画布在本地编辑期间被外部修改；保存时将检查版本");
      return;
    }
    const next = await requestJson(`/api/chiaro/scene?${queryFor(workspace.id, topic)}`, {
      signal,
      cache: "no-store",
    });
    versionRef.current = next.version;
    signatureRef.current = sceneSignature(next.scene.elements);
    selectionRef.current = "";
    dirtyRef.current = false;
    setSnapshot(next);
    if (apiRef.current) {
      apiRef.current.updateScene({ elements: next.scene.elements });
      if (next.scene.files) apiRef.current.addFiles(Object.values(next.scene.files));
    }
    setError("");
  }, [workspace, topic]);

  React.useEffect(() => {
    if (!workspace || !topic) return undefined;
    const controller = new AbortController();
    apiRef.current = null;
    setSnapshot(null);
    clearTimeout(saveTimerRef.current);
    dirtyRef.current = false;
    void loadScene({ signal: controller.signal }).catch((cause) => {
      if (cause.name !== "AbortError") setError(`画布加载失败：${cause.message}`);
    });
    return () => controller.abort();
  }, [workspace, topic, loadScene]);

  React.useEffect(() => {
    if (!workspace || !topic) return undefined;
    let socket;
    let retryTimer;
    let disposed = false;
    const open = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/api/chiaro/ws?${queryFor(workspace.id, topic)}`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "canvas-updated") {
            void loadScene({ external: true }).catch((cause) => setError(`画布刷新失败：${cause.message}`));
          }
        } catch {
          setError("Chiaro WebSocket 推送格式无效");
        }
      };
      socket.onclose = () => {
        if (!disposed) retryTimer = window.setTimeout(open, 500);
      };
    };
    open();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [workspace, topic, loadScene]);

  React.useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    clearTimeout(focusTimerRef.current);
  }, []);

  const sendFocus = React.useCallback(() => {
    const pending = pendingFocusRef.current;
    if (!pending || !workspace || !topic) return;
    pendingFocusRef.current = undefined;
    lastFocusAtRef.current = Date.now();
    void requestJson(`/api/chiaro/focus?${queryFor(workspace.id, topic)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending),
    }).catch((cause) => setError(`Focus 写入失败：${cause.message}`));
  }, [workspace, topic]);

  const onChange = React.useCallback((elements, appState, files) => {
    const signature = sceneSignature(elements);
    if (signature !== signatureRef.current) {
      signatureRef.current = signature;
      dirtyRef.current = true;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        const baseVersion = versionRef.current;
        void requestJson(`/api/chiaro/scene?${queryFor(workspace.id, topic)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseVersion,
            scene: JSON.parse(serializeAsJSON(elements, appState, files, "local")),
          }),
        }).then((result) => {
          versionRef.current = result.version;
          dirtyRef.current = false;
          setError("");
        }).catch((cause) => {
          if (cause.status === 409) {
            dirtyRef.current = false;
            void loadScene().then(() => setError("画布已被外部修改，本地冲突内容未覆盖磁盘"));
            return;
          }
          setError(`画布保存失败：${cause.message}`);
        });
      }, 800);
    }

    const ids = Object.keys(appState.selectedElementIds || {})
      .filter((id) => appState.selectedElementIds[id])
      .sort();
    const selection = ids.join("|");
    if (selection === selectionRef.current) return;
    selectionRef.current = selection;
    pendingFocusRef.current = { ids, labels: labelsForSelection(elements, ids) };
    const wait = 300 - (Date.now() - lastFocusAtRef.current);
    clearTimeout(focusTimerRef.current);
    if (wait <= 0) sendFocus();
    else focusTimerRef.current = window.setTimeout(sendFocus, wait);
  }, [workspace, topic, loadScene, sendFocus]);

  return h("div", { className: "chiaro-page", role: "region", "aria-label": "Chiaro 画布" },
    h("header", { className: "chiaro-toolbar" },
      h("strong", null, "Chiaro"),
      h("span", { className: "chiaro-workspace" }, workspace?.title || cwd || "加载中…"),
      h("select", {
        "aria-label": "Chiaro topic",
        value: topic,
        disabled: topics.length === 0,
        onChange: (event) => setTopic(event.target.value),
      }, topics.map((item) => h("option", { key: item, value: item }, item))),
      h("button", { type: "button", onClick: onClose }, "关闭")),
    h("main", { className: "chiaro-canvas" },
      snapshot ? h(Excalidraw, {
        key: `${workspace.id}:${topic}`,
        initialData: snapshot.scene,
        excalidrawAPI: (api) => { apiRef.current = api; },
        onChange,
      }) : h("div", { className: "chiaro-loading" }, error || "正在加载画布…")),
    error && snapshot ? h("div", { className: "chiaro-error", role: "alert" }, error) : null);
}
