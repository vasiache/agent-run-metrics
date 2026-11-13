import test from "node:test";
import assert from "node:assert/strict";

import { createSessionAggregator, sessionKey } from "../integrations/common/session-aggregator.mjs";
import { createEventMetrics } from "../integrations/common/event-metrics.mjs";

const project = { key: "proj-a", label: "proj-a" };
const config = {
  enabled: true,
  endpoint: "https://gateway.example",
  job: "job",
  runtime: "opencode",
  instance: "host",
  labels: { user: "u" },
  token: null,
  tokenFile: null,
  debug: false,
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function usage(sessionID, messageID, input) {
  return {
    type: "message.usage",
    sessionID,
    messageID,
    project,
    usage: { input },
  };
}

function deferredClient() {
  const calls = [];
  const resolvers = [];
  return {
    calls,
    resolvers,
    push: (payload) => new Promise((resolve) => {
      calls.push(payload);
      resolvers.push(() => resolve(true));
    }),
    deliver: (index) => resolvers[index](),
  };
}

function failingClient(results) {
  const calls = [];
  return {
    calls,
    push: async (payload) => {
      calls.push(payload);
      return results.shift() ?? true;
    },
  };
}

function fakeScheduler() {
  const pendingTimers = new Map();
  let nextId = 1;
  let cleared = 0;
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pendingTimers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      if (pendingTimers.delete(id)) cleared++;
    },
    get pending() {
      return pendingTimers.size;
    },
    get clearedCount() {
      return cleared;
    },
    get waits() {
      return [...pendingTimers.values()].map((t) => t.ms);
    },
    fireAll() {
      for (const [id, t] of [...pendingTimers]) {
        pendingTimers.delete(id);
        t.fn();
      }
    },
  };
}

test("event metrics serializes pushes per session and trails the newest totals", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  await settle();
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].body, /kind="input"\} 100/);
  assert.equal(client.calls[0].labels.session, "ses_A-full");
  assert.equal(client.calls[0].labels.project, "proj-a");
  assert.equal(client.calls[0].labels.runtime, "opencode");

  metrics.handle(usage("ses_A-full", "m2", 50));
  await settle();
  assert.equal(client.calls.length, 1); // active request: no concurrent push
  assert.equal(scheduler.pending, 0); // trailing schedules at completion, not eagerly

  metrics.flush({ project, sessionID: "ses_A-full" });
  await settle();
  assert.equal(client.calls.length, 1); // idle during active request: no second request

  client.deliver(0);
  await settle();
  assert.equal(scheduler.pending, 1); // exactly one trailing timer after completion
  scheduler.fireAll();
  await settle();
  assert.equal(client.calls.length, 2); // exactly one trailing request
  assert.match(client.calls[1].body, /kind="input"\} 150/);
});

test("event metrics pushes an independent session in parallel", async () => {
  const client = deferredClient();
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler: fakeScheduler(),
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  metrics.handle(usage("ses_B-full", "m1", 10));
  await settle();
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].labels.session, "ses_B-full");
});

test("event metrics throttles repeated events into one pending timer", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  let time = 0;
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => time },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  client.deliver(0);
  await settle();
  assert.equal(client.calls.length, 1);

  time = 1000;
  metrics.handle(usage("ses_A-full", "m2", 10));
  await settle();
  assert.equal(client.calls.length, 1);
  assert.equal(scheduler.pending, 1);
  assert.deepEqual(scheduler.waits, [14000]);

  time = 2000;
  metrics.handle(usage("ses_A-full", "m3", 10));
  await settle();
  assert.equal(scheduler.pending, 1); // one trailing timer total

  scheduler.fireAll();
  await settle();
  assert.equal(client.calls.length, 2);
  client.deliver(1);
});

test("event metrics idle flush bypasses throttle only for dirty sessions", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  let time = 0;
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => time },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  client.deliver(0);
  await settle();

  time = 1000;
  metrics.handle(usage("ses_A-full", "m2", 10));
  await settle();
  assert.equal(scheduler.pending, 1);

  metrics.flush({ project, sessionID: "ses_A-full" });
  await settle();
  assert.equal(client.calls.length, 2); // dirty: immediate bypass
  assert.equal(scheduler.pending, 0); // timer superseded by flush
  assert.equal(scheduler.clearedCount, 1);
  client.deliver(1);

  metrics.flush({ project, sessionID: "ses_A-full" });
  await settle();
  assert.equal(client.calls.length, 2); // unchanged: no push
});

test("event metrics ignores idle flush for unknown sessions", async () => {
  const client = deferredClient();
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler: fakeScheduler(),
  });

  metrics.flush({ project, sessionID: "ses_unknown-full" });
  await settle();
  assert.equal(client.calls.length, 0);
});

test("event metrics retries after a failed delivery on the next flush", async () => {
  const client = failingClient([false, true]);
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler: fakeScheduler(),
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  await settle();
  assert.equal(client.calls.length, 1);

  metrics.flush({ project, sessionID: "ses_A-full" });
  await settle();
  assert.equal(client.calls.length, 2); // failed delivery stays dirty
});

test("event metrics dispose delivers final state and quiesces", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  let time = 0;
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => time },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100)); // push 1 active
  metrics.handle(usage("ses_B-full", "m1", 10)); // push 2 active
  await settle();
  time = 1000;
  metrics.handle(usage("ses_A-full", "m2", 10)); // A dirty behind active push
  metrics.handle(usage("ses_C-full", "m1", 5)); // C push active

  const disposal = metrics.dispose();
  for (let round = 0; round < 6; round++) {
    await settle();
    while (client.resolvers.length) client.resolvers.shift()();
  }
  await disposal;

  assert.equal(scheduler.pending, 0); // no timers left
  const finalCalls = client.calls.length;
  assert.ok(finalCalls >= 4); // trailing/final delivery for A happened
  assert.match(client.calls[finalCalls - 1].body, /kind="input"\} 110/);

  metrics.handle(usage("ses_A-full", "m9", 500));
  await settle();
  assert.equal(client.calls.length, finalCalls); // disposed: no new network work
});

test("event metrics dispose makes one failed final attempt", async () => {
  const client = failingClient([false, false]);
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler: fakeScheduler(),
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  await settle();
  assert.equal(client.calls.length, 1);

  await metrics.dispose();
  assert.equal(client.calls.length, 2); // exactly one final attempt
});

test("event metrics resumes delivery after aggregator eviction resets revisions", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  const aggregator = createSessionAggregator();
  const metrics = createEventMetrics({
    config,
    client,
    aggregator,
    clock: { now: () => 0 },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100)); // push 1, delivered
  await settle();
  client.deliver(0);
  await settle();
  assert.equal(client.calls.length, 1);

  // force-evict the delivered session from the aggregator: its revision
  // restarts below the remembered deliveredRevision
  aggregator.apply(usage("ses_pad-full", "p1", 1));
  for (let i = 0; i < 1001; i++) {
    aggregator.apply(usage(`ses_churn-${i}-full`, "m", i));
  }
  assert.equal(aggregator.has(sessionKey("proj-a", "ses_A-full")), false);

  metrics.handle(usage("ses_A-full", "m2", 10)); // recreate at low revision
  await settle();
  assert.equal(scheduler.pending > 0 || client.calls.length === 2, true, "delivery must resume");
  scheduler.fireAll();
  await settle();
  assert.equal(client.calls.length, 2);
  client.deliver(1);
  await settle();
  // evicted session restarts at a new aggregator baseline (documented spec
  // behavior): the resumed delivery carries post-eviction totals only
  assert.match(client.calls[1].body, /kind="input"\} 10/);
});

test("event metrics bounds its delivery state to maxSessions", async () => {
  const client = failingClient([true]);
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler: fakeScheduler(),
    maxSessions: 2,
  });

  metrics.handle(usage("ses_1-full", "m", 1));
  metrics.handle(usage("ses_2-full", "m", 1));
  await settle();
  metrics.handle(usage("ses_3-full", "m", 1));
  await settle();
  assert.equal(client.calls.length, 3);

  // churn until eviction would occur; no crash, later sessions still deliver
  for (let i = 4; i < 10; i++) metrics.handle(usage(`ses_${i}-full`, "m", 1));
  await settle();
  assert.ok(client.calls.length >= 4);
});

test("event metrics delivers edits permissions and tool durations in the session body", async () => {
  const client = deferredClient();
  const scheduler = fakeScheduler();
  const metrics = createEventMetrics({
    config,
    client,
    aggregator: createSessionAggregator(),
    clock: { now: () => 0 },
    scheduler,
  });

  metrics.handle(usage("ses_A-full", "m1", 100));
  metrics.handle({ type: "tool.finished", sessionID: "ses_A-full", project, tool: "edit", durationMs: 1500 });
  metrics.handle({ type: "file.edited", sessionID: "ses_A-full", project, added: 12, deleted: 3 });
  metrics.handle({ type: "permission.decided", sessionID: "ses_A-full", project, decision: "allow" });
  await settle();
  client.deliver(0); // resolve the immediate push; its finally schedules the trailing timer
  await settle();
  scheduler.fireAll();
  await settle();
  assert.equal(client.calls.length, 2);

  const body = client.calls[1].body;
  assert.match(body, /agent_file_edits_total\{[^}]*kind="added"\} 12\n/);
  assert.match(body, /agent_file_edits_total\{[^}]*kind="deleted"\} 3\n/);
  assert.match(body, /agent_permission_decisions_total\{[^}]*decision="allow"\} 1\n/);
  assert.match(body, /agent_tool_duration_seconds_total\{[^}]*tool="edit"\} 1\.5\n/);
  client.deliver(1);
  await settle();
});
