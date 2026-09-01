import { watch as fsWatch } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const signatureOf = async (filePath) => {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
};

export class VersionConflictError extends Error {
  constructor(latestVersion) {
    super("画布版本冲突");
    this.latestVersion = latestVersion;
  }
}

export async function createCanvasStore(
  canvasPath,
  onExternalChange,
  {
    watchImpl = fsWatch,
    pollMs = 1000,
    debounceMs = 300,
    selfWriteIgnoreMs = 1500,
  } = {},
) {
  let lastSignature = await signatureOf(canvasPath);
  let lastRaw = await readFile(canvasPath, "utf8");
  let lastSelfWriteAt = 0;
  let lastSelfSignature = "";
  let sceneVersion = 0;
  let debounceTimer;
  let checking;
  let writes = Promise.resolve();

  const refreshFromDisk = async () => {
    if (checking) return checking;
    checking = (async () => {
      const signature = await signatureOf(canvasPath);
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (
        signature === lastSelfSignature &&
        Date.now() - lastSelfWriteAt < selfWriteIgnoreMs
      ) return;
      const raw = await readFile(canvasPath, "utf8");
      const previousRaw = lastRaw;
      lastRaw = raw;
      sceneVersion += 1;
      await onExternalChange(sceneVersion, previousRaw, raw);
    })();
    try {
      await checking;
    } finally {
      checking = undefined;
    }
  };

  const checkForChange = async () => {
    try {
      await refreshFromDisk();
    } catch (error) {
      console.error(`[hub] 检查画布变更失败：${error.stack || error}`);
    }
  };

  const scheduleCheck = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkForChange, debounceMs);
  };

  let watcher = { close() {} };
  try {
    watcher = watchImpl(path.dirname(canvasPath), (_event, filename) => {
      if (!filename || filename.toString() === path.basename(canvasPath)) scheduleCheck();
    });
    watcher.on?.("error", (error) => {
      console.error(`[hub] fs.watch 失败，mtime 轮询仍在运行：${error.stack || error}`);
    });
  } catch (error) {
    console.error(`[hub] fs.watch 启动失败，改用 mtime 轮询：${error.stack || error}`);
  }
  const pollTimer = setInterval(checkForChange, pollMs);
  pollTimer.unref?.();

  return {
    async read() {
      await refreshFromDisk();
      return { raw: await readFile(canvasPath, "utf8"), version: sceneVersion };
    },

    async write(rawScene, baseVersion) {
      let scene;
      try {
        scene = JSON.parse(rawScene);
      } catch {
        throw new TypeError("画布内容不是有效 JSON");
      }
      if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
        throw new TypeError("画布 JSON 必须包含 elements 数组");
      }
      if (!Number.isInteger(baseVersion) || baseVersion < 0) {
        throw new TypeError("baseVersion 必须是非负整数");
      }

      const operation = writes.then(async () => {
        await refreshFromDisk();
        if (baseVersion !== sceneVersion) throw new VersionConflictError(sceneVersion);

        const temporaryPath = `${canvasPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporaryPath, rawScene, "utf8");
        lastSelfWriteAt = Date.now();
        await rename(temporaryPath, canvasPath);
        lastSignature = await signatureOf(canvasPath);
        lastSelfSignature = lastSignature;
        lastRaw = rawScene;
        sceneVersion += 1;
        return sceneVersion;
      });
      // operation 原样返回给调用方；队尾只吸收拒绝，避免污染后续写入。
      writes = operation.catch(() => {});
      return operation;
    },

    close() {
      clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      watcher.close();
    },
  };
}
