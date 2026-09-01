import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const buildHash = createHash("sha256");
for (const file of [
  "index.html",
  "src/bridge.ts",
  "src/CanvasPane.tsx",
  "src/main.tsx",
  "src/PetDock.tsx",
  "src/sceneDiff.ts",
  "src/SettingsPanel.tsx",
  "src/settings.mjs",
  "src/styles.css",
  "src/TerminalPanel.tsx",
]) {
  buildHash.update(file).update(readFileSync(new URL(file.replaceAll("\\", "/"), new URL("./web/", import.meta.url))));
}
const buildVersion = `${packageVersion}+${buildHash.digest("hex").slice(0, 12)}`;

export default defineConfig({
  define: { __CHIARO_BUILD_VERSION__: JSON.stringify(buildVersion) },
  plugins: [{
    name: "chiaro-build-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-version.json",
        source: `${JSON.stringify({ version: buildVersion })}\n`,
      });
    },
  }],
  root: "web",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
      "/term": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: `${webRoot}index.html`,
      },
    },
  },
});
