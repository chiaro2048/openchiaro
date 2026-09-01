import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const buildHash = createHash("sha256");
for (const file of ["canvas-logic.mjs", "chunk.css", "chunk.jsx", "client.js"]) {
  buildHash.update(file).update(readFileSync(path.join(root, "client", file)));
}
const buildVersion = `${packageVersion}+${buildHash.digest("hex").slice(0, 12)}`;

export default defineConfig({
  mode: "production",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __CHIARO_BUILD_VERSION__: JSON.stringify(buildVersion),
  },
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
  build: {
    target: "es2022",
    outDir: path.join(root, "client"),
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: true,
    lib: {
      entry: path.join(root, "client", "chunk.jsx"),
      formats: ["cjs"],
      fileName: () => "excalidraw.js",
      cssFileName: "excalidraw",
    },
    rollupOptions: {
      external: (id) => id === "react" || id.startsWith("react/") || id === "react-dom" || id.startsWith("react-dom/"),
      output: { inlineDynamicImports: true },
      plugins: [{
        name: "dsh-chunk-factory",
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type !== "chunk") continue;
            item.code = `globalThis.__dshChiaroChunks__ ??= {};\nglobalThis.__dshChiaroChunks__.excalidraw = (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n${item.code}\nreturn module.exports;\n};\n`;
          }
        },
      }],
    },
  },
});
