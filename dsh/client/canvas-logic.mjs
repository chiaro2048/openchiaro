const normalizePath = (value) => value
  .replaceAll("\\", "/")
  .replace(/\/+$/, "")
  .toLowerCase();

export function resolveWorkspaceId(workspaces, cwd) {
  const current = normalizePath(cwd);
  const match = workspaces
    .map((workspace) => ({ workspace, path: normalizePath(workspace.path) }))
    .filter(({ path }) => current === path || current.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!match) throw new Error(`当前会话目录不属于任何 DSH workspace：${cwd}`);
  return match.workspace.id;
}

export function labelsForSelection(elements, ids) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const labels = [];
  for (const id of ids) {
    const element = byId.get(id);
    if (!element) continue;
    if (typeof element.text === "string") labels.push(element.text);
    for (const bound of element.boundElements || []) {
      if (bound.type !== "text") continue;
      const label = byId.get(bound.id)?.text;
      if (typeof label === "string") labels.push(label);
    }
  }
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

export function terminalSocketUrl(href, workspaceId, topic, session) {
  const url = new URL("/api/chiaro/term", href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("topic", topic);
  url.searchParams.set("instanceId", session.instanceId);
  url.searchParams.set("cap", session.capability);
  return url.toString();
}

export const sceneSignature = (elements) => elements
  .map(({ id, version }) => `${id}:${version}`)
  .join("|");
