const USER_CARD = "#fef3c7";
const AGENT_CARD = "#ddd6fe";
const SUMMARY_LIMIT = 72;
const DIFF_LIMIT = 400;

const visibleElements = (scene) => (
  Array.isArray(scene?.elements) ? scene.elements.filter((element) => !element?.isDeleted) : []
);

const roleOf = (element) => {
  const color = typeof element?.backgroundColor === "string"
    ? element.backgroundColor.toLowerCase()
    : "";
  if (element?.type !== "rectangle") return null;
  if (color === USER_CARD) return "黄卡";
  if (color === AGENT_CARD) return "紫卡";
  return null;
};

const compact = (value, limit = 48) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
};

const limited = (value, limit) => {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
};

function cardsOf(scene) {
  const elements = visibleElements(scene);
  const textByContainer = new Map(elements
    .filter((element) => element.type === "text" && typeof element.containerId === "string")
    .map((element) => [element.containerId, element.originalText ?? element.text ?? ""]));
  return elements.flatMap((element) => {
    const role = roleOf(element);
    if (!role || typeof element.id !== "string") return [];
    return [{
      id: element.id,
      role,
      text: compact(element.text ?? textByContainer.get(element.id)),
    }];
  });
}

const connectionCount = (elements) => elements.filter((element) => (
  element.type === "arrow" || element.type === "line"
)).length;

const cardPreview = (cards) => cards.map(({ text }) => text).filter(Boolean).slice(0, 2)
  .map((text) => `〈${text}〉`).join("、");

export function summarizeScene(scene) {
  const elements = visibleElements(scene);
  const cards = cardsOf(scene);
  const yellow = cards.filter(({ role }) => role === "黄卡");
  const purple = cards.filter(({ role }) => role === "紫卡");
  const connections = connectionCount(elements);
  if (elements.length === 0) {
    return "空画布：0 个元素（黄卡 0 张、紫卡 0 张、连线 0 条）";
  }
  const details = [
    cardPreview(yellow) && `黄卡 ${cardPreview(yellow)}`,
    cardPreview(purple) && `紫卡 ${cardPreview(purple)}`,
  ].filter(Boolean);
  return limited([
    `元素 ${elements.length} 个（黄卡 ${yellow.length} 张、紫卡 ${purple.length} 张、连线 ${connections} 条）`,
    ...details,
  ].join("；"), SUMMARY_LIMIT);
}

function semanticScene(scene) {
  const elements = visibleElements(scene);
  const cards = cardsOf(scene);
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const cardIds = new Set(cardsById.keys());
  const boundCardTextIds = new Set(elements
    .filter((element) => element.type === "text" && cardIds.has(element.containerId))
    .map((element) => element.id));
  const connections = new Set(elements
    .filter((element) => element.type === "arrow" || element.type === "line")
    .map((element) => element.id));
  const others = new Set(elements
    .filter((element) => !cardIds.has(element.id)
      && !boundCardTextIds.has(element.id)
      && !connections.has(element.id))
    .map((element) => element.id));
  return { cardsById, connections, others };
}

const difference = (left, right) => [...left].filter((id) => !right.has(id));

function describeCards(action, cards) {
  const groups = ["黄卡", "紫卡"].flatMap((role) => {
    const selected = cards.filter((card) => card.role === role);
    if (selected.length === 0) return [];
    const preview = cardPreview(selected);
    return [`${action}${role} ${selected.length} 张${preview ? `：${preview}` : ""}`];
  });
  return groups;
}

export function diffScenes(previousScene, nextScene) {
  const previous = semanticScene(previousScene);
  const next = semanticScene(nextScene);
  const addedCards = difference(new Set(next.cardsById.keys()), new Set(previous.cardsById.keys()))
    .map((id) => next.cardsById.get(id));
  const deletedCards = difference(new Set(previous.cardsById.keys()), new Set(next.cardsById.keys()))
    .map((id) => previous.cardsById.get(id));
  const updatedCards = [...next.cardsById.entries()].flatMap(([id, card]) => {
    const before = previous.cardsById.get(id);
    return before && (before.role !== card.role || before.text !== card.text) ? [card] : [];
  });
  const parts = [
    ...describeCards("新增", addedCards),
    ...describeCards("更新", updatedCards),
    ...describeCards("删除", deletedCards),
  ];
  for (const [label, before, after] of [
    ["连线", previous.connections, next.connections],
    ["元素", previous.others, next.others],
  ]) {
    const added = difference(after, before).length;
    const deleted = difference(before, after).length;
    if (added) parts.push(`新增${label} ${added} ${label === "连线" ? "条" : "个"}`);
    if (deleted) parts.push(`删除${label} ${deleted} ${label === "连线" ? "条" : "个"}`);
  }
  return limited(parts.join("；"), DIFF_LIMIT);
}
