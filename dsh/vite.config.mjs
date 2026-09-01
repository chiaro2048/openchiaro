import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  mode: "production",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
