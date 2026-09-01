export const SETTINGS = [{
  id: "terminalFontSize",
  key: "adw.terminal.fontSize",
  label: "终端字号",
  description: "调整 Agent 终端的文字大小。",
  defaultValue: 13,
  min: 8,
  max: 32,
  step: 1,
}];

function normalized(setting, value) {
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
