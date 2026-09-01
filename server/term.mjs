import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 200 * 1024;
const MAX_DEAD_SESSIONS = 10;
const MAX_ACTIVE_SESSIONS = 8;
const RESUME_PROBE_MS = 1500;
const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "chiaro-hook.mjs",
);

const BUILTIN_AGENTS = {
  claude: {
    cmd: ["claude"],
    resume: ["claude", "--resume", "{sessionId}"],
    label: "Claude",
  },
  codex: {
    cmd: ["codex"],
    resume: ["codex", "resume", "{sessionId}"],
    label: "Codex",
  },
};

export function defaultShell() {
  return process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/sh");
}

function positiveInteger(value, fallback, name) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    const error = new Error(`${name} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function configError(configPath, message) {
  return new Error(`agent 配置 ${configPath}：${message}`);
}

function assertPtyCwd(project) {
  const reject = (reason) => {
    const error = new Error(`PTY 工作目录不可用：${project}（${reason}）`);
    error.statusCode = 422;
    throw error;
  };
  if (path.win32.parse(project).root.startsWith("\\\\")) reject("不支持 UNC 路径");
  if (!path.isAbsolute(project)) reject("必须是绝对路径");
  try {
    if (!statSync(project).isDirectory()) reject("不是目录");
  } catch (error) {
    if (error.statusCode === 422) throw error;
    reject(error.code || error.message);
  }
}

function validateArgv(value, field, configPath) {
  if (!Array.isArray(value) || value.length === 0
      || value.some((arg) => typeof arg !== "string" || !arg)) {
    throw configError(configPath, `${field} 必须是非空 argv 字符串数组`);
  }
  return [...value];
}

function validateDefinition(name, value, configPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(configPath, `agents.${name} 必须是对象`);
  }
  const unknown = Object.keys(value).filter((key) => !["cmd", "resume", "label"].includes(key));
  if (unknown.length > 0) {
    throw configError(configPath, `agents.${name} 含未知字段：${unknown.join(", ")}`);
  }
  const definition = { cmd: validateArgv(value.cmd, `agents.${name}.cmd`, configPath) };
  if (value.resume !== undefined) {
    definition.resume = validateArgv(value.resume, `agents.${name}.resume`, configPath);
    if (!definition.resume.some((arg) => arg.includes("{sessionId}"))) {
      throw configError(configPath, `agents.${name}.resume 缺少 {sessionId} 占位符`);
    }
  }
  if (value.label !== undefined) {
    if (typeof value.label !== "string" || !value.label.trim()) {
      throw configError(configPath, `agents.${name}.label 必须是非空字符串`);
    }
    definition.label = value.label.trim();
  }
  return definition;
}

async function loadAgentConfig(configPath, required) {
  let overrides = {};
  try {
    const raw = await readFile(configPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw configError(configPath, `不是有效 JSON：${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || !parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)
        || Object.keys(parsed).some((key) => key !== "agents")) {
      throw configError(configPath, "根对象必须且只能包含 agents 对象");
    }
    overrides = parsed.agents;
    for (const [name, definition] of Object.entries(overrides)) {
      if (BUILTIN_AGENTS[name]?.resume
          && definition && typeof definition === "object" && !Array.isArray(definition)
          && !Object.hasOwn(definition, "resume")) {
        console.warn(
          `[term] 项目 agents.json 整条覆盖了内置 ${name}，但未提供 resume；该 agent 将无法冷恢复`,
        );
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" || required) throw error;
  }

  const merged = { ...BUILTIN_AGENTS, ...overrides };
  const validated = Object.create(null);
  for (const [name, definition] of Object.entries(merged)) {
    if (!/^[a-z0-9_.-]{1,64}$/.test(name)) {
      throw configError(configPath, `agent 名无效：${name}`);
    }
    validated[name] = validateDefinition(name, definition, configPath);
  }
  return validated;
}

function resolveWindowsExecutable(command) {
  if (process.platform !== "win32" || path.extname(command)) return command;
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const upperCandidate = path.join(directory, `${command}${extension.toUpperCase()}`);
      if (existsSync(upperCandidate)) return upperCandidate;
    }
  }
  return command;
}

function quoteCmdArg(value) {
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function ptyInvocation(argv) {
  const executable = resolveWindowsExecutable(argv[0]);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [executable, ...argv.slice(1)].map(quoteCmdArg).join(" ")],
    };
  }
  return { file: executable, args: argv.slice(1) };
}

function appendOutput(session, data) {
  const text = String(data);
  session.output.push(text);
  session.outputBytes += Buffer.byteLength(text);

  while (session.outputBytes > MAX_OUTPUT_BYTES) {
    const excess = session.outputBytes - MAX_OUTPUT_BYTES;
    const first = session.output[0];
    const firstBytes = Buffer.byteLength(first);
    if (firstBytes <= excess) {
      session.output.shift();
      session.outputBytes -= firstBytes;
      continue;
    }

    const buffer = Buffer.from(first);
    let offset = excess;
    while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1;
    const trimmed = buffer.subarray(offset).toString("utf8");
    session.output[0] = trimmed;
    session.outputBytes = session.outputBytes - firstBytes + Buffer.byteLength(trimmed);
  }

  for (const socket of session.sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
      socket.close(1013, "terminal client too slow");
      continue;
    }
    socket.send(text);
  }
}

function expandResume(argv, sessionId) {
  return argv.map((arg) => arg.replaceAll("{sessionId}", sessionId));
}

async function loadPty() {
  if (process.env.CHIARO_TEST_DISABLE_PTY === "1") return null;
  try {
    const module = await import("@lydell/node-pty");
    return module.spawn || module.default?.spawn || null;
  } catch (error) {
    console.warn(`[term] @lydell/node-pty unavailable; PTY agent terminals disabled: ${error.message}`);
    return null;
  }
}

export async function createTermManager({
  project = process.cwd(),
  topic = "workbench",
  port,
  selectionPath,
  agentsPath = path.join(project, "chiaro", "agents.json"),
  agentsPathRequired = false,
  agentSessions = { get: () => null, list: () => [], record: async () => {}, remove: async () => {} },
  onAgentState = () => {},
} = {}) {
  const agentConfig = await loadAgentConfig(agentsPath, agentsPathRequired);
  const spawnPty = await loadPty();
  const sessions = new Map();

  function removeSession(session) {
    sessions.delete(session.id);
  }

  function nextOrdinal(agent) {
    const used = new Set([
      ...[...sessions.values()]
        .filter((session) => session.agent === agent)
        .map(({ ordinal }) => ordinal),
      ...agentSessions.list()
        .filter((entry) => entry.agent === agent)
        .map(({ ordinal }) => ordinal),
    ]);
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    return ordinal;
  }

  function pruneDeadSessions() {
    const dead = [...sessions.values()]
      .filter(({ alive }) => !alive)
      .sort((left, right) => right.startedAt - left.startedAt);
    for (const session of dead.slice(MAX_DEAD_SESSIONS)) removeSession(session);
  }

  function finish(session) {
    if (!session.alive) return;
    session.alive = false;
    session.writer = null;
    onAgentState(session.id, session.agent, "away");
    for (const socket of session.sockets) socket.close(1000, "terminal exited");
    session.sockets.clear();
    pruneDeadSessions();
  }

  function launch(session, argv, onExit) {
    assertPtyCwd(project);
    const { file, args } = ptyInvocation(argv);
    const terminal = spawnPty(file, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: project,
      env: {
        ...process.env,
        CHIARO_TOPIC: topic,
        CHIARO_HUB_PORT: String(port),
        CHIARO_SELECTION_PATH: selectionPath,
        CHIARO_TERM_ID: session.id,
        CHIARO_AGENT: session.agent,
        CHIARO_HOOK_SECRET: session.hookSecret,
        CHIARO_HOOK_PATH: HOOK_PATH,
      },
    });
    terminal.onData((data) => appendOutput(session, data));
    let resolveExit;
    session.exit = new Promise((resolve) => { resolveExit = resolve; });
    terminal.onExit((event) => {
      try {
        onExit(event);
      } finally {
        resolveExit(event);
      }
    });
    session.process = {
      write: (data) => terminal.write(data),
      resize: (cols, rows) => terminal.resize(cols, rows),
      kill: () => terminal.kill(),
    };
  }

  function sessionResponse(session) {
    return {
      instanceId: session.id,
      capability: session.capability,
      resumed: session.resumed,
      ...(session.freshStart ? { freshStart: true } : {}),
    };
  }

  async function startAgent(agent, {
    instanceId = randomUUID(),
    ordinal = nextOrdinal(agent),
    saved = null,
    startedAt = Date.now(),
  } = {}) {
    const definition = agentConfig[agent];
    if (!definition) {
      const error = new Error(`agent 未配置：${agent}`);
      error.statusCode = 404;
      throw error;
    }
    if (!spawnPty) {
      const error = new Error("PTY 不可用，不能创建 agent 终端会话");
      error.statusCode = 503;
      throw error;
    }
    if ([...sessions.values()].filter(({ alive }) => alive).length >= MAX_ACTIVE_SESSIONS) {
      const error = new Error(`agent 实例已达到上限（${MAX_ACTIVE_SESSIONS}）`);
      error.statusCode = 409;
      throw error;
    }
    if (saved && !definition.resume) {
      const error = new Error(`agent 不支持恢复：${agent}`);
      error.statusCode = 409;
      throw error;
    }

    const session = {
      id: instanceId,
      agent,
      definition,
      ordinal,
      capability: randomBytes(32).toString("hex"),
      hookSecret: randomBytes(32).toString("hex"),
      startedAt,
      alive: true,
      output: [],
      outputBytes: 0,
      sockets: new Set(),
      writer: null,
      process: null,
      stopped: false,
      resumed: false,
      freshStart: false,
      preserveResume: false,
    };
    sessions.set(session.id, session);
    if (saved) {
      let exitedDuringProbe = false;
      let probeFailure = "unknown failure";
      let probing = true;
      let resolveExit;
      let probeTimer;
      const exit = new Promise((resolve) => { resolveExit = resolve; });
      try {
        launch(session, expandResume(definition.resume, saved.sessionId), (event) => {
          if (probing) {
            exitedDuringProbe = true;
            probeFailure = `exitCode=${event?.exitCode ?? "unknown"}, signal=${event?.signal ?? "none"}`;
            resolveExit(event);
          } else {
            finish(session);
            if (!session.preserveResume) {
              agentSessions.remove(session.id).catch((error) => {
                console.warn(`[term] 清理已退出 resume 记录失败：${error.message}`);
              });
            }
          }
        });
        await Promise.race([
          exit,
          new Promise((resolve) => { probeTimer = setTimeout(resolve, RESUME_PROBE_MS); }),
        ]);
      } catch (error) {
        exitedDuringProbe = true;
        probeFailure = error instanceof Error ? error.message : String(error);
      }
      clearTimeout(probeTimer);
      probing = false;
      if (session.stopped) {
        const error = new Error(`agent resume cancelled: ${agent}`);
        error.statusCode = 409;
        throw error;
      }
      if (!exitedDuringProbe) {
        session.resumed = true;
        onAgentState(session.id, agent, "listening");
        return sessionResponse(session);
      }
      console.warn(`[term] agent resume probe failed: ${agent}: ${probeFailure}`);
      await agentSessions.remove(session.id);
      appendOutput(session, "\r\n[Chiaro] 恢复失败，已启动新会话（fresh start）。\r\n");
      try {
        launch(session, definition.cmd, () => finish(session));
      } catch (error) {
        finish(session);
        throw error;
      }
      onAgentState(session.id, agent, "listening");
      session.freshStart = true;
      return sessionResponse(session);
    }

    try {
      launch(session, definition.cmd, () => finish(session));
    } catch (error) {
      removeSession(session);
      throw error;
    }
    onAgentState(session.id, agent, "listening");
    return sessionResponse(session);
  }

  function spawnAgent(agent) {
    return startAgent(agent);
  }

  function resumeAgent(instanceId) {
    const existing = sessions.get(instanceId);
    if (existing?.alive) return sessionResponse(existing);
    const saved = agentSessions.get(instanceId);
    if (!saved) {
      const error = new Error(`agent instance not found: ${instanceId}`);
      error.statusCode = 404;
      throw error;
    }
    if (existing) removeSession(existing);
    return startAgent(saved.agent, {
      instanceId,
      ordinal: saved.ordinal,
      saved,
      startedAt: saved.startedAt,
    });
  }

  function listAgentTerms() {
    const agents = Object.entries(agentConfig).map(([agent, definition]) => ({
      agent,
      label: definition.label || agent,
    }));
    const instances = new Map(agentSessions.list().map((saved) => [saved.instanceId, {
      instanceId: saved.instanceId,
      agent: saved.agent,
      label: agentConfig[saved.agent]?.label || saved.agent,
      ordinal: saved.ordinal,
      alive: false,
      resumable: Boolean(agentConfig[saved.agent]?.resume),
      startedAt: saved.startedAt,
    }]));
    for (const session of sessions.values()) {
      const saved = agentSessions.get(session.id);
      if (!session.alive && !saved) continue;
      instances.set(session.id, {
        instanceId: session.id,
        agent: session.agent,
        label: session.definition.label || session.agent,
        ordinal: session.ordinal,
        alive: session.alive,
        resumable: !session.alive && Boolean(session.definition.resume && saved),
        startedAt: session.startedAt,
      });
    }
    return {
      agents,
      instances: [...instances.values()].sort((left, right) => (
        left.startedAt - right.startedAt || left.instanceId.localeCompare(right.instanceId)
      )),
    };
  }

  function kill(id, remove = false) {
    const session = sessions.get(id);
    if (!session) return false;
    if (session.alive) {
      session.stopped = true;
      finish(session);
      session.process.kill();
    }
    if (remove) removeSession(session);
    return true;
  }

  async function deleteInstance(instanceId) {
    const saved = agentSessions.get(instanceId);
    const agent = sessions.get(instanceId)?.agent || saved?.agent;
    const killed = kill(instanceId, true);
    if (!killed && !saved) return false;
    await agentSessions.remove(instanceId);
    onAgentState(instanceId, agent, null);
    return true;
  }

  function recordProviderSession(instanceId, sessionId) {
    const session = sessions.get(instanceId);
    if (!session) return Promise.resolve();
    return agentSessions.record({
      instanceId,
      agent: session.agent,
      sessionId,
      ordinal: session.ordinal,
      startedAt: session.startedAt,
    });
  }

  function authorize(id, capability) {
    const expected = sessions.get(id)?.capability;
    if (!expected || typeof capability !== "string" || capability.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(capability), Buffer.from(expected));
  }

  function authorizeHook(id, agent, secret) {
    const session = sessions.get(id);
    const expected = session?.hookSecret;
    if (!expected || session.agent !== agent || typeof secret !== "string"
        || secret.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  }

  function attach(id, socket) {
    const session = sessions.get(id);
    if (!session) return false;
    const canWrite = session.writer === null;
    if (canWrite) session.writer = socket;
    session.sockets.add(socket);
    const replay = session.output.join("");
    if (replay) socket.send(replay);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, "invalid terminal message");
        return;
      }
      if ((message?.type === "input" || message?.type === "resize") && !canWrite) {
        socket.close(1008, "terminal is read-only");
        return;
      }
      if (message?.type === "input" && typeof message.data === "string") {
        if (session.alive) session.process.write(message.data);
        return;
      }
      if (message?.type === "resize") {
        try {
          const cols = positiveInteger(message.cols, undefined, "cols");
          const rows = positiveInteger(message.rows, undefined, "rows");
          if (session.alive) session.process.resize(cols, rows);
        } catch {
          socket.close(1008, "invalid terminal size");
        }
        return;
      }
      socket.close(1003, "invalid terminal message");
    });
    socket.on("close", () => {
      session.sockets.delete(socket);
      if (session.writer === socket) session.writer = null;
    });
    if (!session.alive) setImmediate(() => socket.close(1000, "terminal exited"));
    return true;
  }

  async function close() {
    const exits = [];
    for (const session of [...sessions.values()]) {
      session.preserveResume = true;
      if (session.alive && session.exit) exits.push(session.exit);
      kill(session.id, true);
    }
    await Promise.race([
      Promise.allSettled(exits),
      new Promise((resolve) => { setTimeout(resolve, 1000); }),
    ]);
  }

  return {
    mode: spawnPty ? "pty" : "pipes",
    spawnAgent,
    resumeAgent,
    listAgentTerms,
    kill,
    deleteInstance,
    recordProviderSession,
    authorize,
    authorizeHook,
    attach,
    has: (id) => sessions.has(id),
    count: () => [...sessions.values()].filter(({ alive }) => alive).length,
    close,
  };
}
