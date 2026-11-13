import test from "node:test";
import assert from "node:assert/strict";

import { MetricsPlugin } from "../integrations/opencode/plugin.js";

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

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    impl.deliverAll();
    await settle();
  }
}

function usageMessage(sessionID, messageID, tokens) {
  return {
    type: "message.updated",
    properties: { info: { role: "assistant", id: messageID, sessionID, tokens } },
  };
}

test("opencode v1 maps assistant usage caches and tool calls", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });

    await plugin.event({ event: usageMessage("ses_ce7aAAAA-full", "msg-1", {
      input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 },
    }) });
    await plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_ce7aAAAA-full" });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_ce7aAAAA-full" } } });
    await settle();
    assert.equal(fetch.calls.length, 1); // first push holds; idle did not stack a second request

    fetch.deliverAll();
    await new Promise((resolve) => setTimeout(resolve, 30)); // trailing timer is a real timer
    assert.equal(fetch.calls.length, 2); // trailing request carries the tool call
    fetch.deliverAll();
    await settle();

    const body = fetch.calls[1].body;
    assert.match(body, /kind="input"\} 100/);
    assert.match(body, /kind="output"\} 50/);
    assert.match(body, /kind="reasoning"\} 10/);
    assert.match(body, /kind="cache_read"\} 20/);
    assert.match(body, /kind="cache_write"\} 5/);
    assert.match(body, /tool="read"\} 1/);
    assert.match(body, /agent_context_max_tokens\{[^}]*\} 125/); // input + cacheRead + cacheWrite
    assert.match(body, /session="ses_ce7aAAAA-full"/); // full id, not 8 chars
    assert.match(body, /project="demo"/); // public basename label
    await plugin.dispose();
  });
});

test("opencode v1 ignores repeated snapshots and unknown events", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });

    await plugin.event({ event: usageMessage("ses_A-full", "msg-1", { input: 100 }) });
    await plugin.event({ event: usageMessage("ses_A-full", "msg-1", { input: 100 }) }); // duplicate
    await plugin.event({ event: { type: "message.updated", properties: { info: { role: "user", id: "m2", sessionID: "ses_A-full" } } } });
    await plugin.event({ event: { type: "storage.write", properties: {} } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_A-full" } } });
    fetch.deliverAll();
    await settle();

    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].body, /kind="input"\} 100/);
    await plugin.dispose();
  });
});

test("opencode v1 keys projects by plugin input identity", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const byProjectId = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    const byWorktree = await MetricsPlugin({ worktree: "/work/other", directory: "/work/other" }, { endpoint: "https://gateway.example/push" });
    const byDirectory = await MetricsPlugin({ directory: "/work/third" }, { endpoint: "https://gateway.example/push" });

    await byProjectId.event({ event: usageMessage("ses_shared-full", "m1", { input: 100 }) });
    await byWorktree.event({ event: usageMessage("ses_shared-full", "m1", { input: 50 }) });
    await byDirectory.event({ event: usageMessage("ses_shared-full", "m1", { input: 7 }) });

    await byProjectId.event({ event: { type: "session.idle", properties: { sessionID: "ses_shared-full" } } });
    await byWorktree.event({ event: { type: "session.idle", properties: { sessionID: "ses_shared-full" } } });
    await byDirectory.event({ event: { type: "session.idle", properties: { sessionID: "ses_shared-full" } } });
    fetch.deliverAll();
    await settle();

    const inputs = new Map(fetch.calls.map((call) => [call.body.match(/kind="input"\} (\d+)/)[1], call]));
    assert.deepEqual([...inputs.keys()].sort(), ["100", "50", "7"]); // same session id, separate projects
    for (const plugin of [byProjectId, byWorktree, byDirectory]) await plugin.dispose();
  });
});

test("opencode v1 defers delivery during an active push", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });

    await plugin.event({ event: usageMessage("ses_A-full", "m1", { input: 100 }) });
    await plugin.event({ event: usageMessage("ses_A-full", "m2", { input: 10 }) });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_A-full" } } });
    await settle();
    assert.equal(fetch.calls.length, 1); // first push active, idle did not stack a second request

    fetch.deliverAll();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fetch.calls.length, 2); // trailing request carries newest totals
    assert.match(fetch.calls[1].body, /kind="input"\} 110/);
    fetch.deliverAll();
    await settle();
    await plugin.dispose();
  });
});

test("opencode v1 debug-logs events without project identity", async () => {
  const fetch = fetchRecorder();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    await withFetch(fetch, async () => {
      const plugin = await MetricsPlugin({ /* no project/worktree/directory */ }, { endpoint: "https://gateway.example", debug: true });
      await plugin.event({ event: usageMessage("ses_A-full", "m1", { input: 100 }) });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_A-full" } } });
      await settle();
      assert.equal(fetch.calls.length, 0); // undeliverable, never merged anonymously
      assert.equal(errors.join("\n").includes("project"), true);
      await plugin.dispose();
    });
  } finally {
    console.error = original;
  }
});

test("opencode v1 dispose stops delivery", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    await plugin.event({ event: usageMessage("ses_A-full", "m1", { input: 100 }) });
    fetch.deliverAll();
    await settle();
    assert.equal(fetch.calls.length, 1);

    await plugin.dispose();
    await plugin.event({ event: usageMessage("ses_A-full", "m2", { input: 500 }) });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_A-full" } } });
    await settle();
    fetch.deliverAll();
    await settle();
    assert.equal(fetch.calls.length, 1); // disposed: no further delivery
  });
});

test("opencode v1 without endpoint performs no fetch", async () => {
  // config also reads AGENT_METRICS_* from the environment; strip them so the
  // test proves idleness from absent configuration, not from a tenant-less
  // endpoint failing URL resolution
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_METRICS_")) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  const fetch = fetchRecorder();
  try {
    await withFetch(fetch, async () => {
      const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, {});
      await plugin.event({ event: usageMessage("ses_A-full", "m1", { input: 100 }) });
      await plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_A-full" });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_A-full" } } });
      await settle();
      assert.equal(fetch.calls.length, 0);
      await plugin.dispose();
    });
  } finally {
    Object.assign(process.env, saved);
  }
});

test("opencode v1 pairs tool before and after into durations", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      await plugin["tool.execute.before"]({ tool: "edit", sessionID: "ses_A-full", callID: "call-1" }, { args: {} });
      now += 1_500;
      await plugin["tool.execute.after"]({ tool: "edit", sessionID: "ses_A-full", callID: "call-1" }, { metadata: {} });
      await settle();
    } finally {
      Date.now = realNow;
    }
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].body, /agent_tool_duration_seconds_total\{[^}]*tool="edit"\} 1\.5\n/);
    fetch.deliverAll();
    await settle();
    await plugin.dispose();
  });
});

test("opencode v1 counts tool calls without a before pairing", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    await plugin["tool.execute.after"]({ tool: "bash", sessionID: "ses_A-full", callID: "call-late" }, {});
    await settle();
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].body, /agent_tool_calls_total\{[^}]*tool="bash"\} 1\n/);
    assert.equal((fetch.calls[0].body.match(/agent_tool_duration_seconds_total/g) || []).length, 0);
    fetch.deliverAll();
    await settle();
    await plugin.dispose();
  });
});

test("opencode v1 parses file edits from tool result diff metadata", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed line",
      "-removed line 2",
      "+added line",
      "+added line 2",
      "+added line 3",
      "\\ No newline at end of file",
    ].join("\n");
    await plugin["tool.execute.after"]({ tool: "edit", sessionID: "ses_A-full", callID: "call-diff" }, { metadata: { diff } });
    await settle();
    fetch.deliverAll(); // resolve the first push; the trailing request carries the edit
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1].body, /agent_file_edits_total\{[^}]*kind="added"\} 3\n/);
    assert.match(fetch.calls[1].body, /agent_file_edits_total\{[^}]*kind="deleted"\} 2\n/);
    fetch.deliverAll();
    await settle();
    await plugin.dispose();
  });
});

test("opencode v1 maps permission replies to allow and deny decisions", async () => {
  const fetch = fetchRecorder();
  await withFetch(fetch, async () => {
    const plugin = await MetricsPlugin({ project: { id: "proj-1" }, directory: "/work/demo" }, { endpoint: "https://gateway.example/push" });
    await plugin.event({ event: { type: "permission.replied", properties: { sessionID: "ses_A-full", permissionID: "p1", response: "once" } } });
    await plugin.event({ event: { type: "permission.replied", properties: { sessionID: "ses_A-full", permissionID: "p2", response: "always" } } });
    await plugin.event({ event: { type: "permission.replied", properties: { sessionID: "ses_A-full", permissionID: "p3", response: "reject" } } });
    await settle();
    fetch.deliverAll(); // resolve the first push; the trailing request carries the decisions
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1].body, /agent_permission_decisions_total\{[^}]*decision="allow"\} 2\n/);
    assert.match(fetch.calls[1].body, /agent_permission_decisions_total\{[^}]*decision="deny"\} 1\n/);
    fetch.deliverAll();
    await settle();
    await plugin.dispose();
  });
});
