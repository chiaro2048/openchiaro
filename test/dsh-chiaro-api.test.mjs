import assert from "node:assert/strict";
import test from "node:test";

import { SceneConflictError } from "../web/src/ChiaroApi.ts";
import { createDshChiaroApi } from "../dsh/client/chiaro-api.ts";

test("dsh Chiaro API scopes HTTP and terminal WebSocket URLs to the workspace", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const calls = [];
  globalThis.location = new URL("https://dsh.test:9443/app");
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      scene: { elements: [] },
      version: 7,
    }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  });

  const api = createDshChiaroApi("workspace one");
  assert.equal((await api.loadScene("topic/a")).version, 7);
  assert.equal(
    calls[0].url,
    "/api/chiaro/scene?workspaceId=workspace+one&topic=topic%2Fa",
  );
  assert.equal(
    api.terminalSocketUrl({ instanceId: "term/1", capability: "secret", resumed: false }, "topic/a"),
    "wss://dsh.test:9443/api/chiaro/term?workspaceId=workspace+one&topic=topic%2Fa&instanceId=term%2F1&cap=secret",
  );
});

test("dsh Chiaro API preserves scene conflict semantics", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ latestVersion: 11 }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    createDshChiaroApi("workspace").postScene("topic", "{\"elements\":[]}", 4),
    (error) => error instanceof SceneConflictError && error.latestVersion === 11,
  );
});
