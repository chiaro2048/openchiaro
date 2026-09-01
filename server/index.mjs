import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { saveAttachment } from "./attachments.mjs";
import { createCanvasStore, VersionConflictError } from "./canvas.mjs";
import { createEventLog } from "./event-log.mjs";
import { writeFocus } from "./focus.mjs";
import {
  acquireHubLock,
  APP_VERSION,
  readHubRecord,
  releaseHubLock,
} from "./hub-lock.mjs";
import { assertTopic, listTopics, scaffoldTopic, topicPaths } from "./paths.mjs";
import { diffScenes, summarizeScene } from "./scene-summary.mjs";
import { createTermManager, defaultShell } from "./term.mjs";

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--project", "--topic", "--port", "--static", "--agents"].includes(flag) || value === undefined) {
      throw new Error(`未知或缺值参数：${flag ?? "（空）"}`);
    }
    values[flag.slice(2)] = value;
  }

  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const project = path.resolve(values.project || appDir);
  const topic = assertTopic(values.topic || "workbench");
  const port = Number(values.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口无效：${values.port}`);
  }
  return {
    project,
    topic,
    port,
    staticDir: values.static ? path.resolve(values.static) : null,
    agentsPath: values.agents
      ? path.resolve(values.agents)
      : path.join(project, "chiaro", "agents.json"),
    agentsPathRequired: values.agents !== undefined,
  };
}

async function readBody(request, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "请求体超过 25 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function rejectUpgrade(socket, statusCode, reason) {
  const statusText = statusCode === 401 ? "Unauthorized" : "Forbidden";
  const body = `${reason}\n`;
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
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

function hasSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return isLoopbackOrigin(origin) && url.host === request.headers.host;
  } catch {
    return false;
  }
}

function isJsonRequest(request) {
  return request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase()
    === "application/json";
}

function parseAgent(raw) {
  const agent = raw?.trim().toLowerCase();
  if (!agent || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(agent)) {
    throw new HttpError(400, "agent 必须是 1~64 位的名称");
  }
  return agent;
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".csv", "text/csv; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".woff2", "font/woff2"],
]);

async function serveStatic(request, response, pathname, staticDir) {
  if (!staticDir || request.method !== "GET" || pathname.startsWith("/api/")) return false;
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(staticDir, relative);
  if (filePath !== staticDir && !filePath.startsWith(`${staticDir}${path.sep}`)) {
    throw new HttpError(403, "静态文件路径越界");
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    });
    response.end(body);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
  return true;
}

async function serveTopicFile(request, response, pathname, topicDir) {
  if (request.method !== "GET") return false;
  const prefix = pathname.startsWith("/files/")
    ? "/files/"
    : pathname.startsWith("/pages/") ? "/pages/" : null;
  if (!prefix) return false;
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new HttpError(400, "文件路径编码无效");
  }

  const filesDir = path.resolve(topicDir, "files");
  const filePath = path.resolve(filesDir, relative);
  if (filePath !== filesDir && !filePath.startsWith(`${filesDir}${path.sep}`)) {
    throw new HttpError(403, "文件路径越界");
  }
  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "content-type": contentTypes.get(extension) || "application/octet-stream",
    });
    response.end(body);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
  return true;
}

function gestureSummary(operations) {
  const verbs = { moved: "移动", added: "新增", deleted: "删除" };
  return operations.map((operation) => (
    `${verbs[operation.type]}「${operation.label || operation.id}」`
  )).join("；");
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

async function createAgentSessionRegistry(filePath) {
  let registry = { version: 2, instances: {} };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.agents && typeof parsed.agents === "object"
        && !Array.isArray(parsed.agents) && Object.entries(parsed.agents).every(([, entry]) => (
          entry && typeof entry === "object" && !Array.isArray(entry)
          && typeof entry.sessionId === "string" && entry.sessionId
          && typeof entry.termId === "string" && entry.termId
        ))) {
      registry.instances = Object.fromEntries(Object.entries(parsed.agents).map(
        ([agent, entry]) => [entry.termId, {
          agent,
          sessionId: entry.sessionId,
          ordinal: 1,
          startedAt: entry.updatedAt || Date.now(),
          updatedAt: entry.updatedAt || Date.now(),
        }],
      ));
    } else if (parsed?.version !== 2 || !parsed.instances || typeof parsed.instances !== "object"
        || Array.isArray(parsed.instances) || Object.values(parsed.instances).some((entry) => (
          !entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.agent !== "string" || !entry.agent
          || typeof entry.sessionId !== "string" || !entry.sessionId
          || entry.sessionId.length > 256
          || !Number.isInteger(entry.ordinal) || entry.ordinal < 1
          || !Number.isFinite(entry.startedAt)
        ))) {
      throw new Error("agent-sessions schema 无效");
    } else {
      registry = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (!(error instanceof SyntaxError) && error.message !== "agent-sessions schema 无效") throw error;
      console.warn(`[agent-sessions] 忽略损坏记录 ${filePath}：${error.message}`);
    }
  }

  let writes = Promise.resolve();
  const persist = () => {
    const raw = `${JSON.stringify(registry, null, 2)}\n`;
    const operation = writes.then(async () => {
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, raw, "utf8");
      await rename(temporaryPath, filePath);
    });
    writes = operation.catch(() => {});
    return operation;
  };
  return {
    get(instanceId) {
      const entry = registry.instances[instanceId];
      return entry ? { instanceId, ...entry } : null;
    },
    list() {
      return Object.entries(registry.instances).map(([instanceId, entry]) => ({
        instanceId,
        ...entry,
      }));
    },
    record({ instanceId, agent, sessionId, ordinal, startedAt }) {
      registry.instances[instanceId] = {
        agent,
        sessionId,
        ordinal,
        startedAt,
        updatedAt: Date.now(),
      };
      return persist();
    },
    remove(instanceId) {
      delete registry.instances[instanceId];
      return persist();
    },
  };
}

async function main() {
  const {
    project,
    topic,
    port,
    staticDir,
    agentsPath,
    agentsPathRequired,
  } = parseArgs(process.argv.slice(2));
  const topicFs = await scaffoldTopic(project, topic);
  const canvasStores = new Map();
  const eventLogs = new Map();
  const termManagers = new Map();
  const agentStates = new Map();
  const clients = new Map();
  const pendingWrites = new Map();

  async function updateCanvasAwareness(paths, scene, change = "") {
    const pendingPath = path.join(paths.contextDir, "pending-changes.json");
    const previousWrite = pendingWrites.get(pendingPath) ?? Promise.resolve();
    const operation = previousWrite.then(async () => {
      let previous = {};
      try {
        previous = JSON.parse(await readFile(pendingPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[hub] 重建损坏的画布摘要缓存：${error.message}`);
        }
      }
      const info = await stat(paths.canvas);
      const changes = previous && typeof previous === "object" && Array.isArray(previous.changes)
        ? previous.changes.filter((item) => typeof item === "string")
        : [];
      if (change) changes.push(change);
      const temporaryPath = `${pendingPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify({
        signature: `${info.mtimeMs}:${info.size}`,
        summary: summarizeScene(scene),
        changes: changes.slice(-20),
      }), "utf8");
      await rename(temporaryPath, pendingPath);
    });
    pendingWrites.set(pendingPath, operation.catch(() => {}));
    return operation;
  }

  const broadcast = (selectedTopic, payload) => {
    const message = JSON.stringify(payload);
    for (const client of clients.get(selectedTopic) ?? []) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  function setAgentState(selectedTopic, instanceId, agent, state) {
    if (!instanceId) return;
    const states = agentStates.get(selectedTopic) ?? new Map();
    agentStates.set(selectedTopic, states);
    if (state === null) {
      states.delete(instanceId);
      return;
    }
    if (states.get(instanceId)?.state === state) return;
    states.set(instanceId, { agent, state });
    broadcast(selectedTopic, { type: "agent-state", instanceId, agent, state });
  }

  async function currentFocusLabels(paths) {
    try {
      const raw = await readFile(paths.selection, "utf8");
      const selection = JSON.parse(raw);
      return Array.isArray(selection.labels) ? selection.labels : [];
    } catch {
      return [];
    }
  }

  async function resolveTopic(url) {
    const requested = url.searchParams.get("topic");
    if (requested === null) return topic;
    try {
      assertTopic(requested);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (!(await listTopics(project)).includes(requested)) {
      throw new HttpError(404, `topic 不存在：${requested}`);
    }
    return requested;
  }

  async function canvasFor(selectedTopic) {
    let pending = canvasStores.get(selectedTopic);
    if (!pending) {
      pending = (async () => {
        const paths = await scaffoldTopic(project, selectedTopic);
        const initialScene = JSON.parse(await readFile(paths.canvas, "utf8"));
        await updateCanvasAwareness(paths, initialScene);
        return createCanvasStore(paths.canvas, async (_version, previousRaw, raw) => {
          const scene = JSON.parse(raw);
          await updateCanvasAwareness(paths, scene, diffScenes(JSON.parse(previousRaw), scene));
          broadcast(selectedTopic, { type: "canvas-updated" });
        });
      })();
      canvasStores.set(selectedTopic, pending);
      pending.catch(() => canvasStores.delete(selectedTopic));
    }
    return pending;
  }

  async function eventLogFor(selectedTopic) {
    let pending = eventLogs.get(selectedTopic);
    if (!pending) {
      pending = createEventLog(topicPaths(project, selectedTopic).log);
      eventLogs.set(selectedTopic, pending);
      pending.catch(() => eventLogs.delete(selectedTopic));
    }
    return pending;
  }

  async function termFor(selectedTopic) {
    let pending = termManagers.get(selectedTopic);
    if (!pending) {
      pending = (async () => {
        const paths = await scaffoldTopic(project, selectedTopic);
        const manager = await createTermManager({
          project,
          topic: selectedTopic,
          port,
          selectionPath: paths.selection,
          agentsPath,
          agentsPathRequired,
          agentSessions: await createAgentSessionRegistry(paths.agentSessions),
          onAgentState: (instanceId, agent, state) => (
            setAgentState(selectedTopic, instanceId, agent, state)
          ),
        });
        return { manager, paths, eventLog: await eventLogFor(selectedTopic), topic: selectedTopic };
      })();
      termManagers.set(selectedTopic, pending);
      pending.catch(() => termManagers.delete(selectedTopic));
    }
    return pending;
  }

  const { manager: terms } = await termFor(topic);
  const lockRecord = await acquireHubLock(topicFs.hubLock, {
    topic,
    topicDir: topicFs.dir,
    port,
  });
  let canvasStore;
  try {
    canvasStore = await canvasFor(topic);
  } catch (error) {
    await terms.close();
    await releaseHubLock(topicFs.hubLock, lockRecord);
    throw error;
  }


  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const { pathname } = url;
      if (["POST", "DELETE"].includes(request.method)) {
        if (!hasSameOrigin(request)) throw new HttpError(403, "request Origin rejected");
        if (!isJsonRequest(request)) throw new HttpError(415, "Content-Type must be application/json");
      }
      if (request.method === "GET" && pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          kind: "chiaro-hub",
          topic,
          project,
          topicDir: topicFs.dir,
          port,
          pid: process.pid,
          version: APP_VERSION,
          platform: process.platform,
          defaultShell: defaultShell(),
          terms: terms.count(),
          termMode: terms.mode,
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/topics") {
        sendJson(response, 200, { topic, topics: await listTopics(project) });
        return;
      }

      if (request.method === "POST" && pathname === "/api/topics") {
        const body = parseJson(await readBody(request));
        if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).some((key) => key !== "topic")
            || typeof body.topic !== "string" || !body.topic) {
          throw new HttpError(400, "需要 {topic}");
        }
        try {
          assertTopic(body.topic);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        await scaffoldTopic(project, body.topic);
        sendJson(response, 201, {
          ok: true,
          topic: body.topic,
          topics: await listTopics(project),
        });
        return;
      }

      if (await serveStatic(request, response, pathname, staticDir)) return;

      const selectedTopic = await resolveTopic(url);
      const selectedPaths = topicPaths(project, selectedTopic);

      if (request.method === "POST" && pathname === "/api/agent-term") {
        const body = parseJson(await readBody(request));
        if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).some((key) => key !== "agent")) {
          throw new HttpError(400, "请求体只能包含 agent");
        }
        const { manager } = await termFor(selectedTopic);
        sendJson(response, 200, await manager.spawnAgent(parseAgent(body.agent)));
        return;
      }

      if (request.method === "GET" && pathname === "/api/agent-term") {
        const { manager } = await termFor(selectedTopic);
        sendJson(response, 200, manager.listAgentTerms());
        return;
      }

      const agentTermAttachment = pathname.match(/^\/api\/agent-term\/([^/]+)\/attachment$/);
      if (request.method === "POST" && agentTermAttachment) {
        const instanceId = decodeURIComponent(agentTermAttachment[1]);
        const { manager } = await termFor(selectedTopic);
        if (!manager.authorize(instanceId, url.searchParams.get("cap"))) {
          throw new HttpError(401, "terminal capability rejected");
        }
        const attachment = await saveAttachment(
          selectedPaths.contextDir,
          parseJson(await readBody(request)),
        );
        sendJson(response, 201, { path: attachment.path });
        return;
      }

      const agentTermInstance = pathname.match(/^\/api\/agent-term\/([^/]+)$/);
      if (request.method === "POST" && agentTermInstance) {
        const { manager } = await termFor(selectedTopic);
        sendJson(response, 200, await manager.resumeAgent(decodeURIComponent(agentTermInstance[1])));
        return;
      }

      if (request.method === "POST" && pathname === "/api/hook-event") {
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          throw new HttpError(403, "hook-event 只接受 loopback 请求");
        }
        const body = parseJson(await readBody(request));
        const allowed = new Set(["type", "agent", "termId", "sessionId", "text", "injection"]);
        const injection = body?.injection;
        const validInjection = injection === undefined || (
          body.type === "prompt"
          && injection && typeof injection === "object" && !Array.isArray(injection)
          && Object.keys(injection).every((key) => ["status", "reason"].includes(key))
          && ["ok", "none", "failed"].includes(injection.status)
          && typeof injection.reason === "string" && injection.reason.length <= 1000
        );
        if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).some((key) => !allowed.has(key))
            || !["prompt", "stop"].includes(body.type)
            || typeof body.termId !== "string" || !body.termId
            || typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256
            || typeof body.text !== "string" || (body.type === "prompt" && !body.text)
            || !validInjection) {
          throw new HttpError(400, "需要 {type:prompt|stop, agent, termId, sessionId, text}");
        }
        const agent = parseAgent(body.agent);
        const settled = await Promise.allSettled(termManagers.values());
        const entry = settled
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value)
          .find(({ manager }) => manager.has(body.termId));
        if (!entry?.manager.authorizeHook(
          body.termId,
          agent,
          request.headers["x-chiaro-hook-secret"],
        )) {
          throw new HttpError(403, "hook secret rejected");
        }

        const record = body.type === "prompt"
          ? await entry.eventLog.append({
            actor: "user",
            kind: "user_msg",
            text: body.text,
            focus: await currentFocusLabels(entry.paths),
            recipients: [agent],
            termId: body.termId,
            sessionId: body.sessionId,
          })
          : body.text ? await entry.eventLog.append({
            actor: agent,
            kind: "agent_msg",
            text: body.text,
            termId: body.termId,
            sessionId: body.sessionId,
          }) : null;
        await entry.manager.recordProviderSession(body.termId, body.sessionId);
        setAgentState(entry.topic, body.termId, agent, body.type === "prompt" ? "working" : "listening");
        if (body.type === "prompt" && injection) {
          broadcast(entry.topic, { type: "focus-injection", agent, ...injection });
        }
        sendJson(response, 200, { ok: true, seq: record?.seq ?? null });
        return;
      }

      const agentTermDelete = pathname.match(/^\/api\/agent-term\/([^/]+)$/);
      if (request.method === "DELETE" && agentTermDelete) {
        const instanceId = decodeURIComponent(agentTermDelete[1]);
        const { manager } = await termFor(selectedTopic);
        if (!await manager.deleteInstance(instanceId)) {
          throw new HttpError(404, `agent instance not found: ${instanceId}`);
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && pathname === "/api/scene") {
        const { raw, version } = await (await canvasFor(selectedTopic)).read();
        sendJson(response, 200, { scene: JSON.parse(raw), version });
        return;
      }

      if (request.method === "POST" && pathname === "/api/scene") {
        const body = parseJson(await readBody(request));
        if (!body || typeof body !== "object" || !body.scene) {
          throw new HttpError(400, "需要 {baseVersion, scene}");
        }
        const store = await canvasFor(selectedTopic);
        const previousScene = JSON.parse((await store.read()).raw);
        const version = await store.write(JSON.stringify(body.scene), body.baseVersion);
        await updateCanvasAwareness(
          selectedPaths,
          body.scene,
          diffScenes(previousScene, body.scene),
        );
        sendJson(response, 200, { ok: true, version });
        return;
      }

      if (request.method === "POST" && pathname === "/api/focus") {
        const selection = await writeFocus(selectedPaths.contextDir, parseJson(await readBody(request)));
        sendJson(response, 200, selection);
        return;
      }

      if (request.method === "POST" && pathname === "/api/gesture") {
        const body = parseJson(await readBody(request));
        const operations = body?.operations;
        if (
          !Array.isArray(operations) || operations.length === 0 || operations.length > 1000 ||
          !operations.every((operation) => (
            operation && ["moved", "added", "deleted"].includes(operation.type) &&
            typeof operation.id === "string" && typeof operation.label === "string"
          ))
        ) {
          throw new HttpError(400, "operations 必须是非空的 moved/added/deleted 操作数组");
        }
        const summary = typeof body.summary === "string" && body.summary.trim()
          ? body.summary.trim().slice(0, 4000)
          : gestureSummary(operations).slice(0, 4000);
        const event = await (await eventLogFor(selectedTopic)).append({
          actor: "user",
          kind: "user_canvas_op",
          operations,
          summary,
        });
        sendJson(response, 200, { ok: true, seq: event.seq });
        return;
      }

      if (pathname.startsWith("/files/") || pathname.startsWith("/pages/")) {
        if (await serveTopicFile(request, response, pathname, selectedPaths.dir)) return;
        sendJson(response, 404, { error: "文件不存在" });
        return;
      }
      sendJson(response, 404, { error: "接口不存在" });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        sendJson(response, 409, { latestVersion: error.latestVersion });
        return;
      }
      const statusCode = error.statusCode || (error instanceof TypeError ? 400 : 500);
      console.error(`[hub] ${request.method} ${request.url}：${error.stack || error}`);
      if (!response.headersSent) sendJson(response, statusCode, { error: error.message });
      else response.destroy();
    }
  });

  const wsServer = new WebSocketServer({ noServer: true });
  const termWsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;
    if (pathname === "/ws") {
      if (!isLoopbackOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, "Hub WebSocket Origin rejected");
        return;
      }
      void (async () => {
        const selectedTopic = await resolveTopic(url);
        await canvasFor(selectedTopic);
        wsServer.handleUpgrade(request, socket, head, (webSocket) => {
          const topicClients = clients.get(selectedTopic) ?? new Set();
          topicClients.add(webSocket);
          clients.set(selectedTopic, topicClients);
          for (const [instanceId, { agent, state }] of agentStates.get(selectedTopic) ?? []) {
            webSocket.send(JSON.stringify({ type: "agent-state", instanceId, agent, state }));
          }
          webSocket.on("close", () => {
            topicClients.delete(webSocket);
            if (topicClients.size === 0) clients.delete(selectedTopic);
          });
        });
      })().catch((error) => rejectUpgrade(socket, error.statusCode || 500, error.message));
      return;
    }
    const termMatch = pathname.match(/^\/term\/([^/]+)$/);
    const termId = termMatch?.[1];
    if (!termId) {
      socket.destroy();
      return;
    }
    if (!isLoopbackOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, "terminal WebSocket Origin rejected");
      return;
    }
    void (async () => {
      const selectedTopic = await resolveTopic(url);
      const { manager } = await termFor(selectedTopic);
      if (!manager.has(termId) || !manager.authorize(termId, url.searchParams.get("cap"))) {
        rejectUpgrade(socket, 401, "terminal capability rejected");
        return;
      }
      termWsServer.handleUpgrade(request, socket, head, (webSocket) => {
        manager.attach(termId, webSocket);
      });
    })().catch((error) => rejectUpgrade(socket, error.statusCode || 500, error.message));
  });

  let closing = false;
  const removeOwnedDiscoveryFiles = async () => {
    const hint = await readHubRecord(topicFs.hubJson);
    if (hint?.pid === process.pid && hint?.startedAt === lockRecord.startedAt) {
      await unlink(topicFs.hubJson).catch(() => {});
    }
    await releaseHubLock(topicFs.hubLock, lockRecord);
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    const stores = await Promise.allSettled(canvasStores.values());
    for (const result of stores) if (result.status === "fulfilled") result.value.close();
    const managers = await Promise.allSettled(termManagers.values());
    await Promise.all(managers
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.manager.close()));
    for (const topicClients of clients.values()) {
      for (const client of topicClients) client.close();
    }
    wsServer.close();
    termWsServer.close();
    server.close();
    server.closeAllConnections?.();
    try {
      await removeOwnedDiscoveryFiles();
      process.exit(0);
    } catch (error) {
      console.error(`[hub] 清理发现文件失败：${error.stack || error}`);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  server.requestTimeout = 0;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    await writeFile(topicFs.hubJson, JSON.stringify({
      port,
      pid: process.pid,
      topic,
      project,
      topicDir: topicFs.dir,
      startedAt: lockRecord.startedAt,
      version: APP_VERSION,
    }), "utf8");
    console.log(`[hub] http://127.0.0.1:${port}`);
    console.log(`[hub] project=${project}`);
    console.log(`[hub] topic=${topic} dir=${topicFs.dir}`);
  } catch (error) {
    canvasStore.close();
    await terms.close();
    await releaseHubLock(topicFs.hubLock, lockRecord);
    throw error;
  }
}

main().catch((error) => {
  console.error(`[hub] 启动失败：${error.stack || error}`);
  process.exitCode = 1;
});
