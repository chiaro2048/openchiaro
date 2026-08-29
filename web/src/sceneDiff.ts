export type VersionedElement = { id: string; version: number };

export type GestureElement = VersionedElement & {
  type: string;
  x: number;
  y: number;
  text?: string;
  boundElements?: readonly { id: string; type: string }[] | null;
};

export type GestureOperation = {
  type: "moved" | "added" | "deleted";
  id: string;
  label: string;
};

export function diffChangedElements<T extends VersionedElement>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const previousVersions = new Map(previous.map(({ id, version }) => [id, version]));
  return next.filter(({ id, version }) => previousVersions.get(id) !== version);
}

function labelFor(element: GestureElement, elementsById: Map<string, GestureElement>) {
  if (typeof element.text === "string" && element.text.trim()) return element.text.trim();
  for (const bound of element.boundElements || []) {
    if (bound.type !== "text") continue;
    const text = elementsById.get(bound.id)?.text?.trim();
    if (text) return text;
  }
  return element.type;
}

export function diffGestureOperations<T extends GestureElement>(
  previous: readonly T[],
  next: readonly T[],
): GestureOperation[] {
  const previousById = new Map(previous.map((element) => [element.id, element]));
  const nextById = new Map(next.map((element) => [element.id, element]));
  const operations: GestureOperation[] = [];

  for (const element of next) {
    const before = previousById.get(element.id);
    if (!before) {
      operations.push({ type: "added", id: element.id, label: labelFor(element, nextById) });
    } else if (before.x !== element.x || before.y !== element.y) {
      operations.push({ type: "moved", id: element.id, label: labelFor(element, nextById) });
    }
  }
  for (const element of previous) {
    if (!nextById.has(element.id)) {
      operations.push({ type: "deleted", id: element.id, label: labelFor(element, previousById) });
    }
  }
  return operations;
}

export function summarizeGestureOperations(operations: readonly GestureOperation[]) {
  const verbs = { moved: "移动", added: "新增", deleted: "删除" } as const;
  return operations.map(({ type, label }) => `${verbs[type]}「${label}」`).join("；");
}
