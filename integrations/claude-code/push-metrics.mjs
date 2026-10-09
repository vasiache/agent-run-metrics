#!/usr/bin/env node
// push-metrics.mjs: realtime run metrics of a Claude Code session to PushGateway.
//
// Wired via Claude Code hooks (see settings.example.json): PostToolUse (throttled),
// Stop (every turn end), SessionEnd (final push). Each invocation re-reads the whole
// session transcript (JSONL) and pushes cumulative totals. Holds no state, safe on crashes.
//
// Env:
//   AGENT_METRICS_PUSHGATEWAY  http://host:9091   (required)
//   AGENT_METRICS_JOB          job label, default "claude-code"
//   AGENT_METRICS_RUNTIME      runtime label, default "claude-code"
//   AGENT_METRICS_INSTANCE     instance label, default = hostname
//   AGENT_METRICS_LABELS       extra labels "user=vasche,task=BLK-1"
//   AGENT_METRICS_TOKEN        bearer token, sent as Authorization header
//   AGENT_METRICS_DEBUG        set to log push failures to stderr
//
// Offline check:  node push-metrics.mjs --self-test <transcript.jsonl>

import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import path from "node:path";

const PUSH_THROTTLE_MS = 15000;

// ---------------------------------------------------------------------------
// Metrics aggregation over the transcript
// ---------------------------------------------------------------------------

// usage -> { kind: tokens } mapping, kind vocabulary mirrors the OpenCode plugin
function usageKinds(u = {}) {
  const out = {};
  if (u.input_tokens) out.input = u.input_tokens;
  if (u.output_tokens) out.output = u.output_tokens;
  if (u.output_tokens_details?.thinking_tokens) out.reasoning = u.output_tokens_details.thinking_tokens;
  if (u.cache_read_input_tokens) out.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens) out.cache_write = u.cache_creation_input_tokens;
  return out;
}

// a Skill tool_use block -> { skill, plugin } counts (plugin = "id:name" prefix).
// The metrics integration itself is counted too; self-monitoring is a feature.
function skillOf(block) {
  const skill = block.input?.skill;
  if (!skill) return null;
  const out = { skill };
  const colon = skill.indexOf(":");
  if (colon > 0) out.plugin = skill.slice(0, colon);
  return out;
}

// project from the transcript slug: ~/.claude/projects/-home-<user>-projects-<name>/<sid>.jsonl.
// Unknown slugs (tmp dirs, exotic homes) yield null and the label is omitted.
function projectFromTranscript(p) {
  const m = String(p).match(/\/\.claude\/projects\/([^/]+)\//);
  if (!m) return null;
  const slug = m[1];
  const user = os.userInfo().username;
  for (const pre of [`-home-${user}-projects-`, `-home-${user}-`,
                     `-Users-${user}-projects-`, `-Users-${user}-`, `-root-`, `-tmp-`])
    if (slug.startsWith(pre)) return slug.slice(pre.length) || null;
  return null;
}

async function aggregate(transcriptPath) {
  const acc = { tokens: {}, tools: {}, skills: {}, plugins: {}, contextMax: 0, firstTs: null, lastTs: null };
  // the transcript writes each content block as its own line, siblings sharing
  // one message id: usage is identical across them (count once per id), while
  // tool blocks must be deduped per block, not per message
  const seenMessages = new Set();
  const seenBlocks = new Set();
  const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // tolerate malformed/truncated lines
    if (e?.type !== "assistant" || e?.isSidechain) continue;
    const msg = e.message || {};
    const seen = msg.id && seenMessages.has(msg.id);
    if (msg.id && !seen) seenMessages.add(msg.id);
    if (!seen) {
      for (const [kind, n] of Object.entries(usageKinds(msg.usage)))
        acc.tokens[kind] = (acc.tokens[kind] || 0) + n;
      const ctx = (msg.usage?.input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0) +
        (msg.usage?.cache_creation_input_tokens || 0);
      if (ctx > acc.contextMax) acc.contextMax = ctx;
    }
    if (e.timestamp) {
      if (!acc.firstTs) acc.firstTs = e.timestamp;
      acc.lastTs = e.timestamp;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type !== "tool_use" || !b.name) continue;
      const bk = `${msg.id || ""}:${b.name}:${JSON.stringify(b.input ?? "")}`;
      if (seenBlocks.has(bk)) continue; // dedup API retries of the same block
      if (msg.id) seenBlocks.add(bk);
      acc.tools[b.name] = (acc.tools[b.name] || 0) + 1;
      const s = skillOf(b);
      if (s) {
        acc.skills[s.skill] = (acc.skills[s.skill] || 0) + 1;
        if (s.plugin) acc.plugins[s.plugin] = (acc.plugins[s.plugin] || 0) + 1;
      }
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Identity + labels
// ---------------------------------------------------------------------------

async function harnessIdentity() {
  try {
    const t = JSON.parse(await readFile(path.join(os.homedir(), ".harness", "telemetry.json"), "utf8"));
    if (t.user_identity) return String(t.user_identity);
  } catch { /* harness not installed */ }
  return null;
}

async function harnessProfile() {
  for (const p of [path.join(os.homedir(), ".harness", "profile.yaml"),
                   path.join(os.homedir(), ".opencode", ".harness", "profile.yaml")]) {
    try {
      const m = (await readFile(p, "utf8")).match(/^profile:\s*(\S+)\s*$/m);
      if (m) return m[1];
    } catch { /* no profile file */ }
  }
  return null;
}

function extraLabels() {
  const out = {};
  for (const kv of (process.env.AGENT_METRICS_LABELS || "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=", 2);
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}

async function baseLabels() {
  const labels = await extraLabels();
  if (!labels.runtime) labels.runtime = process.env.AGENT_METRICS_RUNTIME || "claude-code";
  if (!labels.user) {
    const u = (await harnessIdentity()) || os.userInfo().username;
    labels.user = u;
  }
  if (!labels.profile) {
    const p = await harnessProfile();
    if (p) labels.profile = p;
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Rendering + push
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function gatewayUrl(extra) {
  const base = process.env.AGENT_METRICS_PUSHGATEWAY;
  if (!base) return null;
  const job = encodeURIComponent(process.env.AGENT_METRICS_JOB || "claude-code");
  const instance = encodeURIComponent(process.env.AGENT_METRICS_INSTANCE || os.hostname());
  const extraPath = Object.entries(extra)
    .map(([k, v]) => `/${encodeURIComponent(k)}/${encodeURIComponent(v)}`).join("");
  return `${base.replace(/\/+$/, "")}/metrics/job/${job}/instance/${instance}${extraPath}`;
}

function render(acc, labels) {
  const L = [];
  const labelStr = Object.entries(labels).map(([k, v]) => `${esc(k)}="${esc(v)}"`).join(",");
  const lb = labelStr ? `{${labelStr}}` : "";
  const tokens = Object.entries(acc.tokens);
  if (tokens.length) {
    L.push(`# TYPE agent_tokens_total counter`); // one TYPE line per metric family
    for (const [kind, v] of tokens)
      L.push(`agent_tokens_total{${labelStr ? labelStr + "," : ""}kind="${esc(kind)}"} ${v}`);
  }
  const tools = Object.entries(acc.tools);
  if (tools.length) {
    L.push(`# TYPE agent_tool_calls_total counter`);
    for (const [tool, v] of tools)
      L.push(`agent_tool_calls_total{${labelStr ? labelStr + "," : ""}tool="${esc(tool)}"} ${v}`);
  }
  const skills = Object.entries(acc.skills);
  if (skills.length) {
    L.push(`# TYPE agent_skill_calls_total counter`);
    for (const [skill, v] of skills)
      L.push(`agent_skill_calls_total{${labelStr ? labelStr + "," : ""}skill="${esc(skill)}"} ${v}`);
  }
  const plugins = Object.entries(acc.plugins);
  if (plugins.length) {
    L.push(`# TYPE agent_plugin_calls_total counter`);
    for (const [plugin, v] of plugins)
      L.push(`agent_plugin_calls_total{${labelStr ? labelStr + "," : ""}plugin="${esc(plugin)}"} ${v}`);
  }
  L.push(`# TYPE agent_context_max_tokens gauge`, `agent_context_max_tokens${lb} ${acc.contextMax}`);
  const dur = acc.firstTs && acc.lastTs
    ? Math.max(0, Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 1000)) : 0;
  L.push(`# TYPE agent_run_duration_seconds gauge`, `agent_run_duration_seconds${lb} ${dur}`);
  return L.join("\n") + "\n";
}

async function push(body, extraLabelsObj) {
  const url = gatewayUrl(extraLabelsObj);
  if (!url) return;
  const headers = { "Content-Type": "text/plain" };
  if (process.env.AGENT_METRICS_TOKEN)
    headers.Authorization = `Bearer ${process.env.AGENT_METRICS_TOKEN}`;
  try {
    const res = await fetch(url, { method: "POST", headers, body,
                                   signal: AbortSignal.timeout(5000) });
    if (!res.ok && process.env.AGENT_METRICS_DEBUG)
      console.error(`agent-metrics: push failed: HTTP ${res.status}`);
  } catch (e) {
    if (process.env.AGENT_METRICS_DEBUG) console.error(`agent-metrics: push error: ${e.message}`);
    // monitoring must never break the agent
  }
}

// ---------------------------------------------------------------------------
// Throttle state (PostToolUse only)
// ---------------------------------------------------------------------------

function throttleFile(sessionId) {
  return path.join(os.tmpdir(), `agent-metrics-claude-${sessionId || "anon"}`);
}

async function throttled(sessionId) {
  const f = throttleFile(sessionId);
  let last = 0;
  try { last = (await stat(f)).mtimeMs; } catch { /* first push */ }
  if (Date.now() - last < PUSH_THROTTLE_MS) return true;
  try { await writeFile(f, ""); } catch { /* state file best-effort */ }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function hookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

async function main() {
  const selfTest = process.argv[2] === "--self-test";
  const input = selfTest ? {} : await hookInput();
  const transcript = selfTest ? process.argv[3]
    : (process.argv[2] || input.transcript_path);
  if (!transcript) process.exit(0);
  const labels = await baseLabels();
  // per-run identity: parallel sessions on one host must not share a grouping key
  const sid = String(input.session_id || process.env.AGENT_METRICS_SESSION || "");
  if (sid) labels.session = sid.slice(0, 8);
  const project = projectFromTranscript(transcript);
  if (project) labels.project = project;
  if (selfTest) {
    process.stdout.write(render(await aggregate(transcript), labels));
    return;
  }
  const event = input.hook_event_name || process.env.AGENT_METRICS_HOOK_EVENT || "";
  if (event === "PostToolUse" && (await throttled(input.session_id))) return;
  await push(render(await aggregate(transcript), labels), labels);
  if (event === "SessionEnd" && input.session_id)
    try { await unlink(throttleFile(input.session_id)); } catch { /* best-effort */ }
}

main().catch(() => process.exit(0)); // monitoring must never break the agent
