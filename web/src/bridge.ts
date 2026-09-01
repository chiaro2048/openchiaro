import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

export type SceneData = ExcalidrawInitialDataState & {
  elements: readonly ExcalidrawElement[];
  files?: BinaryFiles;
};

export type SceneSnapshot = { scene: SceneData; version: number };

export type AgentTermSummary = {
  instanceId: string;
  agent: string;
  label: string;
  ordinal: number;
  alive: boolean;
  resumable: boolean;
  startedAt: number;
};

export type AgentTermCatalog = {
  agents: { agent: string; label: string }[];
  instances: AgentTermSummary[];
};

export type AgentTermSession = {
  instanceId: string;
  capability: string;
  resumed: boolean;
  freshStart?: boolean;
};

export type AgentState = "away" | "listening" | "working";

export type HubHealth = {
  defaultShell: string;
  platform: string;
  topic: string;
  topicDir: string;
  version: string;
};

export type TopicCatalog = { topic: string; topics: string[] };

export type GestureOperation = {
  type: "moved" | "added" | "deleted";
  id: string;
  label: string;
};

export class SceneConflictError extends Error {
  constructor(readonly latestVersion: number) {
    super("画布已被他人修改");
  }
}

async function responseError(response: Response): Promise<Error> {
  const raw = await response.text();
  try {
    const body = JSON.parse(raw) as { error?: string };
    return new Error(body.error || `请求失败：HTTP ${response.status}`);
  } catch {
    return new Error(raw || `请求失败：HTTP ${response.status}`);
  }
}

function topicPath(pathname: string, topic: string): string {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set("topic", topic);
  return `${url.pathname}${url.search}`;
}

export async function loadScene(topic: string): Promise<SceneSnapshot> {
  const response = await fetch(topicPath("/api/scene", topic));
  if (!response.ok) throw await responseError(response);
  const snapshot = (await response.json()) as SceneSnapshot;
  if (
    !snapshot?.scene || !Array.isArray(snapshot.scene.elements) ||
    !Number.isInteger(snapshot.version)
  ) {
    throw new Error("画布 JSON 缺少 elements 数组");
  }
  return snapshot;
}

export async function postScene(topic: string, rawScene: string, baseVersion: number): Promise<number> {
  const response = await fetch(topicPath("/api/scene", topic), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseVersion, scene: JSON.parse(rawScene) }),
  });
  if (response.status === 409) {
    const body = (await response.json()) as { latestVersion?: number };
    throw new SceneConflictError(body.latestVersion ?? baseVersion);
  }
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as { version?: number };
  if (!Number.isInteger(body.version)) throw new Error("Hub 未返回有效画布版本");
  return body.version as number;
}

export async function postFocus(topic: string, ids: string[], labels: string[]): Promise<void> {
  const response = await fetch(topicPath("/api/focus", topic), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, labels }),
  });
  if (!response.ok) throw await responseError(response);
}

export async function loadAgentTerms(topic: string, signal?: AbortSignal): Promise<AgentTermCatalog> {
  const response = await fetch(topicPath("/api/agent-term", topic), { cache: "no-store", signal });
  if (!response.ok) throw await responseError(response);
  const catalog = (await response.json()) as AgentTermCatalog;
  if (!Array.isArray(catalog?.agents) || catalog.agents.some((entry) => (
    typeof entry?.agent !== "string" || typeof entry.label !== "string"
  )) || !Array.isArray(catalog.instances) || catalog.instances.some((term) => (
    typeof term?.instanceId !== "string" ||
    typeof term?.agent !== "string" || typeof term.label !== "string" ||
    !Number.isInteger(term.ordinal) || term.ordinal < 1 ||
    typeof term.alive !== "boolean" || typeof term.resumable !== "boolean" ||
    typeof term.startedAt !== "number"
  ))) {
    throw new Error("Hub 未返回有效 Agent 终端列表");
  }
  return catalog;
}

export async function postAgentTerm(topic: string, agent: string): Promise<AgentTermSession> {
  const response = await fetch(topicPath("/api/agent-term", topic), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (!response.ok) throw await responseError(response);
  const session = (await response.json()) as AgentTermSession;
  if (
    typeof session?.instanceId !== "string" || typeof session.capability !== "string" ||
    typeof session.resumed !== "boolean"
  ) {
    throw new Error("Hub 未返回有效 Agent 终端会话");
  }
  return session;
}

export async function resumeAgentTerm(topic: string, instanceId: string): Promise<AgentTermSession> {
  const response = await fetch(topicPath(`/api/agent-term/${encodeURIComponent(instanceId)}`, topic), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw await responseError(response);
  const session = (await response.json()) as AgentTermSession;
  if (
    typeof session?.instanceId !== "string" || typeof session.capability !== "string" ||
    typeof session.resumed !== "boolean"
  ) {
    throw new Error("Hub 未返回有效 Agent 终端会话");
  }
  return session;
}

export async function deleteAgentTerm(topic: string, instanceId: string): Promise<void> {
  const response = await fetch(topicPath(`/api/agent-term/${encodeURIComponent(instanceId)}`, topic), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw await responseError(response);
}

export async function loadHealth(): Promise<HubHealth> {
  const response = await fetch("/api/health");
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as Partial<HubHealth>;
  if (
    typeof body.defaultShell !== "string" || typeof body.platform !== "string" ||
    typeof body.topic !== "string" || typeof body.topicDir !== "string" ||
    typeof body.version !== "string"
  ) {
    throw new Error("Hub 状态格式无效");
  }
  return {
    defaultShell: body.defaultShell,
    platform: body.platform,
    topic: body.topic,
    topicDir: body.topicDir,
    version: body.version,
  };
}

export async function loadTopics(): Promise<TopicCatalog> {
  const response = await fetch("/api/topics", { cache: "no-store" });
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as Partial<TopicCatalog>;
  if (typeof body.topic !== "string" || !Array.isArray(body.topics)
      || body.topics.some((entry) => typeof entry !== "string")) {
    throw new Error("Hub 未返回有效 topic 列表");
  }
  return { topic: body.topic, topics: body.topics };
}

export async function createTopic(topic: string): Promise<TopicCatalog> {
  const response = await fetch("/api/topics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic }),
  });
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as Partial<TopicCatalog>;
  if (typeof body.topic !== "string" || !Array.isArray(body.topics)) {
    throw new Error("Hub 未返回有效 topic 列表");
  }
  return { topic: body.topic, topics: body.topics };
}

export async function postGesture(
  topic: string,
  operations: GestureOperation[],
  summary: string,
): Promise<void> {
  const response = await fetch(topicPath("/api/gesture", topic), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations, summary }),
  });
  if (!response.ok) throw await responseError(response);
}

export type AgentStateEvent = {
  type: "agent-state";
  instanceId: string;
  agent: string;
  state: AgentState;
};

export type FocusInjectionEvent = {
  type: "focus-injection";
  agent: string;
  status: "ok" | "none" | "failed";
  reason: string;
};

function connectHubSocket(
  topic: string,
  handleMessage: (message: { type?: string } & Record<string, unknown>) => void,
  onParseError: () => void,
  onDown: (message: string) => void,
  onReconnect: () => void,
): () => void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let attempts = 0;
  let retryTimer: number | undefined;

  const open = () => {
    socket = new WebSocket(`${protocol}://${location.host}${topicPath("/ws", topic)}`);
    socket.onopen = () => {
      if (attempts > 0) onReconnect();
      attempts = 0;
    };
    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch {
        onParseError();
      }
    };
    socket.onclose = () => {
      if (closedByCaller) return;
      attempts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
      onDown(`Hub WebSocket 已断开，${Math.round(delay / 1000)}s 后重连…`);
      retryTimer = window.setTimeout(open, delay);
    };
  };
  open();
  return () => {
    closedByCaller = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}

export function connectAgentStateEvents(
  topic: string,
  onEvent: (event: AgentStateEvent) => void,
  onInjection: (event: FocusInjectionEvent) => void = () => {},
): () => void {
  return connectHubSocket(
    topic,
    (message) => {
      if (message.type === "agent-state") onEvent(message as unknown as AgentStateEvent);
      if (message.type === "focus-injection") {
        onInjection(message as unknown as FocusInjectionEvent);
      }
    },
    () => {},
    () => {},
    () => {},
  );
}

export function connectCanvasUpdates(
  topic: string,
  onUpdate: () => void,
  onError: (message: string) => void,
): () => void {
  return connectHubSocket(
    topic,
    (message) => {
      if (message.type === "canvas-updated") onUpdate();
    },
    () => onError("Hub 推送了无法解析的消息"),
    onError,
    () => {
      // 重连成功：清掉断线提示，补拉一次场景（断线期间可能错过广播）
      onError("");
      onUpdate();
    },
  );
}
