import { SceneConflictError } from "../../web/src/ChiaroApi.ts";
import type {
  AgentStateEvent,
  AgentTermCatalog,
  AgentTermSession,
  ChiaroApi,
  FocusInjectionEvent,
  GestureOperation,
  HubHealth,
  SceneSnapshot,
  TopicCatalog,
} from "../../web/src/ChiaroApi.ts";

function scopedPath(pathname: string, workspaceId: string, topic?: string): string {
  const query = new URLSearchParams({ workspaceId });
  if (topic !== undefined) query.set("topic", topic);
  return `${pathname}?${query}`;
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

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

function validSession(session: Partial<AgentTermSession>): AgentTermSession {
  if (
    typeof session?.instanceId !== "string" || typeof session.capability !== "string" ||
    typeof session.resumed !== "boolean"
  ) {
    throw new Error("DSH host 未返回有效 Agent 终端会话");
  }
  return session as AgentTermSession;
}

function connectSocket(
  workspaceId: string,
  topic: string,
  onMessage: (message: Record<string, unknown>) => void,
  onError: (message: string) => void,
  onReconnect: () => void,
): () => void {
  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  let stopped = false;
  let reconnecting = false;

  const open = () => {
    const url = new URL("/api/chiaro/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspaceId", workspaceId);
    url.searchParams.set("topic", topic);
    socket = new WebSocket(url);
    socket.onopen = () => {
      if (reconnecting) onReconnect();
      reconnecting = false;
    };
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as Record<string, unknown>);
      } catch {
        onError("DSH host 推送了无法解析的消息");
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      reconnecting = true;
      onError("DSH host WebSocket 已断开，1s 后重连…");
      retryTimer = window.setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    socket?.close();
  };
}

export function createDshChiaroApi(workspaceId: string): ChiaroApi {
  if (!workspaceId) throw new Error("DSH Chiaro API 缺少 workspaceId");

  return {
    async loadScene(topic): Promise<SceneSnapshot> {
      const snapshot = await json<SceneSnapshot>(scopedPath("/api/chiaro/scene", workspaceId, topic));
      if (!snapshot?.scene || !Array.isArray(snapshot.scene.elements) || !Number.isInteger(snapshot.version)) {
        throw new Error("DSH host 返回的画布缺少 elements 数组");
      }
      return snapshot;
    },

    async postScene(topic, rawScene, baseVersion): Promise<number> {
      const response = await fetch(scopedPath("/api/chiaro/scene", workspaceId, topic), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion, scene: JSON.parse(rawScene) }),
      });
      if (response.status === 409) {
        const body = await response.json() as { latestVersion?: number };
        throw new SceneConflictError(body.latestVersion ?? baseVersion);
      }
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as { version?: number };
      if (!Number.isInteger(body.version)) throw new Error("DSH host 未返回有效画布版本");
      return body.version as number;
    },

    async postFocus(topic, ids, labels): Promise<void> {
      await json(scopedPath("/api/chiaro/focus", workspaceId, topic), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, labels }),
      });
    },

    async loadAgentTerms(topic, signal): Promise<AgentTermCatalog> {
      const catalog = await json<AgentTermCatalog>(
        scopedPath("/api/chiaro/agent-term", workspaceId, topic),
        { cache: "no-store", signal },
      );
      if (!Array.isArray(catalog?.agents) || !Array.isArray(catalog.instances)) {
        throw new Error("DSH host 未返回有效 Agent 终端列表");
      }
      return catalog;
    },

    async postAgentTerm(topic, agent): Promise<AgentTermSession> {
      return validSession(await json(scopedPath("/api/chiaro/agent-term", workspaceId, topic), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      }));
    },

    async resumeAgentTerm(topic, instanceId): Promise<AgentTermSession> {
      return validSession(await json(
        scopedPath(`/api/chiaro/agent-term/${encodeURIComponent(instanceId)}`, workspaceId, topic),
        { method: "POST", headers: { "content-type": "application/json" } },
      ));
    },

    async deleteAgentTerm(topic, instanceId): Promise<void> {
      await json(
        scopedPath(`/api/chiaro/agent-term/${encodeURIComponent(instanceId)}`, workspaceId, topic),
        { method: "DELETE", headers: { "content-type": "application/json" } },
      );
    },

    async uploadAgentAttachment(topic, instanceId, capability, image): Promise<string> {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("读取剪贴板图片失败"));
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("剪贴板图片编码失败"));
        reader.readAsDataURL(image);
      });
      const url = new URL(scopedPath(
        `/api/chiaro/agent-term/${encodeURIComponent(instanceId)}/attachment`,
        workspaceId,
        topic,
      ), location.href);
      url.searchParams.set("cap", capability);
      const result = await json<{ path?: unknown }>(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: image.type, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
      });
      if (typeof result.path !== "string" || !result.path) {
        throw new Error("DSH host 未返回附件路径");
      }
      return result.path;
    },

    async loadHealth(): Promise<HubHealth> {
      const body = await json<{
        version?: unknown;
        topics?: unknown;
        workspaces?: { id?: unknown; path?: unknown }[];
      }>(scopedPath("/api/chiaro/health", workspaceId), { cache: "no-store" });
      const workspace = body.workspaces?.find((item) => item.id === workspaceId);
      const topics = Array.isArray(body.topics)
        ? body.topics.filter((topic): topic is string => typeof topic === "string")
        : [];
      if (typeof body.version !== "string" || typeof workspace?.path !== "string") {
        throw new Error("DSH host 状态格式无效");
      }
      const topic = topics[0] || "";
      return {
        defaultShell: "",
        pid: 0,
        platform: "dsh",
        port: Number(location.port) || (location.protocol === "https:" ? 443 : 80),
        project: workspace.path,
        topic,
        topicDir: topic ? `${workspace.path}/chiaro/${topic}` : workspace.path,
        version: body.version,
      };
    },

    async loadTopics(): Promise<TopicCatalog> {
      const body = await json<{ topics?: unknown }>(
        scopedPath("/api/chiaro/topics", workspaceId),
        { cache: "no-store" },
      );
      if (!Array.isArray(body.topics) || body.topics.some((topic) => typeof topic !== "string")) {
        throw new Error("DSH host 未返回有效 topic 列表");
      }
      return { topic: body.topics[0] || "", topics: body.topics as string[] };
    },

    async createTopic(topic): Promise<TopicCatalog> {
      const body = await json<Partial<TopicCatalog>>("/api/chiaro/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, topic }),
      });
      if (typeof body.topic !== "string" || !Array.isArray(body.topics)) {
        throw new Error("DSH host 未返回有效 topic 列表");
      }
      return body as TopicCatalog;
    },

    async postGesture(topic, operations: GestureOperation[], summary): Promise<void> {
      await json(scopedPath("/api/chiaro/gesture", workspaceId, topic), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations, summary }),
      });
    },

    connectAgentStateEvents(topic, onEvent, onInjection = () => {}): () => void {
      return connectSocket(workspaceId, topic, (message) => {
        if (message.type === "agent-state") onEvent(message as unknown as AgentStateEvent);
        if (message.type === "focus-injection") {
          onInjection(message as unknown as FocusInjectionEvent);
        }
      }, () => {}, () => {});
    },

    connectCanvasUpdates(topic, onUpdate, onError): () => void {
      return connectSocket(workspaceId, topic, (message) => {
        if (message.type === "canvas-updated") onUpdate();
      }, onError, () => {
        onError("");
        onUpdate();
      });
    },

    terminalSocketUrl(session, topic): string {
      const url = new URL("/api/chiaro/term", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("workspaceId", workspaceId);
      url.searchParams.set("topic", topic);
      url.searchParams.set("instanceId", session.instanceId);
      url.searchParams.set("cap", session.capability);
      return url.toString();
    },
  };
}
