import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const TOPIC_RE = /^[A-Za-z0-9._-]+$/;

export function assertTopic(topic) {
  if (!TOPIC_RE.test(topic)) {
    throw new Error("topic 只能包含 ASCII 字母、数字、点、下划线和短横线");
  }
  return topic;
}

// chiaro/<topic>/ 自包含协作室的全部路径，唯一出处
export function topicPaths(project, topic) {
  assertTopic(topic);
  const root = path.join(project, "chiaro");
  const dir = path.join(root, topic);
  const contextDir = path.join(dir, "context");
  return {
    root,
    dir,
    contextDir,
    canvas: path.join(dir, "canvas.excalidraw"),
    log: path.join(dir, "log.jsonl"),
    hubJson: path.join(contextDir, "hub.json"),
    hubLock: path.join(contextDir, "hub.lock"),
    selection: path.join(contextDir, "selection.json"),
    agentSessions: path.join(contextDir, "agent-sessions.json"),
  };
}

export const EMPTY_SCENE =
  '{"type":"excalidraw","version":2,"source":"chiaro","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}\n';

// 幂等脚手架：建目录，画布缺失则从空模板生成
export async function scaffoldTopic(project, topic) {
  const paths = topicPaths(project, topic);
  await mkdir(paths.contextDir, { recursive: true });
  if (!existsSync(paths.canvas)) {
    await writeFile(paths.canvas, EMPTY_SCENE, "utf8");
  }
  return paths;
}
