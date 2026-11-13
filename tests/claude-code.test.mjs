import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { aggregate, aggregateSubagents, render, labelsFor } from "../integrations/claude-code/push-metrics.mjs";
import { MetricsConfigurationError } from "../integrations/common/config.mjs";

const FIXTURE = path.resolve("integrations/claude-code/fixtures/sample-transcript.jsonl");

async function rawTranscript(rawLines) {
  const dir = await mkdtemp(path.join(tmpdir(), "arm-claude-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, rawLines.join("\n") + "\n");
  return { file, cleanup: () => {} };
}

async function transcript(objects) {
  return rawTranscript(objects.map((line) => JSON.stringify(line)));
}

function assistant(id, usage, content = [], timestamp = "2026-10-06T08:00:10.000Z") {
  return {
    type: "assistant",
    timestamp,
    message: { id, role: "assistant", usage, content },
  };
}

test("claude code aggregates cumulative tokens from the fixture", async () => {
  const acc = await aggregate(FIXTURE);
  assert.ok(Object.keys(acc.tokens).length >= 1);
  assert.ok(acc.contextMax > 0);
});

test("claude code derives context from prompt usage of the largest message", async () => {
  const { file } = await transcript([
    assistant("msg_1", { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 }),
    assistant("msg_2", { input_tokens: 9999, output_tokens: 500 }),
  ]);
  const acc = await aggregate(file);
  assert.equal(acc.contextMax, 9999); // max observed prompt usage, not a sum across messages
});

test("claude code tolerates malformed lines and counts once per message", async () => {
  const { file } = await rawTranscript([
    JSON.stringify(assistant("msg_1", { input_tokens: 100, output_tokens: 50 }, [], "2026-10-06T08:00:10.000Z")),
    "not json at all {",
    "",
    JSON.stringify(assistant("msg_1", { input_tokens: 100, output_tokens: 50 }, [], "2026-10-06T08:00:11.000Z")), // duplicate
    JSON.stringify(assistant("msg_2", { input_tokens: 10 }, [], "2026-10-06T08:00:12.000Z")),
  ]);
  const acc = await aggregate(file);
  assert.equal(acc.tokens.input, 110); // duplicate message counted once
  assert.equal(acc.tokens.output, 50);
  assert.equal(acc.turns, 2);
});

test("claude code counts tool calls skills and subagent types", async () => {
  const { file } = await transcript([
    assistant("msg_1", { input_tokens: 5 }, [
      { type: "tool_use", name: "Edit", input: { file: "a" } },
      { type: "tool_use", name: "Task", input: { subagent_type: "Explore" } },
      { type: "tool_use", name: "Skill", input: { skill: "superpowers:brainstorming" } },
    ]),
  ]);
  const acc = await aggregate(file);
  assert.deepEqual(acc.tools, { Edit: 1, Task: 1, Skill: 1 });
  assert.equal(acc.edits, 1);
  assert.deepEqual(acc.spawns, { Explore: 1 });
  assert.deepEqual(acc.skills, { "superpowers:brainstorming": 1 });
  assert.deepEqual(acc.plugins, { superpowers: 1 });
});

test("claude code aggregates subagent transcripts with metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "arm-claude-sub-"));
  const sid = "ses_ce7aAAAA-full";
  const subDir = path.join(dir, sid, "subagents");
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(subDir, "agent-1.jsonl"),
    JSON.stringify(assistant("sub_1", { input_tokens: 42 }, [])) + "\n");
  await writeFile(path.join(subDir, "agent-1.meta.json"), JSON.stringify({ agentType: "Plan", description: "d" }));
  const subagents = await aggregateSubagents(path.join(dir, `${sid}.jsonl`));
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].agent, "Plan");
  assert.equal(subagents[0].acc.tokens.input, 42);
});

test("claude code renders session families with escaped labels", async () => {
  const acc = { tokens: { input: 10 }, tools: { read: 1 }, skills: {}, plugins: {}, spawns: {},
    edits: 1, turns: 2, contextMax: 10, firstTs: "2026-10-06T08:00:00.000Z", lastTs: "2026-10-06T08:01:00.000Z" };
  const text = render(acc, { runtime: "claude-code", session: "ses_A-full", project: "demo" }, []);
  assert.match(text, /agent_tokens_total\{runtime="claude-code",session="ses_A-full",project="demo",kind="input"\} 10/);
  assert.match(text, /agent_session_turns\{[^}]*\} 2/);
  assert.match(text, /agent_session_duration_seconds\{[^}]*\} 60/);
});

test("claude code labels use the full session id", () => {
  const user = os.userInfo().username;
  const labels = labelsFor(
    "ses_ce7aAAAA-and-more",
    `/home/${user}/proj/.claude/projects/-home-${user}-proj/ses_ce7aAAAA-and-more.jsonl`,
  );
  assert.equal(labels.session, "ses_ce7aAAAA-and-more"); // not truncated to 8 chars
  assert.equal(labels.project, "proj");
});

test("claude code rejects reserved extra labels that would merge sessions", () => {
  const user = os.userInfo().username;
  for (const extra of [{ project: "evil" }, { session: "evil" }, { runtime: "evil" }]) {
    assert.throws(
      () => labelsFor("ses_A-full", `/home/${user}/proj/.claude/projects/-home-${user}-proj/x.jsonl`, extra),
      MetricsConfigurationError,
    );
  }
});

test("claude code rejects invalid custom label names", () => {
  assert.throws(
    () => labelsFor("ses_A-full", "/tmp/x.jsonl", { "my-label": "1" }),
    MetricsConfigurationError,
  );
});

test("claude code counts edit line deltas from tool inputs", async () => {
  const { file } = await transcript([
    assistant("m1", {}, [
      { type: "tool_use", id: "tu-e1", name: "Edit", input: { file_path: "a.ts", old_string: "one\ntwo\nthree", new_string: "one\nTWO\nthree\nfour" } },
    ], "2026-10-06T08:00:10.000Z"),
    assistant("m2", {}, [
      { type: "tool_use", id: "tu-e2", name: "Write", input: { file_path: "b.ts", content: "x\ny" } },
    ], "2026-10-06T08:00:11.000Z"),
    assistant("m3", {}, [
      { type: "tool_use", id: "tu-e3", name: "MultiEdit", input: { edits: [
        { old_string: "a", new_string: "a\nb" },
        { old_string: "p\nq", new_string: "q" },
      ] } },
    ], "2026-10-06T08:00:12.000Z"),
  ]);
  const acc = await aggregate(file);
  assert.deepEqual(acc.editLines, { added: 5, deleted: 2 });
});

test("claude code pairs tool results into wall-clock durations", async () => {
  const { file } = await transcript([
    assistant("m1", {}, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }], "2026-10-06T08:00:10.000Z"),
    { type: "user", timestamp: "2026-10-06T08:00:11.500Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] } },
    assistant("m2", {}, [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "pwd" } }], "2026-10-06T08:00:12.000Z"),
    // unpaired trailing tool_use contributes no duration
  ]);
  const acc = await aggregate(file);
  assert.deepEqual(acc.toolDurationMs, { Bash: 1500 });
  assert.equal(acc.tools.Bash, 2);
});

test("claude code renders edit and duration families", () => {
  const text = render({
    tokens: {}, tools: { Bash: 1 }, skills: {}, plugins: {}, spawns: {},
    toolDurationMs: { Bash: 1500 }, editLines: { added: 5, deleted: 2 },
    contextMax: 0, firstTs: null, lastTs: null,
  }, { runtime: "claude-code", session: "s1" });
  assert.match(text, /# TYPE agent_file_edits_total counter\n/);
  assert.match(text, /agent_file_edits_total\{runtime="claude-code",session="s1",kind="added"\} 5\n/);
  assert.match(text, /agent_file_edits_total\{runtime="claude-code",session="s1",kind="deleted"\} 2\n/);
  assert.match(text, /# TYPE agent_tool_duration_seconds_total counter\n/);
  assert.match(text, /agent_tool_duration_seconds_total\{runtime="claude-code",session="s1",tool="Bash"\} 1\.5\n/);
});
