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
//   AGENT_METRICS_TOKEN        bearer token, sent as Authorization header;
//                              if unset — eharness grant ~/.saas/token.json
//                              (fresh access, silent refresh via `eharness auth
//                              token`); no grant → no Authorization header
//   AGENT_METRICS_DEBUG        set to log push failures to stderr
//
// Offline check:  node push-metrics.mjs --self-test <transcript.jsonl>

import { readFile, readdir, rm, stat, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------
// AGENT_METRICS_TOKEN wins. Without it, eharness native integration (ADR-020):
// read the grant store ~/.saas/token.json (0600); a fresh access token is used
// as-is, a stale one triggers ONE silent refresh via the eharness CLI under a
// mkdir lock (concurrent hooks: one refreshes, losers skip this push — the
// next one finds a fresh token). No grant → null → push without Authorization
// (standalone self-hosted gateway keeps working).

async function resolveToken() {
  if (process.env.AGENT_METRICS_TOKEN) return process.env.AGENT_METRICS_TOKEN;
  const store = path.join(os.homedir(), ".saas", "token.json");
  let stale = false;
  try {
    const s = JSON.parse(await readFile(store, "utf8"));
    if (s.access_token && s.expires_at && s.expires_at > Date.now() / 1000 + 30)
      return s.access_token;
    stale = true;
  } catch { return null; } // no grant — standalone mode
  if (!stale) return null;
  const lock = store + ".refresh.lock";
  try {
    await (await import("node:fs/promises")).mkdir(lock);
  } catch { return null; } // another hook is refreshing — skip this push
  try {
    return await new Promise((resolve) => {
      execFile("eharness", ["auth", "token"], { timeout: 15000 },
        (e, stdout) => resolve(e ? null : String(stdout).trim() || null));
    });
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

const PUSH_THROTTLE_MS = 15000;
// matches the edit vocabulary of session_timeline.py
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

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

// an Agent/Task tool_use block -> subagent type (the agent's name, e.g. "Explore")
function spawnTypeOf(block) {
  if (block.name !== "Task" && block.name !== "Agent") return null;
  return String(block.input?.subagent_type || block.input?.name || "unknown");
}

// project from the transcript slug: ~/.claude/projects/-home-<user>-projects-<name>/<sid>.jsonl,
// also CLAUDE_CONFIG_DIR profiles (~/.saas/profiles/<mode>/claude/projects/...).
// Unknown slugs (tmp dirs, exotic homes) yield null and the label is omitted.
function projectFromTranscript(p) {
  const m = String(p).match(/\/(?:\.claude|profiles\/[^/]+\/claude)\/projects\/([^/]+)\//);
  if (!m) return null;
  const slug = m[1];
  const user = os.userInfo().username;
  for (const pre of [`-home-${user}-projects-`, `-home-${user}-`,
                     `-Users-${user}-projects-`, `-Users-${user}-`, `-root-`, `-tmp-`])
    if (slug.startsWith(pre)) return slug.slice(pre.length) || null;
  return null;
}

async function aggregate(transcriptPath) {
  const acc = { tokens: {}, tools: {}, skills: {}, plugins: {}, spawns: {}, edits: 0, turns: 0,
                contextMax: 0, firstTs: null, lastTs: null };
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
    if (e?.type !== "assistant") continue;
    const msg = e.message || {};
    const seen = msg.id && seenMessages.has(msg.id);
    if (msg.id && !seen) { seenMessages.add(msg.id); acc.turns++; }
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
      if (EDIT_TOOLS.has(b.name)) acc.edits++;
      const st = spawnTypeOf(b);
      if (st) acc.spawns[st] = (acc.spawns[st] || 0) + 1;
      const s = skillOf(b);
      if (s) {
        acc.skills[s.skill] = (acc.skills[s.skill] || 0) + 1;
        if (s.plugin) acc.plugins[s.plugin] = (acc.plugins[s.plugin] || 0) + 1;
      }
    }
  }
  return acc;
}

// Subagent runs of the session: <project>/<sid>/subagents/agent-<id>.jsonl
// with a sibling .meta.json holding the agent's name (agentType).
// Returns [{ agent, description, acc }].
async function aggregateSubagents(transcriptPath) {
  const sid = path.basename(transcriptPath).replace(/\.jsonl$/, "");
  const dir = path.join(path.dirname(transcriptPath), sid, "subagents");
  let files;
  try { files = (await readdir(dir)).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort(); }
  catch { return []; } // no subagents dir — session spawned none
  const out = [];
  for (const f of files) {
    let agent = "unknown";
    let description = null;
    try {
      const meta = JSON.parse(await readFile(path.join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      if (meta.agentType) agent = String(meta.agentType);
      if (meta.description) description = String(meta.description);
    } catch { /* unnamed agent */ }
    out.push({ agent, description, acc: await aggregate(path.join(dir, f)) });
  }
  return out;
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

function gatewayUrl(extra, token) {
  let base = process.env.AGENT_METRICS_PUSHGATEWAY;
  if (base && base.includes("<tenant>")) {
    let tenant = null;
    try {
      const payload = JSON.parse(Buffer.from((token || "").split(".")[1], "base64url").toString("utf8"));
      tenant = payload.tenant_id ? String(payload.tenant_id) : null;
    } catch { /* bad token */ }
    if (!tenant) {
      console.error("[agent-run-metrics] PUSHGATEWAY has <tenant> but the token has no tenant_id claim");
      process.exit(2);
    }
    base = base.replace("<tenant>", tenant);
  }
  if (!base) return null;
  const job = encodeURIComponent(process.env.AGENT_METRICS_JOB || "claude-code");
  const instance = encodeURIComponent(process.env.AGENT_METRICS_INSTANCE || os.hostname());
  const extraPath = Object.entries(extra)
    .map(([k, v]) => `/${encodeURIComponent(k)}/${encodeURIComponent(v)}`).join("");
  return `${base.replace(/\/+$/, "")}/metrics/job/${job}/instance/${instance}${extraPath}`;
}

function render(acc, labels, subagents = []) {
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
  const spawns = Object.entries(acc.spawns || {});
  if (spawns.length) {
    L.push(`# TYPE agent_subagent_spawns_total counter`);
    for (const [agent, v] of spawns)
      L.push(`agent_subagent_spawns_total{${labelStr ? labelStr + "," : ""}agent="${esc(agent)}"} ${v}`);
  }
  L.push(`# TYPE agent_context_max_tokens gauge`, `agent_context_max_tokens${lb} ${acc.contextMax}`);
  // session summary, same family names as the report scripts (agent_metrics.py),
  // so the dashboard's session stat panels fill from the live hook too
  const sessDur = acc.firstTs && acc.lastTs
    ? Math.max(0, Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 1000)) : 0;
  L.push(`# TYPE agent_session_tokens_total gauge`,
         `agent_session_tokens_total${lb} ${Object.values(acc.tokens).reduce((a, v) => a + v, 0)}`);
  L.push(`# TYPE agent_session_turns gauge`, `agent_session_turns${lb} ${acc.turns}`);
  L.push(`# TYPE agent_session_edits_total gauge`, `agent_session_edits_total${lb} ${acc.edits}`);
  L.push(`# TYPE agent_session_tool_calls_total gauge`,
         `agent_session_tool_calls_total${lb} ${Object.values(acc.tools).reduce((a, v) => a + v, 0)}`);
  L.push(`# TYPE agent_session_duration_seconds gauge`, `agent_session_duration_seconds${lb} ${sessDur}`);
  const dur = acc.firstTs && acc.lastTs
    ? Math.max(0, Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 1000)) : 0;
  L.push(`# TYPE agent_run_duration_seconds gauge`, `agent_run_duration_seconds${lb} ${dur}`);
  // one TYPE line per family (Prometheus text format); runs of the same agent
  // type share one label set, so merge them (sum counters, max context,
  // duration = union of the time ranges)
  const merged = new Map();
  for (const sub of subagents) {
    const m = merged.get(sub.agent) || { acc: { tokens: {}, tools: {}, contextMax: 0, firstTs: null, lastTs: null } };
    for (const [k, v] of Object.entries(sub.acc.tokens))
      m.acc.tokens[k] = (m.acc.tokens[k] || 0) + v;
    for (const [t, v] of Object.entries(sub.acc.tools))
      m.acc.tools[t] = (m.acc.tools[t] || 0) + v;
    m.acc.contextMax = Math.max(m.acc.contextMax, sub.acc.contextMax);
    if (sub.acc.firstTs && (!m.acc.firstTs || sub.acc.firstTs < m.acc.firstTs)) m.acc.firstTs = sub.acc.firstTs;
    if (sub.acc.lastTs && (!m.acc.lastTs || sub.acc.lastTs > m.acc.lastTs)) m.acc.lastTs = sub.acc.lastTs;
    merged.set(sub.agent, m);
  }
  const tokLines = [], toolLines = [], ctxLines = [], durLines = [];
  for (const [agent, m] of merged) {
    const agentLbl = `${labelStr ? labelStr + "," : ""}agent="${esc(agent)}"`;
    for (const [kind, v] of Object.entries(m.acc.tokens))
      tokLines.push(`agent_subagent_tokens_total{${agentLbl},kind="${esc(kind)}"} ${v}`);
    for (const [tool, v] of Object.entries(m.acc.tools))
      toolLines.push(`agent_subagent_tool_calls_total{${agentLbl},tool="${esc(tool)}"} ${v}`);
    if (m.acc.contextMax)
      ctxLines.push(`agent_subagent_context_max_tokens{${agentLbl}} ${m.acc.contextMax}`);
    const sdur = m.acc.firstTs && m.acc.lastTs
      ? Math.max(0, Math.round((Date.parse(m.acc.lastTs) - Date.parse(m.acc.firstTs)) / 1000)) : 0;
    durLines.push(`agent_subagent_duration_seconds{${agentLbl}} ${sdur}`);
  }
  if (tokLines.length) L.push(`# TYPE agent_subagent_tokens_total counter`, ...tokLines);
  if (toolLines.length) L.push(`# TYPE agent_subagent_tool_calls_total counter`, ...toolLines);
  if (ctxLines.length) L.push(`# TYPE agent_subagent_context_max_tokens gauge`, ...ctxLines);
  if (durLines.length) L.push(`# TYPE agent_subagent_duration_seconds gauge`, ...durLines);
  return L.join("\n") + "\n";
}

async function push(body, extraLabelsObj) {
  const token = await resolveToken();
  const url = gatewayUrl(extraLabelsObj, token);
  if (!url) return;
  const headers = { "Content-Type": "text/plain" };
  if (token) headers.Authorization = `Bearer ${token}`;
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
    process.stdout.write(render(await aggregate(transcript), labels,
                                await aggregateSubagents(transcript)));
    return;
  }
  const event = input.hook_event_name || process.env.AGENT_METRICS_HOOK_EVENT || "";
  if (event === "PostToolUse" && (await throttled(input.session_id))) return;
  await push(render(await aggregate(transcript), labels,
                    await aggregateSubagents(transcript)), labels);
  if (event === "SessionEnd" && input.session_id)
    try { await unlink(throttleFile(input.session_id)); } catch { /* best-effort */ }
}

main().catch(() => process.exit(0)); // monitoring must never break the agent
