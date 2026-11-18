// integrations/opencode/plugin.js
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";

// integrations/common/config.mjs
import { existsSync, readFileSync } from "node:fs";
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
  "agent",
  "decision"
]);
var LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function readConfigFile(configFilePath) {
  const paths = Array.isArray(configFilePath) ? configFilePath : [configFilePath];
  for (const path of paths) {
    if (!path) continue;
    let raw;
    try {
      if (!existsSync(path)) continue;
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new MetricsConfigurationError(`invalid config file ${path}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MetricsConfigurationError(`config file must contain a JSON object: ${path}`);
    }
    return parsed;
  }
  return null;
}
var MetricsConfigurationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricsConfigurationError";
  }
};
function first(...values) {
  for (const value of values) {
    if (value !== void 0 && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}
function booleanValue(value) {
  return value === true || value === "1" || value === "true";
}
function parseLabels(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  const labels = {};
  for (const item of String(value).split(",").filter(Boolean)) {
    const [key, raw] = item.split("=", 2);
    if (!key || raw === void 0) throw new MetricsConfigurationError("labels must use key=value entries");
    labels[key.trim()] = raw.trim();
  }
  return labels;
}
function validateLabels(labels) {
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_NAME.test(key)) throw new MetricsConfigurationError(`invalid label name: ${key}`);
    if (RESERVED_LABELS.has(key)) throw new MetricsConfigurationError(`reserved label name: ${key}`);
    labels[key] = String(value);
  }
  return labels;
}
function resolveMetricsConfig({ options = {}, env = process.env, runtime, defaults = {}, configFilePath }) {
  const file = readConfigFile(configFilePath) ?? {};
  const endpoint = first(options.endpoint, env.AGENT_METRICS_PUSHGATEWAY, file.endpoint);
  const debug = booleanValue(options.debug ?? env.AGENT_METRICS_DEBUG ?? file.debug);
  if (!endpoint) {
    return {
      enabled: false,
      endpoint: null,
      job: null,
      runtime,
      instance: null,
      labels: {},
      token: null,
      tokenFile: null,
      debug
    };
  }
  return {
    enabled: true,
    endpoint,
    job: first(options.job, env.AGENT_METRICS_JOB, defaults.job, file.job, runtime),
    runtime: first(options.runtime, env.AGENT_METRICS_RUNTIME, file.runtime, runtime),
    instance: first(options.instance, env.AGENT_METRICS_INSTANCE, defaults.instance, file.instance),
    labels: validateLabels(parseLabels(options.labels ?? env.AGENT_METRICS_LABELS ?? file.labels)),
    token: first(options.token, env.AGENT_METRICS_TOKEN, file.token),
    tokenFile: first(options.tokenFile, env.AGENT_METRICS_TOKEN_FILE, file.tokenFile),
    debug
  };
}

// integrations/common/token-provider.mjs
import { readFile as defaultReadFile } from "node:fs/promises";
var TokenConfigurationError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TokenConfigurationError";
  }
};
function createTokenProvider({ token, tokenFile, readFile = defaultReadFile } = {}) {
  const direct = typeof token === "string" ? token.trim() : "";
  if (direct) return async () => direct;
  if (!tokenFile) return async () => null;
  return async () => {
    let contents;
    try {
      contents = await readFile(tokenFile, "utf8");
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
  tokenProvider = async () => null,
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
        const token = await tokenProvider();
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

// integrations/common/session-aggregator.mjs
function sessionKey(projectKey, sessionID) {
  return `${projectKey}\0${sessionID}`;
}
var ZERO_USAGE = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
function usageTotal(usage = {}) {
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    reasoning: usage.reasoning || 0,
    cache_read: usage.cache?.read || usage.cacheRead || 0,
    cache_write: usage.cache?.write || usage.cacheWrite || 0
  };
}
function createSessionAggregator({ maxSessions = 1e3, maxMessages = 1e3 } = {}) {
  const sessions = /* @__PURE__ */ new Map();
  const revisions = /* @__PURE__ */ new Map();
  let epoch = 0;
  function touch(state) {
    sessions.delete(state.key);
    sessions.set(state.key, state);
  }
  function bumpRevision(key) {
    revisions.set(key, (revisions.get(key) || 0) + 1);
  }
  function evictSessions() {
    let evicted = false;
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      revisions.delete(oldest);
      evicted = true;
    }
    if (evicted) epoch++;
  }
  function ensureState(event, key) {
    let state = sessions.get(key);
    if (!state) {
      state = {
        key,
        sessionLabel: String(event.sessionID),
        projectLabel: event.project.label || event.project.key,
        tokens: {},
        tools: {},
        toolDurationMs: {},
        edits: { added: 0, deleted: 0 },
        permissions: {},
        contextMax: 0,
        startedAt: typeof event.time === "number" ? event.time : 0,
        messages: /* @__PURE__ */ new Map()
      };
      sessions.set(key, state);
      bumpRevision(key);
      evictSessions();
    }
    touch(state);
    return state;
  }
  function apply(event) {
    if (!event?.project?.key || !event?.sessionID) return;
    if (event.type === "session.idle") return;
    const key = sessionKey(event.project.key, event.sessionID);
    if (event.type === "tool.finished") {
      if (!event.tool) return;
      const state2 = ensureState(event, key);
      state2.tools[event.tool] = (state2.tools[event.tool] || 0) + 1;
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs > 0) {
        state2.toolDurationMs[event.tool] = (state2.toolDurationMs[event.tool] || 0) + event.durationMs;
      }
      bumpRevision(key);
      return;
    }
    if (event.type === "file.edited") {
      const added = typeof event.added === "number" && Number.isFinite(event.added) && event.added > 0 ? event.added : 0;
      const deleted = typeof event.deleted === "number" && Number.isFinite(event.deleted) && event.deleted > 0 ? event.deleted : 0;
      if (!added && !deleted) return;
      const state2 = ensureState(event, key);
      state2.edits.added += added;
      state2.edits.deleted += deleted;
      bumpRevision(key);
      return;
    }
    if (event.type === "permission.decided") {
      if (event.decision !== "allow" && event.decision !== "deny") return;
      const state2 = ensureState(event, key);
      state2.permissions[event.decision] = (state2.permissions[event.decision] || 0) + 1;
      bumpRevision(key);
      return;
    }
    if (event.type !== "message.usage" || !event.messageID) return;
    const state = ensureState(event, key);
    const total = usageTotal(event.usage);
    const seen = state.messages.get(event.messageID) || ZERO_USAGE;
    let changed = false;
    for (const [kind, value] of Object.entries(total)) {
      const growth = Math.max(0, value - (seen[kind] || 0));
      if (growth > 0) {
        state.tokens[kind] = (state.tokens[kind] || 0) + growth;
        changed = true;
      }
    }
    const context = total.input + total.cache_read + total.cache_write;
    if (context > state.contextMax) {
      state.contextMax = context;
      changed = true;
    }
    if (!state.messages.has(event.messageID) || changed) {
      const remembered = state.messages.get(event.messageID);
      state.messages.delete(event.messageID);
      const maxima = {};
      for (const [kind, value] of Object.entries(total)) {
        maxima[kind] = Math.max(value, remembered?.[kind] ?? 0);
      }
      state.messages.set(event.messageID, maxima);
      while (state.messages.size > maxMessages) {
        state.messages.delete(state.messages.keys().next().value);
      }
    }
    if (changed) bumpRevision(key);
  }
  function snapshot(project, sessionID, now = Date.now()) {
    if (!project?.key || !sessionID) return null;
    const state = sessions.get(sessionKey(project.key, sessionID));
    if (!state) return null;
    touch(state);
    return {
      tokens: { ...state.tokens },
      tools: { ...state.tools },
      toolDurationMs: { ...state.toolDurationMs },
      edits: { ...state.edits },
      permissions: { ...state.permissions },
      contextMax: state.contextMax,
      durationSeconds: Math.max(0, Math.round((now - state.startedAt) / 1e3))
    };
  }
  function has(key) {
    return sessions.has(key);
  }
  function revision(key) {
    return revisions.get(key) || 0;
  }
  function generation() {
    return epoch;
  }
  return { apply, snapshot, has, revision, generation };
}

// integrations/common/prometheus.mjs
function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
function renderPrometheus({
  labels = {},
  tokens = {},
  tools = {},
  toolDurationMs = {},
  edits = {},
  permissions = {},
  contextMax = 0,
  durationSeconds = 0
}) {
  const labelStr = Object.entries(labels).map(([k, v]) => `${esc(k)}="${esc(v)}"`).join(",");
  const withLabels = (extra) => `{${labelStr ? labelStr + "," : ""}${extra}}`;
  const bare = labelStr ? `{${labelStr}}` : "";
  const lines = [];
  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length) {
    lines.push("# TYPE agent_tokens_total counter");
    for (const [kind, value] of tokenEntries) {
      lines.push(`agent_tokens_total${withLabels(`kind="${esc(kind)}"`)} ${value}`);
    }
  }
  const toolEntries = Object.entries(tools);
  if (toolEntries.length) {
    lines.push("# TYPE agent_tool_calls_total counter");
    for (const [tool, value] of toolEntries) {
      lines.push(`agent_tool_calls_total${withLabels(`tool="${esc(tool)}"`)} ${value}`);
    }
  }
  const editEntries = Object.entries(edits).filter(([, value]) => value > 0);
  if (editEntries.length) {
    lines.push("# TYPE agent_file_edits_total counter");
    for (const [kind, value] of editEntries) {
      lines.push(`agent_file_edits_total${withLabels(`kind="${esc(kind)}"`)} ${value}`);
    }
  }
  const permissionEntries = Object.entries(permissions).filter(([, value]) => value > 0);
  if (permissionEntries.length) {
    lines.push("# TYPE agent_permission_decisions_total counter");
    for (const [decision, value] of permissionEntries) {
      lines.push(`agent_permission_decisions_total${withLabels(`decision="${esc(decision)}"`)} ${value}`);
    }
  }
  const durationEntries = Object.entries(toolDurationMs).filter(([, value]) => value > 0);
  if (durationEntries.length) {
    lines.push("# TYPE agent_tool_duration_seconds_total counter");
    for (const [tool, value] of durationEntries) {
      const seconds = Math.round(value / 1e3 * 1e3) / 1e3;
      lines.push(`agent_tool_duration_seconds_total${withLabels(`tool="${esc(tool)}"`)} ${seconds}`);
    }
  }
  lines.push(`# TYPE agent_context_max_tokens gauge`);
  lines.push(`agent_context_max_tokens${bare} ${contextMax}`);
  lines.push(`# TYPE agent_run_duration_seconds gauge`);
  lines.push(`agent_run_duration_seconds${bare} ${durationSeconds}`);
  return lines.join("\n") + "\n";
}

// integrations/common/event-metrics.mjs
var THROTTLE_MS = 15e3;
var defaultScheduler = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  }
};
function createEventMetrics({
  config,
  client,
  aggregator,
  clock = { now: () => Date.now() },
  scheduler = defaultScheduler,
  maxSessions = 1e3
} = {}) {
  const sessions = /* @__PURE__ */ new Map();
  const inFlight = /* @__PURE__ */ new Set();
  let disposed = false;
  function stateFor(event) {
    const key = sessionKey(event.project.key, event.sessionID);
    let state = sessions.get(key);
    if (!state) {
      state = {
        key,
        project: event.project,
        sessionID: String(event.sessionID),
        projectLabel: event.project.label || event.project.key,
        active: false,
        renderedRevision: 0,
        deliveredRevision: 0,
        epoch: aggregator.generation ? aggregator.generation() : 0,
        lastPushAt: -THROTTLE_MS,
        // first delivery is never throttled
        timer: null
      };
      sessions.set(key, state);
      evictDeliveryState();
    }
    sessions.delete(key);
    sessions.set(key, state);
    return state;
  }
  function evictDeliveryState() {
    if (sessions.size <= maxSessions) return;
    for (const [key, state] of sessions) {
      if (sessions.size <= maxSessions) break;
      if (state.active || state.timer) continue;
      sessions.delete(key);
    }
  }
  function currentRevision(state) {
    const epoch = aggregator.generation ? aggregator.generation() : 0;
    if (epoch !== state.epoch) {
      state.epoch = epoch;
      state.deliveredRevision = 0;
    }
    return aggregator.revision(state.key);
  }
  async function push(state, { final = false } = {}) {
    if (state.active || disposed && !final) return;
    state.active = true;
    const renderedRevision = currentRevision(state);
    state.renderedRevision = renderedRevision;
    const delivery = (async () => {
      const snapshot = aggregator.snapshot(state.project, state.sessionID, clock.now());
      if (snapshot) {
        const labels = {
          ...config.labels,
          runtime: config.runtime,
          session: state.sessionID,
          project: state.projectLabel
        };
        const body = renderPrometheus({
          labels,
          tokens: snapshot.tokens,
          tools: snapshot.tools,
          toolDurationMs: snapshot.toolDurationMs,
          edits: snapshot.edits,
          permissions: snapshot.permissions,
          contextMax: snapshot.contextMax,
          durationSeconds: snapshot.durationSeconds
        });
        const delivered = await client.push({ labels, body });
        if (delivered) state.deliveredRevision = renderedRevision;
      }
    })();
    const tracked = delivery.finally(() => {
      state.active = false;
      inFlight.delete(tracked);
      if (!disposed && currentRevision(state) > renderedRevision) {
        scheduleTimer(state, 0);
      }
    });
    inFlight.add(tracked);
    await tracked;
  }
  function scheduleTimer(state, wait) {
    if (state.timer) return;
    state.timer = scheduler.setTimeout(() => {
      state.timer = null;
      state.lastPushAt = clock.now();
      push(state);
    }, wait);
  }
  function handle(event) {
    aggregator.apply(event);
    if (disposed || !config.enabled) return;
    if (!event?.project?.key || !event?.sessionID) return;
    if (event.type === "session.idle") return;
    const state = stateFor(event);
    if (currentRevision(state) <= state.deliveredRevision) return;
    if (state.active) return;
    const wait = state.lastPushAt + THROTTLE_MS - clock.now();
    if (wait <= 0) {
      state.lastPushAt = clock.now();
      push(state);
      return;
    }
    scheduleTimer(state, wait);
  }
  async function flush({ project, sessionID }) {
    if (disposed || !project?.key || !sessionID) return;
    const state = sessions.get(sessionKey(project.key, sessionID));
    if (!state || state.active) return;
    if (currentRevision(state) <= state.deliveredRevision) return;
    if (state.timer) {
      scheduler.clearTimeout(state.timer);
      state.timer = null;
    }
    state.lastPushAt = clock.now();
    await push(state);
  }
  async function dispose() {
    disposed = true;
    for (let safety = 0; safety < 10; safety++) {
      for (const state of sessions.values()) {
        if (state.timer) {
          scheduler.clearTimeout(state.timer);
          state.timer = null;
        }
      }
      const dirty = [...sessions.values()].filter(
        (state) => !state.active && currentRevision(state) > state.deliveredRevision
      );
      const finals = dirty.map((state) => {
        state.deliveredRevision = aggregator.revision(state.key);
        return push(state, { final: true });
      });
      const pending = [...inFlight];
      if (!finals.length && !pending.length) break;
      await Promise.allSettled([...finals, ...pending]);
    }
  }
  return { handle, flush, dispose };
}

// integrations/common/diff-lines.mjs
function countDiffLines(diffText) {
  if (typeof diffText !== "string") return { added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) deleted++;
  }
  return { added, deleted };
}

// integrations/opencode/plugin.js
function configFilePathCandidates(env = process.env, home = homedir()) {
  return [
    env.OPENCODE_CONFIG_DIR,
    join(home, ".config", "opencode"),
    join(home, ".opencode")
  ].filter(Boolean).map((root) => join(root, "agent-metrics.json"));
}
function normalizeUsage(tokens = {}) {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache?.read,
    cacheWrite: tokens.cache?.write
  };
}
var MetricsPlugin = async (input, options = {}) => {
  const config = resolveMetricsConfig({
    options,
    env: process.env,
    runtime: "opencode",
    defaults: { instance: hostname() },
    configFilePath: configFilePathCandidates()
  });
  const client = createPushgatewayClient({ config, tokenProvider: createTokenProvider(config) });
  const metrics = createEventMetrics({ config, client, aggregator: createSessionAggregator() });
  const key = input?.project?.id || input?.worktree || input?.directory;
  const directory = input?.worktree || input?.directory || key;
  const project = key ? { key, label: directory ? basename(directory) : key } : null;
  function debug(message) {
    if (config.debug) console.error(`[agent-run-metrics] ${message}`);
  }
  const pendingToolStarts = /* @__PURE__ */ new Map();
  const MAX_PENDING_TOOL_STARTS = 1e3;
  function rememberToolStart(callID, tool) {
    if (!callID) return;
    while (pendingToolStarts.size >= MAX_PENDING_TOOL_STARTS) {
      pendingToolStarts.delete(pendingToolStarts.keys().next().value);
    }
    pendingToolStarts.set(String(callID), { tool, startedAt: Date.now() });
  }
  function takeToolDuration(callID) {
    const entry = callID ? pendingToolStarts.get(String(callID)) : void 0;
    if (!entry) return void 0;
    pendingToolStarts.delete(String(callID));
    return Math.max(0, Date.now() - entry.startedAt);
  }
  return {
    "tool.execute.before": async (toolInput) => {
      rememberToolStart(toolInput?.callID, String(toolInput?.tool || "unknown"));
    },
    "tool.execute.after": async (toolInput, result) => {
      if (!toolInput?.sessionID) return;
      if (!project) return debug("event dropped: no project identity from the host");
      const sessionID = String(toolInput.sessionID);
      const tool = String(toolInput.tool || toolInput.toolName || "unknown");
      metrics.handle({
        type: "tool.finished",
        sessionID,
        project,
        tool,
        durationMs: takeToolDuration(toolInput.callID),
        time: Date.now()
      });
      const diff = result?.metadata?.diff;
      if (typeof diff === "string") {
        const { added, deleted } = countDiffLines(diff);
        metrics.handle({ type: "file.edited", sessionID, project, added, deleted, time: Date.now() });
      }
    },
    event: async ({ event }) => {
      if (event?.type === "session.idle") {
        const sessionID = event.properties?.sessionID;
        if (!sessionID || !project) {
          if (sessionID) debug("event dropped: no project identity from the host");
          return;
        }
        await metrics.flush({ project, sessionID: String(sessionID) });
        return;
      }
      if (event?.type === "permission.replied") {
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;
        if (!project) return debug("event dropped: no project identity from the host");
        metrics.handle({
          type: "permission.decided",
          sessionID: String(sessionID),
          project,
          decision: event.properties.response === "reject" ? "deny" : "allow",
          time: Date.now()
        });
        return;
      }
      if (event?.type !== "message.updated") return;
      const info = event.properties?.info || {};
      if (info.role !== "assistant" || !info.id || !info.sessionID) return;
      if (!project) return debug("event dropped: no project identity from the host");
      metrics.handle({
        type: "message.usage",
        sessionID: String(info.sessionID),
        messageID: String(info.id),
        project,
        usage: normalizeUsage(info.tokens),
        time: Date.now()
      });
    },
    dispose: () => metrics.dispose()
  };
};

// integrations/opencode/embed.mjs
globalThis.__agentRunMetricsCore = { MetricsPlugin };
