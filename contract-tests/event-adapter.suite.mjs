// Shared contract suite for event-driven adapters (stateful session core).
// A host integration proves its adapter against these scenarios by passing a
// createPlugin factory and host-shaped event builders. See docs/adapter-template.md.
import test from "node:test";
import assert from "node:assert/strict";

export function fetchRecorder() {
  const calls = [];
  const resolvers = [];
  const impl = async (_url, options) => {
    calls.push(options);
    return new Promise((resolve) => resolvers.push(() => {
      impl.settled++;
      resolve({ ok: true, status: 200 });
    }));
  };
  impl.calls = calls;
  impl.settled = 0;
  impl.deliverAll = () => {
    while (resolvers.length) resolvers.shift()();
  };
  return impl;
}

// load-tolerant waits: fixed sleeps flake under the parallel test runner
export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

export async function waitUntil(condition, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

export async function withFetch(impl, run) {
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

// wait for a started push to appear, deliver it, wait for completion
async function deliverPush(fetch, index) {
  assert.ok(await waitUntil(() => fetch.calls.length > index), `push ${index} never started`);
  fetch.deliverAll();
  await waitUntil(() => fetch.settled > index);
}

// createPlugin(options) -> { event, "tool.execute.after"?, dispose }
// builders: usage(sessionID, messageID, input), idle(sessionID), tool(sessionID, name)
export async function runEventAdapterSuite({ label, createPlugin, usage, idle, tool }) {
  test(`${label}: parallel sessions stay separate`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_ce7aAAAA-full", "m1", 100) });
      await plugin.event({ event: usage("ses_ce7aBBBB-full", "m1", 50) });
      await waitUntil(() => fetch.calls.length === 2);
      assert.equal(fetch.calls.length, 2);
      const inputs = fetch.calls.map((call) => call.body.match(/kind="input"\} (\d+)/)[1]).sort();
      assert.deepEqual(inputs, ["100", "50"]);
      fetch.deliverAll();
      await waitUntil(() => fetch.settled >= 2);
      await plugin.dispose();
    });
  });

  test(`${label}: duplicate usage snapshots add zero growth`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_A-full", "m1", 100) });
      await plugin.event({ event: usage("ses_A-full", "m1", 100) }); // duplicate snapshot
      await plugin.event({ event: idle("ses_A-full") });
      await deliverPush(fetch, 0);
      const bodies = fetch.calls.map((call) => call.body);
      const last = bodies[bodies.length - 1];
      assert.match(last, /kind="input"\} 100/); // duplicate counted once
      await plugin.dispose();
    });
  });

  test(`${label}: idle during an active push trails the newest totals`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_A-full", "m1", 100) });
      await plugin.event({ event: usage("ses_A-full", "m2", 10) });
      await plugin.event({ event: idle("ses_A-full") });
      await settle();
      assert.equal(fetch.calls.length, 1); // no stacked concurrent request
      await deliverPush(fetch, 0);
      assert.ok(await waitUntil(() => fetch.calls.length >= 2), "trailing push never started");
      fetch.deliverAll();
      await waitUntil(() => fetch.settled >= 2);
      const trailing = fetch.calls[fetch.calls.length - 1];
      assert.match(trailing.body, /kind="input"\} 110/);
      await plugin.dispose();
    });
  });

  test(`${label}: session labels keep full identifiers`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_ce7aAAAA-and-more", "m1", 7) });
      await plugin.event({ event: idle("ses_ce7aAAAA-and-more") });
      await deliverPush(fetch, 0);
      for (const call of fetch.calls) {
        assert.match(call.body, /session="ses_ce7aAAAA-and-more"/);
      }
      await plugin.dispose();
    });
  });

  test(`${label}: tool calls land in a later revision`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      assert.ok(plugin["tool.execute.after"] || plugin.tool, "adapter must expose a tool hook");
      const fireTool = plugin["tool.execute.after"]
        ? (session, name) => plugin["tool.execute.after"]({ tool: name, sessionID: session })
        : (session, name) => plugin.tool({ session, name });
      await plugin.event({ event: usage("ses_A-full", "m1", 5) });
      await fireTool("ses_A-full", "read");
      await plugin.event({ event: idle("ses_A-full") });
      await deliverPush(fetch, 0);
      assert.ok(await waitUntil(() => fetch.calls.length >= 2), "revised push never started");
      fetch.deliverAll();
      await waitUntil(() => fetch.settled >= 2);
      const bodies = fetch.calls.map((call) => call.body);
      assert.ok(bodies.some((body) => /tool="read"\} 1/.test(body)), "tool call delivered");
      await plugin.dispose();
    });
  });

  test(`${label}: dispose stops delivery`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_A-full", "m1", 100) });
      await deliverPush(fetch, 0);
      const before = fetch.calls.length;
      await plugin.dispose();
      await plugin.event({ event: usage("ses_A-full", "m2", 500) });
      await plugin.event({ event: idle("ses_A-full") });
      await settle();
      assert.equal(fetch.calls.length, before);
    });
  });

  test(`${label}: idle flush delivers a dirty non-active session`, async () => {
    const fetch = fetchRecorder();
    await withFetch(fetch, async () => {
      const plugin = await createPlugin({ endpoint: "https://gateway.example/push" });
      await plugin.event({ event: usage("ses_A-full", "m1", 100) }); // dirty, first push starts
      await deliverPush(fetch, 0);
      const before = fetch.calls.length;
      await plugin.event({ event: usage("ses_A-full", "m2", 20) }); // dirtier, throttle timer only
      await plugin.event({ event: idle("ses_A-full") }); // sole delivery trigger
      assert.ok(await waitUntil(() => fetch.calls.length > before), "idle flush must deliver a dirty session");
      const last = fetch.calls[fetch.calls.length - 1];
      assert.match(last.body, /kind="input"\} 120/);
      fetch.deliverAll();
      await waitUntil(() => fetch.settled >= fetch.calls.length);
      await plugin.dispose();
    });
  });

  test(`${label}: no endpoint performs no fetch`, async () => {
    // config also reads AGENT_METRICS_* from the environment; strip them so the
    // test proves idleness from absent configuration alone
      const savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_METRICS_")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
    const fetch = fetchRecorder();
    try {
      await withFetch(fetch, async () => {
        const plugin = await createPlugin({});
        await plugin.event({ event: usage("ses_A-full", "m1", 100) });
        await plugin.event({ event: idle("ses_A-full") });
        await settle();
        assert.equal(fetch.calls.length, 0);
        await plugin.dispose();
      });
    } finally {
      Object.assign(process.env, savedEnv);
    }
  });
}
