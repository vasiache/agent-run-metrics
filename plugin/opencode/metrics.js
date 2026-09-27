// metrics.js — realtime run metrics of an OpenCode agent to PushGateway.
//
// Install: <project>/.opencode/plugin/metrics.js (or ~/.config/opencode/plugin/)
// Env:
//   AGENT_METRICS_PUSHGATEWAY  http://host:9091   (required)
//   AGENT_METRICS_JOB          job label, default "opencode"
//   AGENT_METRICS_INSTANCE     instance label, default = hostname
//   AGENT_METRICS_LABELS       extra labels "user=vasche,profile=test"
//
// Push: after each tool call (throttled 15s) and on session.idle.

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const PUSH_THROTTLE_MS = 15000;

const state = {
  tokens: {},   // kind -> counter
  tools: {},    // tool -> counter
  cost: 0,
  contextMax: 0,
  startedAt: Date.now(),
  lastPush: 0,
  pushing: false,
};

function gatewayUrl() {
  const base = process.env.AGENT_METRICS_PUSHGATEWAY;
  if (!base) return null;
  const job = process.env.AGENT_METRICS_JOB || "opencode";
  const instance = encodeURIComponent(process.env.AGENT_METRICS_INSTANCE || require("os").hostname());
  const extra = (process.env.AGENT_METRICS_LABELS || "")
    .split(",").filter(Boolean)
    .map((kv) => {
      const [k, v] = kv.split("=", 2);
      return `${k.trim()}="${v.trim()}"`;
    }).join(",");
  return `${base.replace(/\/+$/, "")}/metrics/job/${job}/instance/${instance}${extra ? "/" + extra : ""}`;
}

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function bump(obj, key, n) {
  obj[key] = (obj[key] || 0) + n;
}

function render() {
  const L = [];
  for (const [kind, v] of Object.entries(state.tokens))
    L.push(`# TYPE opencode_agent_tokens_total counter`,
           `opencode_agent_tokens_total{kind="${esc(kind)}"} ${v}`);
  for (const [tool, v] of Object.entries(state.tools))
    L.push(`# TYPE opencode_agent_tool_calls_total counter`,
           `opencode_agent_tool_calls_total{tool="${esc(tool)}"} ${v}`);
  L.push(`# TYPE opencode_agent_context_max_tokens gauge`,
         `opencode_agent_context_max_tokens ${state.contextMax}`);
  L.push(`# TYPE opencode_agent_run_duration_seconds gauge`,
         `opencode_agent_run_duration_seconds ${Math.round((Date.now() - state.startedAt) / 1000)}`);
  return L.join("\n") + "\n";
}

async function push() {
  const url = gatewayUrl();
  if (!url || state.pushing) return;
  state.pushing = true;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: render() });
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
  "tool.execute.after": async () => {
    pushThrottled();
  },
  event: async ({ event }) => {
    if (event?.type !== "message.updated") return;
    const info = event.properties?.info || {};
    if (info.role !== "assistant") return;
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
