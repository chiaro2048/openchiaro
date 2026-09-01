import React from "react";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@excalidraw/excalidraw/index.css";
import "@xterm/xterm/css/xterm.css";

import {
  labelsForSelection,
  resolveWorkspaceId,
  sceneSignature,
  terminalSocketUrl,
} from "./canvas-logic.mjs";
import "./chunk.css";

const h = React.createElement;
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("读取剪贴板图片失败"));
    reader.onload = () => {
      const result = reader.result;
      const comma = typeof result === "string" ? result.indexOf(",") : -1;
      if (comma < 0) reject(new Error("剪贴板图片编码失败"));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
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
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.latestVersion = body.latestVersion;
    throw error;
  }
  return body;
}

const queryFor = (workspaceId, topic) => new URLSearchParams({ workspaceId, topic }).toString();

function ChiaroTerminal({ workspace, topic }) {
  const hostRef = React.useRef(null);
  const [agents, setAgents] = React.useState([]);
  const [agent, setAgent] = React.useState("claude");
  const [session, setSession] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const query = queryFor(workspace.id, topic);

  React.useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    setStatus("");
    void requestJson(`/api/chiaro/agent-term?${query}`, {
      signal: controller.signal,
      cache: "no-store",
    }).then((catalog) => {
      const available = Array.isArray(catalog.agents) ? catalog.agents : [];
      setAgents(available);
      setAgent(available.some((item) => item.agent === "claude")
        ? "claude"
        : available[0]?.agent || "");
    }).catch((cause) => {
      if (cause.name !== "AbortError") {
        setStatus(`无法读取终端列表：${cause.message}；请检查 workspace 的 agent 配置后重试`);
      }
    });
    return () => controller.abort();
  }, [query]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !session) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      theme: { background: "#111827", foreground: "#e5e7eb" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    const socket = new WebSocket(terminalSocketUrl(location.href, workspace.id, topic, session));
    socket.binaryType = "arraybuffer";
    const fit = () => {
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const onPaste = (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard || clipboard.getData("text/plain") !== "") return;
      const images = Array.from(clipboard.items).filter((item) => (
        item.kind === "file" && item.type.startsWith("image/")
      ));
      if (images.length === 0) return;
      event.preventDefault();
      if (images.length !== 1) {
        setStatus("一次只能粘贴一张图片");
        return;
      }
      const image = images[0].getAsFile();
      if (!image) {
        setStatus("无法读取剪贴板图片");
        return;
      }
      if (image.size > MAX_ATTACHMENT_BYTES) {
        setStatus("图片原始数据超过 18 MiB");
        return;
      }
      const url = new URL(
        `/api/chiaro/agent-term/${encodeURIComponent(session.instanceId)}/attachment`,
        location.href,
      );
      url.searchParams.set("workspaceId", workspace.id);
      url.searchParams.set("topic", topic);
      url.searchParams.set("cap", session.capability);
      void blobBase64(image)
        .then((base64) => requestJson(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mimeType: image.type, base64 }),
        }))
        .then((attachment) => {
          if (typeof attachment.path !== "string" || !attachment.path) {
            throw new Error("host 未返回附件路径");
          }
          terminal.paste(attachment.path);
          setStatus("");
        })
        .catch((cause) => setStatus(`图片粘贴失败：${cause.message}`));
    };
    host.addEventListener("paste", onPaste, true);
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    socket.onopen = () => {
      setStatus("");
      fit();
    };
    socket.onmessage = async (event) => {
      if (typeof event.data === "string") terminal.write(event.data);
      else if (event.data instanceof Blob) terminal.write(new Uint8Array(await event.data.arrayBuffer()));
      else terminal.write(new Uint8Array(event.data));
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => setStatus("终端连接已结束");
    return () => {
      observer.disconnect();
      host.removeEventListener("paste", onPaste, true);
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [session, topic, workspace.id]);

  const start = async () => {
    setBusy(true);
    try {
      setSession(await requestJson(`/api/chiaro/agent-term?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      }));
      setStatus("");
    } catch (cause) {
      setStatus(`终端启动失败：${cause.message}；请检查 agent 命令配置后重试`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await requestJson(`/api/chiaro/agent-term/${encodeURIComponent(session.instanceId)}?${query}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      setSession(null);
      setStatus("");
    } catch (cause) {
      setStatus(`终端关闭失败：${cause.message}；请稍后重试`);
    } finally {
      setBusy(false);
    }
  };

  return h("aside", { className: "chiaro-terminal", "aria-label": "Chiaro agent 终端" },
    h("div", { className: "chiaro-terminal-toolbar" },
      h("strong", null, "PTY"),
      h("select", {
        "aria-label": "终端 agent",
        value: agent,
        disabled: busy || Boolean(session),
        onChange: (event) => setAgent(event.target.value),
      }, agents.map((item) => h("option", { key: item.agent, value: item.agent }, item.label))),
      session
        ? h("button", { type: "button", disabled: busy, onClick: () => void stop() }, "停止")
        : h("button", { type: "button", disabled: busy || !agent, onClick: () => void start() },
          busy ? "启动中…" : "启动")),
    session
      ? h("div", { className: "chiaro-terminal-host", ref: hostRef })
      : h("div", { className: "chiaro-terminal-empty" }, "选择 Claude 或 Codex 后启动"),
    status ? h("div", { className: "chiaro-terminal-status", role: "status" }, status) : null);
}

export function ChiaroCanvas({ ctx, onClose }) {
  const sessions = React.useSyncExternalStore(
    (notify) => ctx.sessions.list.subscribe(notify),
    () => ctx.sessions.list.getSnapshot(),
  );
  const cwd = sessions.current ? sessions.byId[sessions.current]?.cwd : undefined;
  const [workspaces, setWorkspaces] = React.useState([]);
  const [workspace, setWorkspace] = React.useState(null);
  const [topics, setTopics] = React.useState([]);
  const [topicsLoaded, setTopicsLoaded] = React.useState(false);
  const [topic, setTopic] = React.useState("");
  const [newTopic, setNewTopic] = React.useState("");
  const [creatingTopic, setCreatingTopic] = React.useState(false);
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
    setWorkspaces([]);
    setWorkspace(null);
    setTopics([]);
    setTopicsLoaded(false);
    setTopic("");
    setSnapshot(null);
    if (!cwd) {
      setError("当前 DSH 会话没有 workspace 路径；请先打开一个 DSH workspace 后重试");
      return () => controller.abort();
    }
    void (async () => {
      try {
        const health = await requestJson("/api/chiaro/health", { signal: controller.signal, cache: "no-store" });
        if (!Array.isArray(health.workspaces) || health.workspaces.length === 0) {
          throw new Error("DSH 没有注册任何 workspace");
        }
        const workspaceId = resolveWorkspaceId(health.workspaces, cwd);
        const current = health.workspaces.find((item) => item.id === workspaceId);
        setWorkspaces(health.workspaces);
        setWorkspace(current);
        setError("");
      } catch (cause) {
        if (cause.name !== "AbortError") {
          setError(`无法读取 workspace 列表：${cause.message}；请确认当前会话已关联 DSH workspace 后重试`);
        }
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  React.useEffect(() => {
    if (!workspace) return undefined;
    const controller = new AbortController();
    setTopics([]);
    setTopicsLoaded(false);
    setTopic("");
    setSnapshot(null);
    setError("");
    void requestJson(`/api/chiaro/topics?workspaceId=${encodeURIComponent(workspace.id)}`, {
      signal: controller.signal,
      cache: "no-store",
    }).then((list) => {
      if (!Array.isArray(list.topics)) throw new Error("服务返回的 topic 列表无效");
      setTopics(list.topics);
      setTopic(list.topics[0] || "");
      setTopicsLoaded(true);
      setError("");
    }).catch((cause) => {
      if (cause.name !== "AbortError") {
        setError(`无法读取 ${workspace.title || workspace.path} 的 topic：${cause.message}；请检查 workspace 路径后重试`);
      }
    });
    return () => controller.abort();
  }, [workspace]);

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
      if (cause.name !== "AbortError") {
        setError(`无法打开画布：${cause.message}；请确认 topic 文件完整后重试`);
      }
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
            void loadScene({ external: true }).catch((cause) => (
              setError(`画布刷新失败：${cause.message}；请重新选择 topic 后重试`)
            ));
          }
        } catch {
          setError("Chiaro WebSocket 推送格式无效；请关闭并重新打开 Chiaro");
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
    }).catch((cause) => (
      setError(`Focus 写入失败：${cause.message}；请重新选择画布对象后重试`)
    ));
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
          setError(`画布保存失败：${cause.message}；请检查 workspace 写权限后重试`);
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

  const selectWorkspace = (event) => {
    setTopics([]);
    setTopicsLoaded(false);
    setTopic("");
    setSnapshot(null);
    setWorkspace(workspaces.find((item) => item.id === event.target.value) || null);
  };

  const createTopic = async (event) => {
    event.preventDefault();
    if (!workspace) return;
    const nextTopic = newTopic.trim();
    setCreatingTopic(true);
    try {
      const created = await requestJson("/api/chiaro/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, topic: nextTopic }),
      });
      setTopics(created.topics);
      setTopic(created.topic);
      setNewTopic("");
      setError("");
    } catch (cause) {
      setError(`新建 topic 失败：${cause.message}；名称只能使用 ASCII 字母、数字、点、下划线和短横线，并请确认 workspace 可写`);
    } finally {
      setCreatingTopic(false);
    }
  };

  return h("div", { className: "chiaro-page", role: "region", "aria-label": "Chiaro 画布" },
    h("header", { className: "chiaro-toolbar" },
      h("strong", null, "Chiaro"),
      h("select", {
        className: "chiaro-workspace-select",
        "aria-label": "Chiaro workspace",
        value: workspace?.id || "",
        disabled: workspaces.length === 0,
        onChange: selectWorkspace,
      }, workspaces.map((item) => h("option", { key: item.id, value: item.id },
        `${item.title || item.id} — ${item.path}`))),
      h("select", {
        "aria-label": "Chiaro topic",
        value: topic,
        disabled: topics.length === 0,
        onChange: (event) => setTopic(event.target.value),
      }, topics.map((item) => h("option", { key: item, value: item }, item))),
      h("button", { type: "button", onClick: onClose }, "关闭")),
    h("div", { className: "chiaro-body" },
      h("main", { className: "chiaro-canvas" },
        snapshot ? h(Excalidraw, {
          key: `${workspace.id}:${topic}`,
          initialData: snapshot.scene,
          excalidrawAPI: (api) => { apiRef.current = api; },
          onChange,
        }) : workspace && topicsLoaded && topics.length === 0
          ? h("div", { className: "chiaro-empty" },
            h("strong", null, "此 workspace 还没有 chiaro topic"),
            h("form", { onSubmit: (event) => void createTopic(event) },
              h("label", null, "新建 topic",
                h("input", {
                  "aria-label": "新建 topic",
                  value: newTopic,
                  required: true,
                  pattern: "[A-Za-z0-9._-]+",
                  title: "只能使用 ASCII 字母、数字、点、下划线和短横线",
                  disabled: creatingTopic,
                  onChange: (event) => setNewTopic(event.target.value),
                })),
              h("button", { type: "submit", disabled: creatingTopic },
                creatingTopic ? "新建中…" : "新建并打开")),
            error ? h("div", { className: "chiaro-empty-error", role: "alert" }, error) : null)
          : h("div", { className: "chiaro-loading" }, error || "正在加载画布…")),
      workspace && topic ? h(ChiaroTerminal, { workspace, topic }) : null),
    error && snapshot ? h("div", { className: "chiaro-error", role: "alert" }, error) : null);
}
