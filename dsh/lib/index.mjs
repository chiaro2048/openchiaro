import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WebSocketServer } from "ws";

import { createCanvasStore, VersionConflictError } from "../../server/canvas.mjs";
import { writeFocus } from "../../server/focus.mjs";
import { assertTopic, topicPaths } from "../../server/paths.mjs";

export const name = "dsh-openchiaro";
export const inject = ["webServer", "workspaceRegistry"];

const BODY_LIMIT = 25 * 1024 * 1024;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const CLIENT_DIR = fileURLToPath(new URL("../client/", import.meta.url));
const BUNDLES = new Map([
  ["/chiaro/bundle/excalidraw.js", ["excalidraw.js", "text/javascript; charset=utf-8"]],
  ["/chiaro/bundle/excalidraw.css", ["excalidraw.css", "text/css; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "请求体超过 25 MiB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

function hasSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.host === request.headers.host;
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin) {
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, statusCode, reason) {
  const body = `${reason}\n`;
  socket.end([
    `HTTP/1.1 ${statusCode} Rejected`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

async function listTopics(workspacePath) {
  try {
    const entries = await readdir(path.join(workspacePath, "chiaro"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((topic) => {
        try {
          assertTopic(topic);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function apply(ctx) {
  const canvasStores = new Map();
  const clients = new Map();
  const wsServer = new WebSocketServer({ noServer: true });

  const workspaces = () => ctx.workspaceRegistry.list();
  const workspaceView = (workspace) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
  });

  function resolveWorkspace(url) {
    const requested = url.searchParams.get("workspaceId");
    const workspace = requested
      ? ctx.workspaceRegistry.get(requested)
      : workspaces()[0];
    if (!workspace) {
      throw new HttpError(requested ? 404 : 503, requested
        ? `workspace 不存在：${requested}`
        : "没有可用 workspace");
    }
    return workspace;
  }

  async function resolveTopic(url, workspace) {
    const topics = await listTopics(workspace.path);
    const requested = url.searchParams.get("topic");
    if (requested !== null) {
      try {
        assertTopic(requested);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      if (!topics.includes(requested)) throw new HttpError(404, `topic 不存在：${requested}`);
      return { topic: requested, topics };
    }
    if (topics.length === 0) throw new HttpError(404, "workspace 下没有 topic");
    return { topic: topics[0], topics };
  }

  const keyOf = (workspace, topic) => `${workspace.id}\0${topic}`;
  const broadcast = (workspace, topic) => {
    const message = JSON.stringify({ type: "canvas-updated", workspaceId: workspace.id, topic });
    for (const client of clients.get(keyOf(workspace, topic)) ?? []) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  async function canvasFor(workspace, topic) {
    const key = keyOf(workspace, topic);
    let pending = canvasStores.get(key);
    const paths = topicPaths(workspace.path, topic);
    if (!pending) {
      pending = createCanvasStore(paths.canvas, () => broadcast(workspace, topic));
      canvasStores.set(key, pending);
      pending.catch(() => canvasStores.delete(key));
    }
    return { store: await pending, paths };
  }

  async function handleHttp(request, response) {
    let selected;
    try {
      const url = new URL(request.url ?? "/", "http://dsh.internal");
      const method = request.method ?? "GET";
      const workspace = resolveWorkspace(url);
      const workspaceId = workspace.id;

      if (url.pathname === "/api/chiaro/health" && method === "GET") {
        return sendJson(response, 200, {
          ok: true,
          kind: name,
          workspaceId,
          workspaces: workspaces().map(workspaceView),
          topics: await listTopics(workspace.path),
        });
      }

      if (url.pathname === "/api/chiaro/topics" && method === "GET") {
        return sendJson(response, 200, {
          workspaceId,
          topics: await listTopics(workspace.path),
        });
      }

      const { topic } = await resolveTopic(url, workspace);
      selected = { workspaceId, topic };
      const { store, paths } = await canvasFor(workspace, topic);

      if (url.pathname === "/api/chiaro/scene" && method === "GET") {
        const { raw, version } = await store.read();
        return sendJson(response, 200, {
          ...selected,
          scene: JSON.parse(raw),
          version,
        });
      }

      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        if (!hasSameOrigin(request)) throw new HttpError(403, "request Origin rejected");
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase()
            !== "application/json") {
          throw new HttpError(415, "Content-Type must be application/json");
        }
      }

      if (url.pathname === "/api/chiaro/scene" && method === "POST") {
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || !body.scene) {
          throw new HttpError(400, "需要 {baseVersion, scene}");
        }
        const version = await store.write(JSON.stringify(body.scene), body.baseVersion);
        return sendJson(response, 200, { ok: true, ...selected, version });
      }

      if (url.pathname === "/api/chiaro/focus" && method === "POST") {
        const selection = await writeFocus(paths.contextDir, await readJsonBody(request));
        return sendJson(response, 200, { ...selected, ...selection });
      }

      throw new HttpError(404, "接口不存在");
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return sendJson(response, 409, {
          error: error.message,
          latestVersion: error.latestVersion,
          ...selected,
        });
      }
      const statusCode = error.statusCode || (error instanceof TypeError ? 400 : 500);
      if (statusCode === 500) console.error(`[dsh-openchiaro] HTTP 处理失败：${error.stack || error}`);
      if (!response.headersSent) sendJson(response, statusCode, { error: error.message, ...selected });
      else response.destroy();
    }
  }

  async function handleBundle(request, response) {
    const url = new URL(request.url ?? "/", "http://dsh.internal");
    const bundle = BUNDLES.get(url.pathname);
    if (!bundle) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      const body = await readFile(path.join(CLIENT_DIR, bundle[0]));
      response.writeHead(200, {
        "content-type": bundle[1],
        "cache-control": "no-cache",
        "content-length": String(body.length),
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`[dsh-openchiaro] bundle 读取失败：${error.stack || error}`);
      response.writeHead(404);
      response.end("not found");
    }
  }

  async function handleUpgrade(request, socket, head) {
    try {
      if (!isLoopbackOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, "Chiaro WebSocket Origin rejected");
        return;
      }
      const url = new URL(request.url ?? "/", "http://dsh.internal");
      const workspace = resolveWorkspace(url);
      const { topic } = await resolveTopic(url, workspace);
      await canvasFor(workspace, topic);
      wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        const key = keyOf(workspace, topic);
        const topicClients = clients.get(key) ?? new Set();
        topicClients.add(webSocket);
        clients.set(key, topicClients);
        webSocket.on("close", () => {
          topicClients.delete(webSocket);
          if (topicClients.size === 0) clients.delete(key);
        });
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode === 500) console.error(`[dsh-openchiaro] WS 处理失败：${error.stack || error}`);
      rejectUpgrade(socket, statusCode, error.message);
    }
  }

  ctx.effect(() => {
    const unregisterBundle = ctx.webServer.register({
      kind: "prefix",
      path: "/chiaro/bundle",
      handler: handleBundle,
    });
    const unregisterHttp = ctx.webServer.register({
      kind: "prefix",
      path: "/api/chiaro",
      handler: handleHttp,
    });
    const unregisterWs = ctx.webServer.registerUpgrade({
      path: "/api/chiaro/ws",
      handler: handleUpgrade,
    });
    return async () => {
      unregisterWs();
      unregisterHttp();
      unregisterBundle();
      for (const topicClients of clients.values()) {
        for (const client of topicClients) client.terminate();
      }
      wsServer.close();
      const stores = await Promise.allSettled(canvasStores.values());
      for (const result of stores) {
        if (result.status === "fulfilled") result.value.close();
      }
    };
  }, "dsh-openchiaro: HTTP/WS routes");
}
