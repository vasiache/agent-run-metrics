import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runEventAdapterSuite } from "../contract-tests/event-adapter.suite.mjs";

const ARTIFACT = path.resolve("dist/opencode/v1/plugin.js");

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function fetchRecorder() {
  const calls = [];
  const resolvers = [];
  const impl = async (_url, options) => {
    calls.push(options);
    return new Promise((resolve) => resolvers.push(() => resolve({ ok: true, status: 200 })));
  };
  impl.calls = calls;
  impl.deliverAll = () => {
    while (resolvers.length) resolvers.shift()();
  };
  return impl;
}

async function importArtifactCopy() {
  const dir = await mkdtemp(path.join(tmpdir(), "arm-artifact-"));
  const copy = path.join(dir, "plugin.js");
  await cp(ARTIFACT, copy);
  const module = await import(pathToFileURL(copy).href);
  return { module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    impl.deliverAll();
    await settle();
  }
}

test("opencode artifact is self-contained with a named export", async () => {
  const source = await readFile(ARTIFACT, "utf8");
  assert.match(source, /export/, "artifact must keep its exports");
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
    assert.match(match[1], /^node:/, `non-builtin import in artifact: ${match[1]}`);
  }
});

test("opencode artifact copy runs parallel sessions with in-flight idle", async () => {
  const { module, cleanup } = await importArtifactCopy();
  try {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await module.MetricsPlugin(
        { project: { id: "proj-1" }, directory: "/work/demo" },
        { endpoint: "https://gateway.example/push" },
      );

      const usage = (sessionID, messageID, input) => ({
        type: "message.updated",
        properties: { info: { role: "assistant", id: messageID, sessionID, tokens: { input } } },
      });

      await plugin.event({ event: usage("ses_ce7aAAAA-full", "m1", 100) }); // session A push active
      await plugin.event({ event: usage("ses_ce7aBBBB-full", "m1", 50) }); // session B pushes independently
      await plugin.event({ event: usage("ses_ce7aAAAA-full", "m2", 10) }); // A dirtier behind active push
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_ce7aAAAA-full" } } });
      await settle();

      assert.equal(fetch.calls.length, 2); // A and B active, no stacked request for A
      fetch.deliverAll();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const bodies = fetch.calls.map((call) => call.body);
      const trailing = bodies.find((body) => body.includes('kind="input"} 110'));
      assert.ok(trailing, "trailing request carries newest A totals");
      assert.match(trailing, /session="ses_ce7aAAAA-full"/);
      fetch.deliverAll();
      await settle();
      await plugin.dispose();
    });
  } finally {
    await cleanup();
  }
});

test("opencode artifact copy without endpoint performs no fetch", async () => {
  const { module, cleanup } = await importArtifactCopy();
  // config also reads AGENT_METRICS_* from the environment; strip them so the
  // test proves idleness from absent configuration alone
  const savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_METRICS_")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await module.MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, {});
      await plugin.event({
        event: { type: "message.updated", properties: { info: { role: "assistant", id: "m1", sessionID: "s", tokens: { input: 1 } } } },
      });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });
      await settle();
      assert.equal(fetch.calls.length, 0);
      await plugin.dispose();
    });
  } finally {
    Object.assign(process.env, savedEnv);
    await cleanup();
  }
});

runEventAdapterSuite({
  label: "opencode v1 artifact",
  createPlugin: async (options) => {
    const { module, cleanup } = await importArtifactCopy();
    const plugin = await module.MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, options);
    const dispose = plugin.dispose.bind(plugin);
    plugin.dispose = async () => {
      await dispose();
      await cleanup();
    };
    return plugin;
  },
  usage: (sessionID, messageID, input) => ({
    type: "message.updated",
    properties: { info: { role: "assistant", id: messageID, sessionID, tokens: { input } } },
  }),
  idle: (sessionID) => ({ type: "session.idle", properties: { sessionID } }),
});
