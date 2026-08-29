import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function createEventLog(logPath) {
  await mkdir(path.dirname(logPath), { recursive: true });

  let raw = "";
  try {
    raw = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const initialLines = raw.split(/\r?\n/).filter(Boolean);
  let seq = initialLines.length
    ? Number(JSON.parse(initialLines.at(-1)).seq)
    : 0;
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`事件日志末行 seq 无效：${logPath}`);
  }

  let writes = Promise.resolve();
  return {
    path: logPath,

    async append(event) {
      const record = { seq: ++seq, ts: Date.now(), ...event };
      const line = `${JSON.stringify(record)}\n`;
      writes = writes.then(() => appendFile(logPath, line, "utf8"));
      await writes;
      return record;
    },
  };
}
