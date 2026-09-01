export type SettingDefinition = {
  id: string;
  key: string;
  label: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
};

export const SETTINGS: SettingDefinition[];

export function readSettings(storage?: Pick<Storage, "getItem">): Record<string, number>;

export function writeSetting(
  storage: Pick<Storage, "setItem">,
  setting: SettingDefinition,
  value: number,
): number;
