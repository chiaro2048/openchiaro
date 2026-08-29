import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_VERSION = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8")).version;

export function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function hubIdentityError(health, expected) {
  if (health?.kind !== "chiaro-hub") return "health.kind 不是 chiaro-hub";
  if (health.topic !== expected.topic) return `topic 实际为 ${health.topic ?? "（缺失）"}`;
  if (!samePath(health.topicDir, expected.topicDir)) {
    return `topicDir 实际为 ${health.topicDir ?? "（缺失）"}`;
  }
  if (Number.isInteger(expected.port) && health.port !== expected.port) {
    return `health.port 实际为 ${health.port ?? "（缺失）"}`;
  }
  if (Number.isInteger(expected.pid) && health.pid !== expected.pid) {
    return `health.pid 实际为 ${health.pid ?? "（缺失）"}`;
  }
  return "";
}

export async function fetchHubHealth(port, timeoutMs = 700) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function readHubRecord(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inspectExisting(record, expected) {
  if (!pidIsAlive(record?.pid)) return { active: false };
  const deadline = Date.now() + 2500;
  do {
    const health = await fetchHubHealth(record.port);
    if (health) {
      return {
        active: !hubIdentityError(health, { ...expected, pid: record.pid, port: record.port }),
        health,
      };
    }
    if (Date.now() >= deadline) break;
    await delay(100);
  } while (pidIsAlive(record.pid));
  return { active: false };
}

export async function acquireHubLock(lockPath, { topic, topicDir, port }) {
  const record = { pid: process.pid, port, startedAt: Date.now(), version: APP_VERSION };
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      return record;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
    }

    const existing = await readHubRecord(lockPath);
    const inspected = await inspectExisting(existing, { topic, topicDir });
    if (inspected.active) {
      throw new Error(`该 topic 已有 hub 在端口 ${existing.port}（pid ${existing.pid}）`);
    }

    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        await delay(20);
        continue;
      }
      throw error;
    }
    await unlink(stalePath);
  }
}

export async function releaseHubLock(lockPath, record) {
  const current = await readHubRecord(lockPath);
  if (current?.pid !== record.pid || current?.startedAt !== record.startedAt) return;
  await unlink(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
