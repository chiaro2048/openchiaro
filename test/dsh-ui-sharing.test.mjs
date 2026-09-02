import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dsh chunk reuses the shared canvas and terminal UI", async () => {
  const [source, dshStyles, sharedStyles] = await Promise.all([
    readFile(new URL("../dsh/client/chunk.jsx", import.meta.url), "utf8"),
    readFile(new URL("../dsh/client/chunk.css", import.meta.url), "utf8"),
    readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /web\/src\/CanvasPane\.tsx/);
  assert.match(source, /web\/src\/TerminalPanel\.tsx/);
  assert.match(source, /ChiaroApiContext\.Provider/);
  assert.match(source, /web\/src\/styles\.css/);
  assert.doesNotMatch(source, /@excalidraw\/excalidraw/);
  assert.doesNotMatch(source, /@xterm\/(?:xterm|addon-fit)/);
  assert.doesNotMatch(source, /function ChiaroTerminal/);
  assert.ok(source.split(/\r?\n/).length < 400, "chunk.jsx should stay a shell and adapter");
  assert.doesNotMatch(dshStyles, /\.(?:outline|terminal-(?:panel|stage|view)|pet)(?:[-:{.\s])/);
  assert.match(sharedStyles, /\.outline-rail/);
  assert.match(sharedStyles, /\.terminal-injection-notice/);
});
