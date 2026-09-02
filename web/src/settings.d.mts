export type Theme = "light" | "dark";
export type SettingValue = number | Theme;

export type NumberSettingDefinition = {
  kind: "number";
  id: "terminalFontSize";
  key: string;
  label: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
};

export type SelectSettingDefinition = {
  kind: "select";
  id: "theme";
  key: string;
  label: string;
  description: string;
  defaultValue: Theme;
  options: Array<{ value: Theme; label: string }>;
};

export type SettingDefinition = NumberSettingDefinition | SelectSettingDefinition;
export type SettingsValues = {
  [id: string]: SettingValue;
  terminalFontSize: number;
  theme: Theme;
};

export const SETTINGS: SettingDefinition[];

export function readSettings(storage?: Pick<Storage, "getItem">): SettingsValues;

export function writeSetting(
  storage: Pick<Storage, "setItem">,
  setting: SettingDefinition,
  value: SettingValue,
): SettingValue;
