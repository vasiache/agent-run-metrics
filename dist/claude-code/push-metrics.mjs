#!/usr/bin/env node

// integrations/claude-code/push-metrics.mjs
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os2 from "node:os";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// integrations/common/token-provider.mjs
import { readFile as defaultReadFile } from "node:fs/promises";
import { homedir as defaultHomedir } from "node:os";
function resolveTokenPath(path2, homedir) {
  if (path2.startsWith("~/")) return `${homedir()}/${path2.slice(2)}`;
  return path2;
}
var TokenConfigurationError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TokenConfigurationError";
  }
};
function createTokenProvider({
  token,
  tokenFile,
  readFile: readFile2 = defaultReadFile,
  homedir = defaultHomedir
} = {}) {
  const direct = typeof token === "string" ? token.trim() : "";
  if (direct) return async () => direct;
  if (!tokenFile) return async () => null;
  return async () => {
    let contents;
    try {
      contents = await readFile2(resolveTokenPath(tokenFile, homedir), "utf8");
    } catch (error) {
      throw new TokenConfigurationError("configured token file could not be read", { cause: error });
    }
    const resolved = String(contents).trim();
    if (!resolved) throw new TokenConfigurationError("configured token file is empty");
    return resolved;
  };
}

// integrations/common/pushgateway.mjs
import os from "node:os";
function buildPushgatewayUrl({ endpoint, job, instance, labels = {} }) {
  if (!endpoint) return null;
  const base = String(endpoint);
  const suffix = Object.entries(labels).map(([key, value]) => `/${encodeURIComponent(key)}/${encodeURIComponent(value)}`).join("");
  return `${base.replace(/\/+$/, "")}/metrics/job/${encodeURIComponent(job)}/instance/${encodeURIComponent(instance || os.hostname())}${suffix}`;
}
function createPushgatewayClient({
  config,
  tokenProvider: tokenProvider2 = async () => null,
  fetchImpl = fetch,
  timeoutMs = 5e3,
  logger = console.error
} = {}) {
  function debug(message) {
    if (config.debug) logger(`[agent-run-metrics] ${message}`);
  }
  return {
    async push({ labels, body }) {
      if (!config.enabled) return false;
      try {
        const token = await tokenProvider2();
        const url = buildPushgatewayUrl({
          endpoint: config.endpoint,
          job: config.job,
          instance: config.instance,
          labels
        });
        if (!url) {
          debug("push skipped because endpoint configuration is invalid");
          return false;
        }
        const headers = { "Content-Type": "text/plain" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          debug(`push failed with HTTP ${response.status}`);
          return false;
        }
        return true;
      } catch {
        debug("push failed");
        return false;
      }
    }
  };
}

// integrations/common/config.mjs
var MetricsConfigurationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricsConfigurationError";
  }
};

// integrations/common/diff-lines.mjs
function lineDelta(oldText, newText) {
  const lines = (t) => typeof t === "string" && t.length ? t.split("\n") : [];
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const oldRemaining = oldLines.slice(start, endOld);
  const newRemaining = newLines.slice(start, endNew);
  if (!oldRemaining.length) return { added: newRemaining.length, deleted: 0 };
  if (!newRemaining.length) return { added: 0, deleted: oldRemaining.length };
  if (oldRemaining.length > 2e3 || newRemaining.length > 2e3) {
    return { added: newRemaining.length, deleted: oldRemaining.length };
  }
  const lcs = lcsLength(oldRemaining, newRemaining);
  return { added: newRemaining.length - lcs, deleted: oldRemaining.length - lcs };
}
function lcsLength(a, b) {
  const row = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

// integrations/claude-code/push-metrics.mjs
var PUSH_THROTTLE_MS = 15e3;
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "NotebookEdit"]);
var isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
function usageKinds(u = {}) {
  const out = {};
  if (u.input_tokens) out.input = u.input_tokens;
  if (u.output_tokens) out.output = u.output_tokens;
  if (u.output_tokens_details?.thinking_tokens) out.reasoning = u.output_tokens_details.thinking_tokens;
  if (u.cache_read_input_tokens) out.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens) out.cache_write = u.cache_creation_input_tokens;
  return out;
}
function skillOf(block) {
  const skill = block.input?.skill;
  if (!skill) return null;
  const out = { skill };
  const colon = skill.indexOf(":");
  if (colon > 0) out.plugin = skill.slice(0, colon);
  return out;
}
function spawnTypeOf(block) {
  if (block.name !== "Task" && block.name !== "Agent") return null;
  return String(block.input?.subagent_type || block.input?.name || "unknown");
}
function projectFromTranscript(p) {
  const m = String(p).match(/\/(?:\.claude|profiles\/[^/]+\/claude)\/projects\/([^/]+)\//);
  if (!m) return null;
  const slug = m[1];
  const user = os2.userInfo().username;
  for (const pre of [
    `-home-${user}-projects-`,
    `-home-${user}-`,
    `-Users-${user}-projects-`,
    `-Users-${user}-`,
    `-root-`,
    `-tmp-`
  ])
    if (slug.startsWith(pre)) return slug.slice(pre.length) || null;
  return null;
}
function editLinesOf(block) {
  const input = block.input || {};
  if (block.name === "Edit") return lineDelta(input.old_string, input.new_string);
  if (block.name === "MultiEdit") {
    const total = { added: 0, deleted: 0 };
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      const delta = lineDelta(edit?.old_string, edit?.new_string);
      total.added += delta.added;
      total.deleted += delta.deleted;
    }
    return total;
  }
  if (block.name === "Write") return lineDelta(void 0, input.content);
  return { added: 0, deleted: 0 };
}
async function aggregate(transcriptPath) {
  const acc = {
    tokens: {},
    tools: {},
    skills: {},
    plugins: {},
    spawns: {},
    edits: 0,
    turns: 0,
    editLines: { added: 0, deleted: 0 },
    toolDurationMs: {},
    contextMax: 0,
    firstTs: null,
    lastTs: null
  };
  const seenMessages = /* @__PURE__ */ new Set();
  const seenBlocks = /* @__PURE__ */ new Set();
  const pendingToolUses = /* @__PURE__ */ new Map();
  const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = e?.message || {};
    if (e?.type === "user") {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const pending = pendingToolUses.get(b.tool_use_id);
        if (!pending) continue;
        pendingToolUses.delete(b.tool_use_id);
        const started = Date.parse(pending.ts);
        const finished = Date.parse(e.timestamp);
        if (Number.isFinite(started) && Number.isFinite(finished)) {
          const durationMs = Math.max(0, finished - started);
          acc.toolDurationMs[pending.tool] = (acc.toolDurationMs[pending.tool] || 0) + durationMs;
        }
      }
      continue;
    }
    if (e?.type !== "assistant") continue;
    const seen = msg.id && seenMessages.has(msg.id);
    if (msg.id && !seen) {
      seenMessages.add(msg.id);
      acc.turns++;
    }
    if (!seen) {
      for (const [kind, n] of Object.entries(usageKinds(msg.usage)))
        acc.tokens[kind] = (acc.tokens[kind] || 0) + n;
      const ctx = (msg.usage?.input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0);
      if (ctx > acc.contextMax) acc.contextMax = ctx;
    }
    if (e.timestamp) {
      if (!acc.firstTs) acc.firstTs = e.timestamp;
      acc.lastTs = e.timestamp;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type !== "tool_use" || !b.name) continue;
      const bk = `${msg.id || ""}:${b.name}:${JSON.stringify(b.input ?? "")}`;
      if (seenBlocks.has(bk)) continue;
      if (msg.id) seenBlocks.add(bk);
      acc.tools[b.name] = (acc.tools[b.name] || 0) + 1;
      if (EDIT_TOOLS.has(b.name)) acc.edits++;
      if (b.id) {
        if (pendingToolUses.size >= 2e3) pendingToolUses.delete(pendingToolUses.keys().next().value);
        pendingToolUses.set(b.id, { tool: String(b.name), ts: e.timestamp });
      }
      const delta = editLinesOf(b);
      if (delta.added || delta.deleted) {
        acc.editLines.added += delta.added;
        acc.editLines.deleted += delta.deleted;
      }
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
async function aggregateSubagents(transcriptPath) {
  const sid = path.basename(transcriptPath).replace(/\.jsonl$/, "");
  const dir = path.join(path.dirname(transcriptPath), sid, "subagents");
  let files;
  try {
    files = (await readdir(dir)).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let agent = "unknown";
    let description = null;
    try {
      const meta = JSON.parse(await readFile(path.join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      if (meta.agentType) agent = String(meta.agentType);
      if (meta.description) description = String(meta.description);
    } catch {
    }
    out.push({ agent, description, acc: await aggregate(path.join(dir, f)) });
  }
  return out;
}
function extraLabels() {
  const out = {};
  for (const kv of (process.env.AGENT_METRICS_LABELS || "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=", 2);
    if (k && v !== void 0) out[k.trim()] = v.trim();
  }
  return out;
}
var RESERVED_LABELS = /* @__PURE__ */ new Set([
  "runtime",
  "session",
  "project",
  "instance",
  "job",
  "kind",
  "tool",
  "skill",
  "plugin",
  "agent"
]);
var LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function labelsFor(sessionID, transcriptPath, extra = extraLabels()) {
  const labels = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!LABEL_NAME.test(key)) throw new MetricsConfigurationError(`invalid label name: ${key}`);
    if (RESERVED_LABELS.has(key)) throw new MetricsConfigurationError(`reserved label name: ${key}`);
    labels[key] = String(value);
  }
  labels.runtime = process.env.AGENT_METRICS_RUNTIME || "claude-code";
  labels.user = os2.userInfo().username;
  if (sessionID) labels.session = String(sessionID);
  const project = projectFromTranscript(transcriptPath);
  if (project) labels.project = project;
  return labels;
}
var esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
function render(acc, labels, subagents = []) {
  const L = [];
  const labelStr = Object.entries(labels).map(([k, v]) => `${esc(k)}="${esc(v)}"`).join(",");
  const lb = labelStr ? `{${labelStr}}` : "";
  const tokens = Object.entries(acc.tokens);
  if (tokens.length) {
    L.push(`# TYPE agent_tokens_total counter`);
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
  const editLines = acc.editLines || {};
  if (editLines.added > 0 || editLines.deleted > 0) {
    L.push(`# TYPE agent_file_edits_total counter`);
    L.push(`agent_file_edits_total{${labelStr ? labelStr + "," : ""}kind="added"} ${editLines.added}`);
    L.push(`agent_file_edits_total{${labelStr ? labelStr + "," : ""}kind="deleted"} ${editLines.deleted}`);
  }
  const durations = Object.entries(acc.toolDurationMs || {}).filter(([, v]) => v > 0);
  if (durations.length) {
    L.push(`# TYPE agent_tool_duration_seconds_total counter`);
    for (const [tool, v] of durations) {
      const seconds = Math.round(v / 1e3 * 1e3) / 1e3;
      L.push(`agent_tool_duration_seconds_total{${labelStr ? labelStr + "," : ""}tool="${esc(tool)}"} ${seconds}`);
    }
  }
  L.push(`# TYPE agent_context_max_tokens gauge`, `agent_context_max_tokens${lb} ${acc.contextMax}`);
  const sessDur = acc.firstTs && acc.lastTs ? Math.max(0, Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 1e3)) : 0;
  L.push(
    `# TYPE agent_session_tokens_total gauge`,
    `agent_session_tokens_total${lb} ${Object.values(acc.tokens).reduce((a, v) => a + v, 0)}`
  );
  L.push(`# TYPE agent_session_turns gauge`, `agent_session_turns${lb} ${acc.turns}`);
  L.push(`# TYPE agent_session_edits_total gauge`, `agent_session_edits_total${lb} ${acc.edits}`);
  L.push(
    `# TYPE agent_session_tool_calls_total gauge`,
    `agent_session_tool_calls_total${lb} ${Object.values(acc.tools).reduce((a, v) => a + v, 0)}`
  );
  L.push(`# TYPE agent_session_duration_seconds gauge`, `agent_session_duration_seconds${lb} ${sessDur}`);
  const dur = acc.firstTs && acc.lastTs ? Math.max(0, Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 1e3)) : 0;
  L.push(`# TYPE agent_run_duration_seconds gauge`, `agent_run_duration_seconds${lb} ${dur}`);
  const merged = /* @__PURE__ */ new Map();
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
    const sdur = m.acc.firstTs && m.acc.lastTs ? Math.max(0, Math.round((Date.parse(m.acc.lastTs) - Date.parse(m.acc.firstTs)) / 1e3)) : 0;
    durLines.push(`agent_subagent_duration_seconds{${agentLbl}} ${sdur}`);
  }
  if (tokLines.length) L.push(`# TYPE agent_subagent_tokens_total counter`, ...tokLines);
  if (toolLines.length) L.push(`# TYPE agent_subagent_tool_calls_total counter`, ...toolLines);
  if (ctxLines.length) L.push(`# TYPE agent_subagent_context_max_tokens gauge`, ...ctxLines);
  if (durLines.length) L.push(`# TYPE agent_subagent_duration_seconds gauge`, ...durLines);
  return L.join("\n") + "\n";
}
var tokenProvider = createTokenProvider({
  token: process.env.AGENT_METRICS_TOKEN,
  tokenFile: process.env.AGENT_METRICS_TOKEN_FILE
});
async function push(body, labels) {
  const endpoint = process.env.AGENT_METRICS_PUSHGATEWAY;
  if (!endpoint) return false;
  const debug = !!process.env.AGENT_METRICS_DEBUG;
  const client = createPushgatewayClient({
    config: {
      enabled: true,
      endpoint,
      job: process.env.AGENT_METRICS_JOB || "claude-code",
      runtime: labels.runtime,
      instance: process.env.AGENT_METRICS_INSTANCE || os2.hostname(),
      labels: {},
      token: null,
      tokenFile: null,
      debug
    },
    tokenProvider
  });
  const delivered = await client.push({ labels, body });
  if (!delivered && debug) console.error("agent-metrics: push failed");
  return delivered;
}
function throttleFile(sessionId) {
  return path.join(os2.tmpdir(), `agent-metrics-claude-${sessionId || "anon"}`);
}
async function throttled(sessionId) {
  const f = throttleFile(sessionId);
  let last = 0;
  try {
    last = (await stat(f)).mtimeMs;
  } catch {
  }
  if (Date.now() - last < PUSH_THROTTLE_MS) return true;
  try {
    await writeFile(f, "");
  } catch {
  }
  return false;
}
async function hookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
async function main() {
  const selfTest = process.argv[2] === "--self-test";
  const input = selfTest ? {} : await hookInput();
  const transcript = selfTest ? process.argv[3] : process.argv[2] || input.transcript_path;
  if (!transcript) process.exit(0);
  const sid = String(input.session_id || process.env.AGENT_METRICS_SESSION || "");
  let labels;
  try {
    labels = labelsFor(sid, transcript);
  } catch (error) {
    if (process.env.AGENT_METRICS_DEBUG) console.error(`agent-metrics: ${error.message}, push disabled`);
    return;
  }
  if (selfTest) {
    process.stdout.write(render(
      await aggregate(transcript),
      labels,
      await aggregateSubagents(transcript)
    ));
    return;
  }
  const event = input.hook_event_name || process.env.AGENT_METRICS_HOOK_EVENT || "";
  if (event === "PostToolUse" && await throttled(input.session_id)) return;
  await push(render(
    await aggregate(transcript),
    labels,
    await aggregateSubagents(transcript)
  ), labels);
  if (event === "SessionEnd" && input.session_id)
    try {
      await unlink(throttleFile(input.session_id));
    } catch {
    }
}
if (isDirectRun) main().catch(() => process.exit(0));
export {
  aggregate,
  aggregateSubagents,
  labelsFor,
  main,
  render
};
