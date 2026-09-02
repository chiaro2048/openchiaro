import assert from "node:assert/strict";
import test from "node:test";

import { readSettings, SETTINGS, writeSetting } from "../web/src/settings.mjs";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("主题设置默认 dark，只接受 light/dark", () => {
  const store = storage();
  assert.deepEqual(readSettings(store), { terminalFontSize: 13, theme: "dark" });

  const theme = SETTINGS.find(({ id }) => id === "theme");
  assert.ok(theme);
  assert.equal(writeSetting(store, theme, "light"), "light");
  assert.equal(store.getItem(theme.key), "light");
  assert.equal(writeSetting(store, theme, "sepia"), "dark");
});
