import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionAggregator,
  sessionKey,
} from "../integrations/common/session-aggregator.mjs";

const projectA = { key: "proj-a", label: "proj-a" };
const projectB = { key: "proj-b", label: "proj-b" };

function usageEvent(overrides = {}) {
  return {
    type: "message.usage",
    sessionID: "ses_ce7aAAAA-full",
    messageID: "msg-1",
    project: projectA,
    usage: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

test("session aggregator keeps interleaved sessions separate", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ usage: { input: 100 } }));
  aggregator.apply(usageEvent({
    sessionID: "ses_ce7aBBBB-full",
    messageID: "msg-2",
    usage: { input: 50 },
  }));

  const first = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  const second = aggregator.snapshot(projectB.key === "proj-a" ? projectA : projectA, "ses_ce7aBBBB-full", 1000);
  assert.equal(first.tokens.input, 100);
  assert.equal(second.tokens.input, 50);
});

test("session aggregator counts only nonnegative growth per message", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ usage: { input: 100, output: 20 } }));
  aggregator.apply(usageEvent({ usage: { input: 100, output: 20 } })); // duplicate snapshot
  aggregator.apply(usageEvent({ usage: { input: 150, output: 10 } })); // partial growth + shrink
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.equal(snap.tokens.input, 150);
  assert.equal(snap.tokens.output, 20);
});

test("session aggregator separates identical session ids across projects", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ usage: { input: 100 } }));
  aggregator.apply(usageEvent({ project: projectB, usage: { input: 7 } }));
  assert.equal(aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 0).tokens.input, 100);
  assert.equal(aggregator.snapshot(projectB, "ses_ce7aAAAA-full", 0).tokens.input, 7);
});

test("session aggregator ignores events without project session or message identity", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ project: undefined }));
  aggregator.apply(usageEvent({ sessionID: "" }));
  aggregator.apply(usageEvent({ messageID: "" }));
  aggregator.apply({ type: "message.usage", sessionID: "ses_ce7aAAAA-full", project: projectA, usage: { input: 5 } });
  assert.equal(aggregator.has(sessionKey(projectA.key, "ses_ce7aAAAA-full")), false);
});

test("session aggregator counts tool calls per session", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply({ type: "tool.finished", sessionID: "ses_ce7aAAAA-full", project: projectA, tool: "read" });
  aggregator.apply({ type: "tool.finished", sessionID: "ses_ce7aAAAA-full", project: projectA, tool: "read" });
  aggregator.apply({ type: "tool.finished", sessionID: "ses_ce7aAAAA-full", project: projectA, tool: "edit" });
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.deepEqual(snap.tools, { read: 2, edit: 1 });
});

test("session aggregator derives context from prompt usage only", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({
    usage: { input: 100, output: 500, reasoning: 300, cacheRead: 20, cacheWrite: 5 },
  }));
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.equal(snap.contextMax, 125);
});

test("session aggregator measures duration from the first event", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({}));
  aggregator.apply(usageEvent({ messageID: "msg-2", usage: { input: 1 } }));
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 15000);
  assert.equal(snap.durationSeconds, 15);
});

test("session aggregator evicts least recently used sessions beyond the bound", () => {
  const aggregator = createSessionAggregator({ maxSessions: 2 });
  aggregator.apply(usageEvent({ sessionID: "ses_ce7aAAAA-full" }));
  aggregator.apply(usageEvent({ sessionID: "ses_ce7aBBBB-full", messageID: "msg-2" }));
  aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 0); // touch AAAA
  aggregator.apply(usageEvent({ sessionID: "ses_ce7aCCCC-full", messageID: "msg-3" }));
  assert.equal(aggregator.has(sessionKey(projectA.key, "ses_ce7aAAAA-full")), true);
  assert.equal(aggregator.has(sessionKey(projectA.key, "ses_ce7aBBBB-full")), false);
  assert.equal(aggregator.has(sessionKey(projectA.key, "ses_ce7aCCCC-full")), true);
});

test("session aggregator bounds message snapshots per session", () => {
  const aggregator = createSessionAggregator({ maxMessages: 2 });
  aggregator.apply(usageEvent({ messageID: "m1", usage: { input: 10 } }));
  aggregator.apply(usageEvent({ messageID: "m2", usage: { input: 10 } }));
  aggregator.apply(usageEvent({ messageID: "m3", usage: { input: 10 } })); // evicts m1
  aggregator.apply(usageEvent({ messageID: "m1", usage: { input: 10 } })); // new baseline
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 0);
  assert.equal(snap.tokens.input, 40);
});

test("session aggregator keeps streaming messages out of eviction", () => {
  const aggregator = createSessionAggregator({ maxMessages: 2 });
  aggregator.apply(usageEvent({ messageID: "old", usage: { input: 10 } }));
  aggregator.apply(usageEvent({ messageID: "streaming", usage: { input: 10 } }));
  aggregator.apply(usageEvent({ messageID: "streaming", usage: { input: 20 } })); // touch
  aggregator.apply(usageEvent({ messageID: "new", usage: { input: 10 } })); // evicts "old"
  aggregator.apply(usageEvent({ messageID: "streaming", usage: { input: 30 } }));
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 0);
  assert.equal(snap.tokens.input, 50); // LRU evicted the stale message, streaming kept its snapshot
});

test("session aggregator never recounts shrink-then-recover snapshots", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ usage: { input: 100, output: 20 } }));
  aggregator.apply(usageEvent({ usage: { input: 150, output: 10 } })); // output shrinks
  aggregator.apply(usageEvent({ usage: { input: 150, output: 20 } })); // recovers to previous max
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 0);
  assert.equal(snap.tokens.output, 20);
  assert.equal(snap.tokens.input, 150);
});

test("session aggregator bumps revision only on actual changes", () => {
  const aggregator = createSessionAggregator();
  const key = sessionKey(projectA.key, "ses_ce7aAAAA-full");
  assert.equal(aggregator.revision(key), 0);
  aggregator.apply(usageEvent({}));
  const afterFirst = aggregator.revision(key);
  assert.equal(afterFirst > 0, true);
  aggregator.apply(usageEvent({})); // duplicate: no change
  assert.equal(aggregator.revision(key), afterFirst);
  aggregator.apply(usageEvent({ messageID: "msg-2", usage: { input: 5 } }));
  assert.equal(aggregator.revision(key) > afterFirst, true);
});

test("session aggregator ignores idle events for unknown sessions", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply({ type: "session.idle", sessionID: "ses_unknown-full", project: projectA });
  assert.equal(aggregator.has(sessionKey(projectA.key, "ses_unknown-full")), false);
});

test("session aggregator accumulates file edits as nonnegative counts", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ type: "file.edited", messageID: undefined, added: 12, deleted: 3 }));
  aggregator.apply(usageEvent({ type: "file.edited", messageID: undefined, added: 8, deleted: 0 }));
  aggregator.apply(usageEvent({ type: "file.edited", messageID: undefined, added: -5, deleted: undefined }));
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.deepEqual(snap.edits, { added: 20, deleted: 3 });
});

test("session aggregator counts permission decisions by outcome", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ type: "permission.decided", messageID: undefined, decision: "allow" }));
  aggregator.apply(usageEvent({ type: "permission.decided", messageID: undefined, decision: "allow" }));
  aggregator.apply(usageEvent({ type: "permission.decided", messageID: undefined, decision: "deny" }));
  aggregator.apply(usageEvent({ type: "permission.decided", messageID: undefined, decision: "bogus" }));
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.deepEqual(snap.permissions, { allow: 2, deny: 1 });
});

test("session aggregator sums tool durations per tool and stays without one", () => {
  const aggregator = createSessionAggregator();
  aggregator.apply(usageEvent({ type: "tool.finished", messageID: undefined, tool: "edit", durationMs: 1500 }));
  aggregator.apply(usageEvent({ type: "tool.finished", messageID: undefined, tool: "edit", durationMs: 2500 }));
  aggregator.apply(usageEvent({ type: "tool.finished", messageID: undefined, tool: "bash", durationMs: 125 }));
  aggregator.apply(usageEvent({ type: "tool.finished", messageID: undefined, tool: "read" })); // no duration
  const snap = aggregator.snapshot(projectA, "ses_ce7aAAAA-full", 1000);
  assert.deepEqual(snap.toolDurationMs, { edit: 4000, bash: 125 });
  assert.equal(snap.tools.edit, 2);
});
