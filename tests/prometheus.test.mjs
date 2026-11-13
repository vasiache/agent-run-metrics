import test from "node:test";
import assert from "node:assert/strict";

import { renderPrometheus } from "../integrations/common/prometheus.mjs";

const labels = { runtime: "opencode", user: "u", session: "ses_ce7aAAAA-full", project: "demo" };

test("prometheus renders counters tools gauges and duration", () => {
  const text = renderPrometheus({
    labels,
    tokens: { input: 100, output: 50 },
    tools: { read: 2 },
    contextMax: 125,
    durationSeconds: 15,
  });

  assert.match(text, /# TYPE agent_tokens_total counter\n/);
  assert.match(text, /agent_tokens_total\{runtime="opencode",user="u",session="ses_ce7aAAAA-full",project="demo",kind="input"\} 100\n/);
  assert.match(text, /agent_tokens_total\{[^}]*kind="output"\} 50\n/);
  assert.match(text, /# TYPE agent_tool_calls_total counter\n/);
  assert.match(text, /agent_tool_calls_total\{[^}]*tool="read"\} 2\n/);
  assert.match(text, /# TYPE agent_context_max_tokens gauge\n/);
  assert.match(text, /agent_context_max_tokens\{runtime="opencode"[^}]*\} 125\n/);
  assert.match(text, /# TYPE agent_run_duration_seconds gauge\n/);
  assert.match(text, /agent_run_duration_seconds\{runtime="opencode"[^}]*\} 15\n/);
  assert.match(text, /\n$/);
});

test("prometheus emits one TYPE line per family", () => {
  const text = renderPrometheus({
    labels,
    tokens: { input: 1, output: 2, cache_read: 3 },
    tools: {},
    contextMax: 5,
    durationSeconds: 1,
  });
  assert.equal((text.match(/# TYPE agent_tokens_total counter/g) || []).length, 1);
  assert.equal((text.match(/# TYPE agent_tool_calls_total counter/g) || []).length, 0);
  assert.equal((text.match(/# TYPE agent_context_max_tokens gauge/g) || []).length, 1);
  assert.equal((text.match(/# TYPE agent_run_duration_seconds gauge/g) || []).length, 1);
});

test("prometheus escapes label values", () => {
  const text = renderPrometheus({
    labels: { user: 'a"b\\c\nd' },
    tokens: {},
    tools: {},
    contextMax: 0,
    durationSeconds: 0,
  });
  assert.match(text, /user="a\\"b\\\\c\\nd"/);
});

test("prometheus renders empty label set without braces content", () => {
  const text = renderPrometheus({
    labels: {},
    tokens: { input: 1 },
    tools: {},
    contextMax: 2,
    durationSeconds: 3,
  });
  assert.match(text, /agent_context_max_tokens\{?\}? 2/);
});

test("prometheus renders edit permission and tool duration families", () => {
  const text = renderPrometheus({
    labels,
    tokens: {},
    tools: { edit: 2 },
    toolDurationMs: { edit: 4000, bash: 125 },
    edits: { added: 20, deleted: 3 },
    permissions: { allow: 2, deny: 1 },
    contextMax: 0,
    durationSeconds: 0,
  });

  assert.match(text, /# TYPE agent_file_edits_total counter\n/);
  assert.match(text, /agent_file_edits_total\{[^}]*kind="added"\} 20\n/);
  assert.match(text, /agent_file_edits_total\{[^}]*kind="deleted"\} 3\n/);
  assert.match(text, /# TYPE agent_permission_decisions_total counter\n/);
  assert.match(text, /agent_permission_decisions_total\{[^}]*decision="allow"\} 2\n/);
  assert.match(text, /agent_permission_decisions_total\{[^}]*decision="deny"\} 1\n/);
  assert.match(text, /# TYPE agent_tool_duration_seconds_total counter\n/);
  assert.match(text, /agent_tool_duration_seconds_total\{[^}]*tool="edit"\} 4\n/);
  assert.match(text, /agent_tool_duration_seconds_total\{[^}]*tool="bash"\} 0\.125\n/);
});

test("prometheus omits empty edit permission and duration families", () => {
  const text = renderPrometheus({
    labels,
    tokens: {},
    tools: {},
    edits: { added: 0, deleted: 0 },
    permissions: {},
    toolDurationMs: {},
    contextMax: 0,
    durationSeconds: 0,
  });
  assert.equal((text.match(/# TYPE agent_file_edits_total/g) || []).length, 0);
  assert.equal((text.match(/# TYPE agent_permission_decisions_total/g) || []).length, 0);
  assert.equal((text.match(/# TYPE agent_tool_duration_seconds_total/g) || []).length, 0);
  assert.equal((text.match(/# TYPE agent_tool_calls_total/g) || []).length, 0);
});
