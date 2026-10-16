// metrics.js — realtime run metrics of an OpenCode agent to PushGateway.
//
// Install: <project>/.opencode/plugin/metrics.js (or ~/.config/opencode/plugin/)
// Env:
//   AGENT_METRICS_PUSHGATEWAY  https://host[:port]/push/<tenant>   (required;
//     "<tenant>" is replaced with the tenant_id claim of your bearer token)
//   AGENT_METRICS_JOB          job label, default "opencode"
//   AGENT_METRICS_RUNTIME      runtime label, default "opencode"
//   AGENT_METRICS_INSTANCE     instance label, default = hostname
//   AGENT_METRICS_LABELS       extra labels "user=vasche,profile=test"
//   AGENT_METRICS_TOKEN        bearer token (cloud mode), optional
//
// Push: after each tool call and on every assistant message update (both
// throttled to one push per 15s).

import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";

const PUSH_THROTTLE_MS = 15000;

const state = {
  tokens: {},   // kind -> counter
  tools: {},    // tool -> counter
  cost: 0,
  contextMax: 0,
  startedAt: Date.now(),
  session: null, // short id of the active session; parallel sessions must not share a grouping key
  lastPush: 0,
  pushing: false,
};

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// base labels shared by every series: runtime + user + extra k=v pairs
async function baseLabels() {
  const labels = {
    runtime: process.env.AGENT_METRICS_RUNTIME || "opencode",
  };
  for (const kv of (process.env.AGENT_METRICS_LABELS || "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=", 2);
    if (k && v !== undefined) labels[k.trim()] = v.trim();
  }
  if (!labels.user) {
    labels.user = await harnessIdentity() || os.userInfo().username;
  }
  if (!labels.project) labels.project = path.basename(process.cwd());
  if (!labels.session && state.session) labels.session = state.session;
  return labels;
}

async function harnessIdentity() {
  try {
    const t = JSON.parse(await readFile(os.homedir() + "/.harness/telemetry.json", "utf8"));
    if (t.user_identity) return String(t.user_identity);
  } catch { /* harness not installed */ }
  return null;
}

function tenantFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload.tenant_id ? String(payload.tenant_id) : null;
  } catch { return null; }
}

function gatewayUrl(extraLabelsObj, token) {
  let base = process.env.AGENT_METRICS_PUSHGATEWAY;
  if (!base) return null;
  if (base.includes("<tenant>")) {
    const tenant = tenantFromToken(token || "");
    if (!tenant) {
      console.error("[agent-run-metrics] PUSHGATEWAY has <tenant> but the token has no tenant_id claim, push skipped");
      return null;
    }
    base = base.replace("<tenant>", tenant);
  }
  const job = encodeURIComponent(process.env.AGENT_METRICS_JOB || "opencode");
  const instance = encodeURIComponent(process.env.AGENT_METRICS_INSTANCE || os.hostname());
  const extraPath = Object.entries(extraLabelsObj)
    .map(([k, v]) => `/${encodeURIComponent(k)}/${encodeURIComponent(v)}`).join("");
  return `${base.replace(/\/+$/, "")}/metrics/job/${job}/instance/${instance}${extraPath}`;
}

function bump(obj, key, n) {
  obj[key] = (obj[key] || 0) + n;
}

function render(labels) {
  const labelStr = Object.entries(labels).map(([k, v]) => `${esc(k)}="${esc(v)}"`).join(",");
  const withLabel = (l) => `{${labelStr ? labelStr + "," : ""}${l}}`;
  const L = [];
  for (const [kind, v] of Object.entries(state.tokens))
    L.push(`# TYPE agent_tokens_total counter`,
           `agent_tokens_total${withLabel(`kind="${esc(kind)}"`)} ${v}`);
  for (const [tool, v] of Object.entries(state.tools))
    L.push(`# TYPE agent_tool_calls_total counter`,
           `agent_tool_calls_total${withLabel(`tool="${esc(tool)}"`)} ${v}`);
  L.push(`# TYPE agent_context_max_tokens gauge`,
         `agent_context_max_tokens{${labelStr}} ${state.contextMax}`);
  L.push(`# TYPE agent_run_duration_seconds gauge`,
         `agent_run_duration_seconds{${labelStr}} ${Math.round((Date.now() - state.startedAt) / 1000)}`);
  return L.join("\n") + "\n";
}

// eharness native integration (ADR-020): no AGENT_METRICS_TOKEN env → resolve
// the bearer from the grant store ~/.saas/token.json (0600): fresh access
// token as-is, stale one → ONE silent refresh via the eharness CLI under a
// mkdir lock (losers skip this push). No grant → no Authorization header.
let tokenPromise = null;
async function resolveToken() {
  if (process.env.AGENT_METRICS_TOKEN) return process.env.AGENT_METRICS_TOKEN;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const store = path.join(os.homedir(), ".saas", "token.json");
    try {
      const s = JSON.parse(await readFile(store, "utf8"));
      if (s.access_token && s.expires_at && s.expires_at > Date.now() / 1000 + 30)
        return s.access_token;
    } catch { return null; } // no grant — standalone mode
    const lock = store + ".refresh.lock";
    try {
      await mkdir(lock);
    } catch { return null; } // another client is refreshing — skip
    try {
      return await new Promise((resolve) => {
        execFile("eharness", ["auth", "token"], { timeout: 15000 },
          (e, stdout) => resolve(e ? null : String(stdout).trim() || null));
      });
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  })();
  tokenPromise.catch(() => { tokenPromise = null; });
  return tokenPromise;
}

async function push() {
  const labels = await baseLabels();
  const token = await resolveToken();
  const url = gatewayUrl(labels, token);
  if (!url || state.pushing) return;
  state.pushing = true;
  try {
    const headers = { "Content-Type": "text/plain" };
    if (token) headers.Authorization = `Bearer ${token}`; // E-070: this line used to go missing, cloud pushes came back 401
    await fetch(url, { method: "POST", headers, body: render(labels) });
  } catch (e) {
    // monitoring must never break the agent
  } finally {
    state.pushing = false;
  }
}

function pushThrottled() {
  if (Date.now() - state.lastPush > PUSH_THROTTLE_MS) {
    state.lastPush = Date.now();
    push();
  }
}

export const MetricsPlugin = async () => ({
  "tool.execute.after": async (input) => {
    const tool = input?.tool || input?.toolName || "";
    if (tool) state.tools[tool] = (state.tools[tool] || 0) + 1;
    if (input?.sessionID) state.session = String(input.sessionID).slice(0, 8);
    pushThrottled();
  },
  event: async ({ event }) => {
    if (event?.type !== "message.updated") return;
    const info = event.properties?.info || {};
    if (info.role !== "assistant") return;
    if (info.sessionID) state.session = String(info.sessionID).slice(0, 8);
    const t = info.tokens || {};
    if (t.input) bump(state.tokens, "input", t.input);
    if (t.output) bump(state.tokens, "output", t.output);
    if (t.reasoning) bump(state.tokens, "reasoning", t.reasoning);
    const c = t.cache || {};
    if (c.read) bump(state.tokens, "cache_read", c.read);
    if (c.write) bump(state.tokens, "cache_write", c.write);
    if (info.contextWindow > state.contextMax) state.contextMax = info.contextWindow;
    pushThrottled();
  },
});
