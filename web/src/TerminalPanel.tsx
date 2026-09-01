import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";

import {
  connectAgentStateEvents,
  deleteAgentTerm,
  loadAgentTerms,
  postAgentTerm,
  resumeAgentTerm,
  uploadAgentAttachment,
} from "./bridge";
import type {
  AgentState,
  AgentTermSession,
  AgentTermSummary,
} from "./bridge";
import { PetDock } from "./PetDock";

type LiveAgentTerm = AgentTermSession & {
  agent: string;
  alive: boolean;
  label: string;
  ordinal: number;
};

const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_RECONNECT_WINDOW_MS = 6000;
const FONT_SIZE_STORAGE_KEY = "adw.terminal.fontSize";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

function storedFontSize() {
  const stored = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  if (stored === null) return DEFAULT_FONT_SIZE;
  const value = Number(stored);
  return Number.isFinite(value)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
    : DEFAULT_FONT_SIZE;
}

function terminalSocketUrl(session: AgentTermSession, topic: string) {
  const url = new URL(`/term/${encodeURIComponent(session.instanceId)}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cap", session.capability);
  url.searchParams.set("topic", topic);
  return url.toString();
}

function TerminalView({
  active,
  fontSize,
  onEnded,
  onError,
  onFontZoom,
  onRestart,
  session,
  topic,
}: {
  active: boolean;
  fontSize: number;
  onEnded: (instanceId: string) => void;
  onError: (message: string) => void;
  onFontZoom: (delta: number) => void;
  onRestart: (instanceId: string, agent: string) => Promise<void>;
  session: LiveAgentTerm;
  topic: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitTimerRef = useRef<number | undefined>(undefined);
  const activeRef = useRef(active);
  const fontSizeRef = useRef(fontSize);
  const onFontZoomRef = useRef(onFontZoom);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [ended, setEnded] = useState(!session.alive);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [restarting, setRestarting] = useState(false);
  activeRef.current = active;
  fontSizeRef.current = fontSize;
  onFontZoomRef.current = onFontZoom;

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!activeRef.current || !terminal || !fitAddon || !host
        || host.clientWidth < 2 || host.clientHeight < 2) return;
    const dimensions = fitAddon.proposeDimensions();
    if (!dimensions || dimensions.cols < 1 || dimensions.rows < 1) return;
    fitAddon.fit();
    const { cols, rows } = terminal;
    if (cols < 1 || rows < 1) return;
    const previous = lastSentSizeRef.current;
    if (previous?.cols === cols && previous.rows === rows) return;
    lastSentSizeRef.current = { cols, rows };
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  const scheduleFit = useCallback(() => {
    if (fitTimerRef.current !== undefined) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(fitAndResize, 80);
  }, [fitAndResize]);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) return;
    const palette = window.getComputedStyle(root);
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: fontSizeRef.current,
      theme: {
        background: palette.getPropertyValue("--chiaro-terminal").trim(),
        foreground: palette.getPropertyValue("--chiaro-text").trim(),
      },
    });
    terminal.attachCustomWheelEventHandler((event) => {
      if (!event.ctrlKey || event.deltaY === 0) return true;
      event.preventDefault();
      onFontZoomRef.current(event.deltaY < 0 ? 1 : -1);
      return false;
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const dataSubscription = terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(root);
    scheduleFit();
    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (fitTimerRef.current !== undefined) window.clearTimeout(fitTimerRef.current);
    };
  }, [scheduleFit]);

  useEffect(() => {
    if (active) scheduleFit();
  }, [active, scheduleFit]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    scheduleFit();
  }, [fontSize, scheduleFit]);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: number | undefined;
    let reconnectDeadlineTimer: number | undefined;
    let reconnectAbandoned = false;
    let reconnectAttempts = 0;
    let hasConnected = false;
    setEnded(false);
    terminalRef.current?.reset();
    lastSentSizeRef.current = null;

    const reconnect = () => {
      if (stopped || reconnectAbandoned) return;
      if (reconnectDeadlineTimer === undefined) {
        reconnectDeadlineTimer = window.setTimeout(() => {
          reconnectAbandoned = true;
          setConnectionStatus("连接已断开，请刷新页面后重试");
          socketRef.current?.close();
        }, MAX_RECONNECT_WINDOW_MS);
      }
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        reconnectAbandoned = true;
        window.clearTimeout(reconnectDeadlineTimer);
        setConnectionStatus("连接已断开，请刷新页面后重试");
        return;
      }
      const delay = Math.min(4000, 500 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      setConnectionStatus(`连接已断开，${delay / 1000}s 后重连…`);
      reconnectTimer = window.setTimeout(connect, delay);
    };
    const connect = () => {
      if (stopped) return;
      const socket = new WebSocket(terminalSocketUrl(session, topic));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => {
        if (stopped) return;
        if (hasConnected) terminalRef.current?.reset();
        hasConnected = true;
        reconnectAttempts = 0;
        reconnectAbandoned = false;
        if (reconnectDeadlineTimer !== undefined) {
          window.clearTimeout(reconnectDeadlineTimer);
          reconnectDeadlineTimer = undefined;
        }
        lastSentSizeRef.current = null;
        setEnded(false);
        setConnectionStatus("");
        scheduleFit();
      };
      socket.onmessage = async (event) => {
        let output: string | Uint8Array;
        if (typeof event.data === "string") output = event.data;
        else if (event.data instanceof Blob) output = new Uint8Array(await event.data.arrayBuffer());
        else output = new Uint8Array(event.data);
        if (!stopped) terminalRef.current?.write(output);
      };
      socket.onerror = () => socket.close();
      socket.onclose = async () => {
        if (stopped) return;
        try {
          const summary = (await loadAgentTerms(topic, AbortSignal.timeout(750)))
            .instances.find(({ instanceId }) => instanceId === session.instanceId);
          if (summary?.alive) reconnect();
          else {
            setConnectionStatus("");
            setEnded(true);
            onEnded(session.instanceId);
          }
        } catch {
          reconnect();
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (reconnectDeadlineTimer !== undefined) window.clearTimeout(reconnectDeadlineTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [onEnded, scheduleFit, session.capability, session.instanceId, topic]);

  const pasteAttachment = (event: ReactClipboardEvent<HTMLElement>) => {
    const clipboard = event.clipboardData;
    if (clipboard.getData("text/plain") !== "") return;
    const images = Array.from(clipboard.items).filter((item) => (
      item.kind === "file" && item.type.startsWith("image/")
    ));
    if (images.length === 0) return;
    event.preventDefault();
    if (images.length !== 1) {
      onError("一次只能粘贴一张图片");
      return;
    }
    const image = images[0].getAsFile();
    if (!image) {
      onError("无法读取剪贴板图片");
      return;
    }
    if (image.size > MAX_ATTACHMENT_BYTES) {
      onError("图片原始数据超过 18 MiB");
      return;
    }
    void uploadAgentAttachment(topic, session.instanceId, session.capability, image)
      .then((attachmentPath) => {
        terminalRef.current?.paste(attachmentPath);
        onError("");
      })
      .catch((cause: unknown) => {
        onError(`图片粘贴失败：${cause instanceof Error ? cause.message : String(cause)}`);
      });
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await onRestart(session.instanceId, session.agent);
      setEnded(false);
    } catch {
      setEnded(true);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <section
      className={`terminal-view${active ? " active" : ""}`}
      data-agent={session.agent}
      data-instance-id={session.instanceId}
      onPasteCapture={pasteAttachment}
      ref={rootRef}
    >
      <div aria-label={`${session.label} 终端`} className="terminal-host" ref={hostRef} />
      {session.freshStart && (
        <div className="terminal-fresh-start" role="status">
          恢复失败，已启动新会话（fresh start）
        </div>
      )}
      {connectionStatus && (
        <div className="terminal-connection-status" role="status">{connectionStatus}</div>
      )}
      {ended && (
        <div className="terminal-ended-overlay">
          <strong>
            {session.resumed
              ? "恢复的会话已退出，重新拉起将开始全新会话"
              : "会话已结束"}
          </strong>
          <button disabled={restarting} onClick={() => void restart()} type="button">
            {restarting ? "正在重新拉起…" : "重新拉起"}
          </button>
        </div>
      )}
    </section>
  );
}

export function TerminalPanel({
  collapsed,
  focusLabels,
  onResetWidth,
  onResizeBy,
  onResizeStart,
  onToggleCollapse,
  topic,
  width,
}: {
  collapsed: boolean;
  focusLabels: string[];
  onResetWidth: () => void;
  onResizeBy: (delta: number) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleCollapse: () => void;
  topic: string;
  width: number;
}) {
  const [agentTypes, setAgentTypes] = useState<{ agent: string; label: string }[]>([]);
  const [summaries, setSummaries] = useState<AgentTermSummary[]>([]);
  const [sessions, setSessions] = useState<Record<string, LiveAgentTerm>>({});
  const [currentInstanceId, setCurrentInstanceId] = useState("");
  const [fontSize, setFontSize] = useState(storedFontSize);
  const [menuOpen, setMenuOpen] = useState(false);
  const [petMenu, setPetMenu] = useState<{ instanceId: string; x: number; y: number } | null>(null);
  const [pendingCloseInstanceId, setPendingCloseInstanceId] = useState("");
  const [closingInstanceId, setClosingInstanceId] = useState("");
  const [busyAgent, setBusyAgent] = useState("");
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [injectionNotice, setInjectionNotice] = useState("");
  const [error, setError] = useState("");

  const zoomFont = useCallback((delta: number) => {
    setFontSize((current) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
  }, [fontSize]);

  const refreshSummaries = useCallback(async () => {
    const catalog = await loadAgentTerms(topic);
    setAgentTypes(catalog.agents);
    setSummaries(catalog.instances);
    setAgentStates((current) => {
      const states = { ...current };
      for (const item of catalog.instances) {
        if (!(item.instanceId in states) || !item.alive) {
          states[item.instanceId] = item.alive ? "listening" : "away";
        }
      }
      return states;
    });
    return catalog;
  }, [topic]);

  const launchAgent = useCallback(async (agent: string) => {
    setBusyAgent(agent);
    try {
      const session = await postAgentTerm(topic, agent);
      const { instances } = await refreshSummaries();
      const summary = instances.find((item) => item.instanceId === session.instanceId);
      setSessions((current) => ({
        ...current,
        [session.instanceId]: {
          ...session,
          agent,
          alive: true,
          label: summary?.label || agent,
          ordinal: summary?.ordinal || 1,
        },
      }));
      setAgentStates((current) => ({ ...current, [session.instanceId]: "listening" }));
      setCurrentInstanceId(session.instanceId);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusyAgent("");
    }
  }, [refreshSummaries, topic]);

  const resumeInstance = useCallback(async (instanceId: string) => {
    setBusyAgent(instanceId);
    try {
      const session = await resumeAgentTerm(topic, instanceId);
      const { instances } = await refreshSummaries();
      const summary = instances.find((item) => item.instanceId === instanceId);
      if (!summary) throw new Error(`Hub 未返回实例：${instanceId}`);
      setSessions((current) => ({
        ...current,
        [instanceId]: { ...session, ...summary, alive: true },
      }));
      setAgentStates((current) => ({ ...current, [instanceId]: "listening" }));
      setCurrentInstanceId(instanceId);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusyAgent("");
    }
  }, [refreshSummaries, topic]);

  useEffect(() => {
    let noticeTimer: number | undefined;
    const disconnect = connectAgentStateEvents(
      topic,
      (event) => {
        setAgentStates((current) => ({ ...current, [event.instanceId]: event.state }));
      },
      (event) => {
        if (event.status === "ok") return;
        setInjectionNotice(`本轮未注入：${event.reason}`);
        if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
        noticeTimer = window.setTimeout(() => setInjectionNotice(""), 4000);
      },
    );
    return () => {
      disconnect();
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    };
  }, [topic]);

  useEffect(() => {
    let cancelled = false;
    refreshSummaries().then(async ({ instances }) => {
      const alive = instances.filter((item) => item.alive);
      const restored = await Promise.all(alive.map(async (item) => ({
        item,
        session: await resumeAgentTerm(topic, item.instanceId),
      })));
      if (cancelled) return;
      const next: Record<string, LiveAgentTerm> = {};
      for (const { item, session } of restored) {
        next[item.instanceId] = { ...session, ...item, alive: true };
      }
      setSessions(next);
      if (restored[0]) setCurrentInstanceId(restored[0].item.instanceId);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [refreshSummaries, topic]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  useEffect(() => {
    if (!petMenu) return;
    const close = () => setPetMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [petMenu]);

  const markEnded = useCallback((instanceId: string) => {
    setSessions((current) => current[instanceId]
      ? { ...current, [instanceId]: { ...current[instanceId], alive: false } }
      : current);
    setSummaries((current) => current.map((item) => (
      item.instanceId === instanceId ? { ...item, alive: false } : item
    )));
    setAgentStates((current) => ({ ...current, [instanceId]: "away" }));
    void refreshSummaries().catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [refreshSummaries]);

  const selectInstance = (instanceId: string) => {
    setMenuOpen(false);
    if (sessions[instanceId]?.alive) setCurrentInstanceId(instanceId);
    else void resumeInstance(instanceId).catch(() => {});
  };

  const openPetMenu = (event: ReactMouseEvent<HTMLButtonElement>, instanceId: string) => {
    event.preventDefault();
    setMenuOpen(false);
    setPetMenu(sessions[instanceId]?.alive
      ? { instanceId, x: event.clientX, y: event.clientY }
      : null);
  };

  const closeInstance = async () => {
    const instanceId = pendingCloseInstanceId;
    if (!instanceId) return;
    setClosingInstanceId(instanceId);
    try {
      await deleteAgentTerm(topic, instanceId);
      setSessions((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== instanceId),
      ));
      setAgentStates((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== instanceId),
      ));
      if (currentInstanceId === instanceId) {
        setCurrentInstanceId(Object.values(sessions)
          .find((session) => session.instanceId !== instanceId && session.alive)?.instanceId || "");
      }
      setPendingCloseInstanceId("");
      setError("");
      await refreshSummaries();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClosingInstanceId("");
    }
  };

  const restartInstance = async (instanceId: string, agent: string) => {
    if (summaries.find((item) => item.instanceId === instanceId)?.resumable) {
      await resumeInstance(instanceId);
      return;
    }
    await launchAgent(agent);
    setSessions((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== instanceId),
    ));
  };

  const petAgents = summaries
    .filter(({ alive, resumable }) => alive || resumable)
    .map(({ agent, instanceId, label, ordinal, alive, resumable }) => ({
      instanceId,
      agent,
      label,
      ordinal,
      state: agentStates[instanceId] || (alive ? "listening" as const : "away" as const),
      resumable: resumable && !alive,
      justReplied: false,
    }));
  const pendingCloseSummary = summaries.find(({ instanceId }) => (
    instanceId === pendingCloseInstanceId
  ));
  const pendingCloseLabel = pendingCloseSummary
    ? `${pendingCloseSummary.label} · ${pendingCloseSummary.ordinal}`
    : pendingCloseInstanceId;

  return (
    <aside
      className={`terminal-panel${collapsed ? " collapsed" : ""}`}
      style={{ width: collapsed ? undefined : width, flexBasis: collapsed ? undefined : width }}
    >
      <button
        aria-label="展开侧栏"
        className="expand-sidebar"
        onClick={onToggleCollapse}
        title="展开侧栏"
        type="button"
      >
        ‹
      </button>
      <div className="terminal-panel-content">
        <div
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuenow={Math.round(width)}
          className="sidebar-resize-handle"
          onDoubleClick={onResetWidth}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") onResizeBy(20);
            else if (event.key === "ArrowRight") onResizeBy(-20);
            else return;
            event.preventDefault();
          }}
          onPointerDown={onResizeStart}
          role="separator"
          tabIndex={0}
          title="拖动调宽，双击恢复 380px"
        />
        <header>
          <div className="terminal-title-row">
            <div>
              <h1>
                <svg className="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M50 6 C53 37, 63 47, 94 50 C63 53, 53 63, 50 94 C47 63, 37 53, 6 50 C37 47, 47 37, 50 6 Z M50 39 A11 11 0 1 0 50 61 A11 11 0 1 0 50 39 Z"
                  />
                </svg>
                {topic} · openchiaro
              </h1>
              <small className="terminal-focus">
                {focusLabels.length ? `Focus：${focusLabels.join("、")}` : "无 Focus"}
              </small>
            </div>
            <div className="terminal-header-actions">
              <div className="terminal-menu-wrap">
                <button
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label="添加 Agent 终端"
                  className="add-terminal"
                  onClick={() => setMenuOpen((open) => !open)}
                  type="button"
                >
                  {busyAgent ? "创建中…" : "+ Agent"}
                </button>
                {menuOpen && (
                  <div className="terminal-menu agent-menu" role="menu">
                    {agentTypes.map(({ agent, label }) => (
                      <button
                        key={agent}
                        onClick={() => {
                          setMenuOpen(false);
                          void launchAgent(agent).catch(() => {});
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <strong>{agent}</strong>
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                aria-label="折叠侧栏"
                className="collapse-sidebar"
                onClick={onToggleCollapse}
                title="折叠侧栏"
                type="button"
              >
                ›
              </button>
            </div>
          </div>
        </header>
        <PetDock
          activeInstanceId={currentInstanceId}
          agents={petAgents}
          onContextMenu={openPetMenu}
          onSelect={selectInstance}
        />
        {petMenu && (
          <div
            className="terminal-menu pet-context-menu"
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: petMenu.x, top: petMenu.y }}
          >
            <button
              onClick={() => {
                setPendingCloseInstanceId(petMenu.instanceId);
                setPetMenu(null);
              }}
              role="menuitem"
              type="button"
            >
              关闭会话
            </button>
          </div>
        )}
        {injectionNotice && (
          <div className="terminal-injection-notice" role="status">{injectionNotice}</div>
        )}
        <div className="terminal-stage">
          {!currentInstanceId && <p className="terminal-empty">点击「+ Agent」打开原生终端。</p>}
          {Object.values(sessions).map((session) => (
            <TerminalView
              active={session.instanceId === currentInstanceId}
              fontSize={fontSize}
              key={session.instanceId}
              onEnded={markEnded}
              onError={setError}
              onFontZoom={zoomFont}
              onRestart={restartInstance}
              session={session}
              topic={topic}
            />
          ))}
        </div>
        {error && <p className="terminal-error" role="alert">{error}</p>}
      </div>
      {pendingCloseInstanceId && (
        <div className="terminal-confirm-backdrop">
          <section
            aria-labelledby="close-agent-title"
            aria-modal="true"
            className="terminal-confirm"
            role="alertdialog"
          >
            <h2 id="close-agent-title">关闭 {pendingCloseLabel} 会话？</h2>
            <p>会终止该实例的进程，未保存的对话上下文会中断。</p>
            <div className="terminal-confirm-actions">
              <button autoFocus onClick={() => setPendingCloseInstanceId("")} type="button">取消</button>
              <button
                className="danger"
                disabled={closingInstanceId === pendingCloseInstanceId}
                onClick={() => void closeInstance()}
                type="button"
              >
                {closingInstanceId === pendingCloseInstanceId ? "正在关闭…" : "确认关闭"}
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
