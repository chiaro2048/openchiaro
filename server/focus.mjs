import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFocus(contextDir, focus) {
  if (
    !focus ||
    !Array.isArray(focus.ids) ||
    !focus.ids.every((id) => typeof id === "string") ||
    !Array.isArray(focus.labels) ||
    !focus.labels.every((label) => typeof label === "string")
  ) {
    throw new TypeError("focus 必须包含 string[] 类型的 ids 和 labels");
  }

  await mkdir(contextDir, { recursive: true });
  const selection = {
    ts: Date.now(),
    source: "app",
    ids: focus.ids,
    labels: focus.labels,
  };
  await writeFile(
    path.join(contextDir, "selection.json"),
    JSON.stringify(selection),
    "utf8",
  );
  return selection;
}
