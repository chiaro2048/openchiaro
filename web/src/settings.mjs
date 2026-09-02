export const SETTINGS = [{
  kind: "number",
  id: "terminalFontSize",
  key: "adw.terminal.fontSize",
  label: "终端字号",
  description: "调整 Agent 终端的文字大小。",
  defaultValue: 13,
  min: 8,
  max: 32,
  step: 1,
}, {
  kind: "select",
  id: "theme",
  key: "adw.theme",
  label: "主题",
  description: "切换 Chiaro 的明暗外观。",
  defaultValue: "dark",
  options: [
    { value: "light", label: "亮色" },
    { value: "dark", label: "深色" },
  ],
}];

function normalized(setting, value) {
  if (setting.kind === "select") {
    return setting.options.some((option) => option.value === value)
      ? value
      : setting.defaultValue;
  }
  if (value === null || value === undefined) return setting.defaultValue;
  const number = Number(value);
  if (!Number.isFinite(number)) return setting.defaultValue;
  return Math.min(setting.max, Math.max(setting.min, Math.round(number)));
}

export function readSettings(storage) {
  return Object.fromEntries(SETTINGS.map((setting) => [
    setting.id,
    normalized(setting, storage?.getItem(setting.key)),
  ]));
}

export function writeSetting(storage, setting, value) {
  const next = normalized(setting, value);
  storage.setItem(setting.key, String(next));
  return next;
}
