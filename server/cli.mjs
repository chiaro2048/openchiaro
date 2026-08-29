#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertTopic, scaffoldTopic, topicPaths } from "./paths.mjs";
import {
  APP_VERSION,
  fetchHubHealth,
  hubIdentityError,
  pidIsAlive,
  readHubRecord,
} from "./hub-lock.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "用法：node server/cli.mjs open [topic] --project <dir> [--port <起始端口>] [--no-browser]\n" +
  "　　　node server/cli.mjs restart <topic> --project <dir> [--port <起始端口>]\n" +
  "　　　node server/cli.mjs install [--target <claude|codex|both|绝对路径>]";
const warnedVersions = new Set();

function warnVersion(health) {
  if (health.version === APP_VERSION) return;
  const remote = typeof health.version === "string" && health.version ? health.version : "未提供版本";
  const key = `${health.pid}:${remote}`;
  if (warnedVersions.has(key)) return;
  warnedVersions.add(key);
  console.error(`[chiaro] 警告：版本不一致：CLI ${APP_VERSION}，Hub ${remote}`);
}

async function discoverHub(project, topic) {
  const paths = topicPaths(project, topic);
  const candidates = [];
  for (const [source, file] of [["hub.lock", paths.hubLock], ["hub.json", paths.hubJson]]) {
    const record = await readHubRecord(file);
    if (!record || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
    if (candidates.some((candidate) => candidate.record.port === record.port)) continue;
    candidates.push({ source, record });
  }

  const mismatches = [];
  const unavailable = [];
  for (const candidate of candidates) {
    const health = await fetchHubHealth(candidate.record.port);
    if (!health) {
      unavailable.push(candidate);
      continue;
    }
    const reason = hubIdentityError(health, {
      topic,
      topicDir: paths.dir,
      port: candidate.record.port,
      ...(Number.isInteger(candidate.record.pid) ? { pid: candidate.record.pid } : {}),
    });
    if (reason) {
      mismatches.push({ ...candidate, health, reason });
      continue;
    }
    return { paths, verified: { ...candidate, health }, mismatches, unavailable };
  }
  return { paths, verified: null, mismatches, unavailable };
}

function parseOpenArgs(argv) {
  let topic = "workbench";
  let project = appDir;
  let basePort = 8787;
  let portExplicit = false;
  let noBrowser = false;
  if (argv[0] && !argv[0].startsWith("--")) topic = argv.shift();
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--no-browser") {
      noBrowser = true;
    } else if (flag === "--project" && argv.length) {
      project = path.resolve(argv.shift());
    } else if (flag === "--port" && argv.length) {
      basePort = Number(argv.shift());
      portExplicit = true;
    } else {
      throw new Error(`未知或缺值参数：${flag}`);
    }
  }
  topic = assertTopic(topic.replace(/\.excalidraw$/i, ""));
  // 上限留出 MAX_PORT_PROBES 的余量：open 会从 basePort 往上逐个探测可用端口。
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65500) {
    throw new Error(`端口无效：${basePort}（需为 1~65500 的整数，上限为向上探测预留空间）`);
  }
  return { topic, project, basePort, noBrowser, portExplicit };
}

async function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// 探测端口：free（可尝试占用）/ ours（本 topic 的 hub，可复用）/ taken（别人的）
async function probePort(port, topicDir) {
  const health = await fetchHubHealth(port);
  if (health) {
    const topic = path.basename(topicDir);
    return hubIdentityError(health, { topic, topicDir, port })
      ? { state: "taken", health }
      : { state: "ours", health };
  }
  return { state: await portIsListening(port) ? "taken" : "free" };
}

function spawnHub(project, topic, port) {
  const hub = spawn(process.execPath, [
    path.join(appDir, "server", "index.mjs"),
    "--project", project,
    "--topic", topic,
    "--static", path.join(appDir, "dist"),
    "--port", String(port),
  ], { cwd: appDir, detached: true, stdio: "ignore", windowsHide: true });
  hub.unref();
  return hub;
}

function openBrowser(url) {
  const command = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printOpenResult({ topic, paths, health, spawnedPid, noBrowser }) {
  const port = health.port;
  const url = `http://127.0.0.1:${port}/?topic=${encodeURIComponent(topic)}`;
  if (!noBrowser) openBrowser(url);
  console.log(spawnedPid ? `[chiaro] hub_pid=${spawnedPid}` : "[chiaro] hub=already-running");
  console.log(`[chiaro] topic=${topic} port=${port}`);
  console.log(`[chiaro] hub_json=${paths.hubJson}`);
  console.log(`[chiaro] ${url}`);
}

async function startHub(project, topic, paths, basePort) {
  let port = null;
  let health = null;
  let spawnedPid = null;
  for (let candidate = basePort; candidate < basePort + 20; candidate += 1) {
    const probe = await probePort(candidate, paths.dir);
    if (probe.state === "taken") continue;
    if (probe.state === "ours") {
      port = candidate;
      health = probe.health;
      break;
    }
    // free：尝试在此端口拉起；锁竞态的输家会发现赢家并复用。
    const child = spawnHub(project, topic, candidate);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const discovered = await discoverHub(project, topic);
      if (discovered.verified) {
        port = discovered.verified.health.port;
        health = discovered.verified.health;
        spawnedPid = health.pid === child.pid ? child.pid : null;
        break;
      }
      if (child.exitCode !== null) break;
      await delay(100);
    }
    if (port !== null) break;
    console.error(`[chiaro] 端口 ${candidate} 拉起失败，换下一个`);
  }
  if (port === null) {
    throw new Error(`在 ${basePort}~${basePort + 19} 内找不到可用端口，或 hub 启动失败`);
  }
  return { health: health || await fetchHubHealth(port), spawnedPid };
}

async function stopVerifiedHub(health, reason) {
  if (!Number.isInteger(health.pid) || health.pid <= 0) {
    throw new Error("已验证 Hub 没有可重启的 pid");
  }
  console.error(`[chiaro] ${reason}：停止端口 ${health.port}（pid ${health.pid}）后自动重启`);
  try {
    process.kill(health.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline && pidIsAlive(health.pid)) await delay(100);
  if (pidIsAlive(health.pid)) throw new Error(`Hub pid ${health.pid} 在 7 秒内没有退出`);
}

async function open(argv) {
  const { topic, project, basePort, noBrowser } = parseOpenArgs(argv);
  const paths = await scaffoldTopic(project, topic);
  const discovery = await discoverHub(project, topic);
  if (discovery.verified) {
    const { health } = discovery.verified;
    warnVersion(health);
    if (health.version === APP_VERSION) {
      printOpenResult({ topic, paths, health, spawnedPid: null, noBrowser });
      return;
    }
    await stopVerifiedHub(health, "检测到 Hub 版本不一致");
    const started = await startHub(project, topic, paths, health.port);
    printOpenResult({ topic, paths, ...started, noBrowser });
    return;
  }
  for (const mismatch of discovery.mismatches) {
    console.error(`[chiaro] 忽略身份不符的 ${mismatch.source}：${mismatch.reason}`);
  }
  let started = await startHub(project, topic, paths, basePort);
  if (started.health.version !== APP_VERSION) {
    warnVersion(started.health);
    await stopVerifiedHub(started.health, "检测到 Hub 版本不一致");
    started = await startHub(project, topic, paths, started.health.port);
  }
  printOpenResult({ topic, paths, ...started, noBrowser });
}

async function restart(argv) {
  const parsed = parseOpenArgs(argv);
  const paths = await scaffoldTopic(parsed.project, parsed.topic);
  const discovery = await discoverHub(parsed.project, parsed.topic);
  if (!discovery.verified) {
    if (discovery.mismatches.length) {
      const mismatch = discovery.mismatches[0];
      throw new Error(`hub 身份不符：${mismatch.source} 指向端口 ${mismatch.record.port}，${mismatch.reason}`);
    }
    throw new Error(`没有可重启的 ${parsed.topic} Hub`);
  }
  const old = discovery.verified.health;
  warnVersion(old);
  await stopVerifiedHub(old, "执行 restart");
  const basePort = parsed.portExplicit ? parsed.basePort : old.port;
  const started = await startHub(parsed.project, parsed.topic, paths, basePort);
  printOpenResult({ topic: parsed.topic, paths, ...started, noBrowser: true });
}

// 把 openchiaro skill（SKILL.md + 运行时）装进 agent 的 skills 目录。
// --target 接受 claude / codex / both / 一个绝对路径；默认 claude。
const INSTALL_TARGETS = {
  claude: [".claude", "skills", "openchiaro"],
  codex: [".codex", "skills", "openchiaro"],
};

function resolveInstallTargets(argv) {
  const index = argv.indexOf("--target");
  if (index === -1) return [path.join(os.homedir(), ...INSTALL_TARGETS.claude)];
  const value = argv[index + 1];
  if (!value) throw new Error("--target 需要一个值：claude、codex、both 或绝对路径");
  if (value === "both") {
    return [
      path.join(os.homedir(), ...INSTALL_TARGETS.claude),
      path.join(os.homedir(), ...INSTALL_TARGETS.codex),
    ];
  }
  if (INSTALL_TARGETS[value]) return [path.join(os.homedir(), ...INSTALL_TARGETS[value])];
  if (path.isAbsolute(value)) return [value];
  throw new Error(`--target 无法识别：${value}（用 claude、codex、both 或绝对路径）`);
}

// 旧版本装的是 chiaro 这个名字。两套运行时并存会让 agent 选错 skill，所以装完要提醒。
async function warnAboutLegacyInstall(target) {
  const legacy = path.join(path.dirname(target), "chiaro");
  if (legacy === target) return;
  try {
    await access(legacy);
  } catch {
    return;
  }
  console.error(`[chiaro] 提示：同目录下还有旧名安装 "${legacy}"`);
  console.error("[chiaro] 　　　 两套运行时并存可能让 agent 选错 skill；确认无用后请自行删除（本命令不会替你删）。");
}

async function install(argv = []) {
  const targets = resolveInstallTargets(argv);
  for (const target of targets) await installTo(target);
}

async function findDependencySource(dep) {
  const candidates = [path.join(appDir, "node_modules", dep)];
  const packageNodeModules = path.dirname(appDir);
  if (path.basename(packageNodeModules) === "node_modules") {
    candidates.push(path.join(packageNodeModules, dep));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the npm-hoisted location */ }
  }
  throw new Error(`依赖 ${dep} 未安装`);
}

async function installTo(target) {
  let skillDir = appDir;
  try {
    await access(path.join(skillDir, "SKILL.md"));
    await access(path.join(skillDir, "references"));
  } catch {
    skillDir = path.join(appDir, "skill");
  }
  await mkdir(target, { recursive: true });
  await cp(path.join(skillDir, "SKILL.md"), path.join(target, "SKILL.md"), { force: true });
  await cp(path.join(skillDir, "references"), path.join(target, "references"), {
    recursive: true,
    force: true,
  });
  for (const entry of ["server", "hooks", "dist", "package.json"]) {
    await cp(path.join(appDir, entry), path.join(target, entry), {
      recursive: true,
      force: true,
    });
  }
  for (const dep of ["ws", "@lydell"]) {
    const source = await findDependencySource(dep);
    const destination = path.join(target, "node_modules", dep);
    let sameVersionBeforeCopy = false;
    if (dep === "@lydell") {
      try {
        const sourcePackage = JSON.parse(await readFile(
          path.join(source, "node-pty", "package.json"), "utf8",
        ));
        const targetPackage = JSON.parse(await readFile(
          path.join(destination, "node-pty", "package.json"), "utf8",
        ));
        sameVersionBeforeCopy = sourcePackage.version === targetPackage.version;
      } catch {
        sameVersionBeforeCopy = false;
      }
    }
    try {
      await cp(source, destination, { recursive: true, force: true });
    } catch (error) {
      const locked = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
      if (dep !== "@lydell" || !locked || !sameVersionBeforeCopy) {
        throw new Error(`依赖 ${dep} 拷贝失败（${error.code || error.message}）`);
      }
      console.error(`[chiaro] 警告：@lydell 被 Windows 文件锁占用；目标已有同版本，保留现有文件`);
    }
  }
  const required = [
    path.join(target, "SKILL.md"),
    path.join(target, "server", "cli.mjs"),
    path.join(target, "server", "index.mjs"),
    path.join(target, "hooks", "chiaro-hook.mjs"),
    path.join(target, "dist", "index.html"),
    path.join(target, "package.json"),
    path.join(target, "node_modules", "ws", "package.json"),
    path.join(target, "node_modules", "@lydell", "node-pty", "package.json"),
  ];
  for (const file of required) {
    try {
      await access(file);
    } catch {
      throw new Error(`安装完整性检查失败，缺少：${file}`);
    }
  }
  console.log(`[chiaro] openchiaro skill 已安装："${target}"`);
  console.log(`[chiaro] 入口：node "${path.join(target, "server", "cli.mjs")}" open <topic> --project <项目根>`);
  await warnAboutLegacyInstall(target);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  if (command === "open") return open(argv);
  if (command === "restart") return restart(argv);
  if (command === "install") return install(argv);
  throw new Error(USAGE);
}

main().catch((error) => {
  console.error(`[chiaro] ${error.message}`);
  process.exitCode = 1;
});
