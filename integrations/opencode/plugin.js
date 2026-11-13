// agent-run-metrics — OpenCode V1 adapter.
//
// Thin integration for OpenCode 1.x (Harness fork 1.18.29 and stable 1.19.x):
// normalizes host events and delegates configuration, aggregation, throttled
// delivery, and disposal to the vendor-neutral common core. All behavior
// lives in integrations/common; this file only maps event shapes.
//
// Configure with plugin options (see opencode.json "plugin" tuples) or the
// AGENT_METRICS_* environment variables; explicit options win. Without an
// endpoint the plugin stays enabled but performs no I/O.
//
//   endpoint / AGENT_METRICS_PUSHGATEWAY   PushGateway URL; "<tenant>" is
//     replaced with the tenant_id claim of the token
//   token / AGENT_METRICS_TOKEN            bearer token
//   tokenFile / AGENT_METRICS_TOKEN_FILE   raw token file, reread per push
//   job, runtime, instance, labels, debug  see integrations/common/config.mjs

import { basename } from "node:path";
import { hostname } from "node:os";

import { resolveMetricsConfig } from "../common/config.mjs";
import { createTokenProvider } from "../common/token-provider.mjs";
import { createPushgatewayClient } from "../common/pushgateway.mjs";
import { createSessionAggregator } from "../common/session-aggregator.mjs";
import { createEventMetrics } from "../common/event-metrics.mjs";
import { countDiffLines } from "../common/diff-lines.mjs";

function normalizeUsage(tokens = {}) {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache?.read,
    cacheWrite: tokens.cache?.write,
  };
}

export const MetricsPlugin = async (input, options = {}) => {
  const config = resolveMetricsConfig({
    options,
    env: process.env,
    runtime: "opencode",
    defaults: { instance: hostname() },
  });
  const client = createPushgatewayClient({ config, tokenProvider: createTokenProvider(config) });
  const metrics = createEventMetrics({ config, client, aggregator: createSessionAggregator() });

  const key = input?.project?.id || input?.worktree || input?.directory;
  const directory = input?.worktree || input?.directory || key;
  const project = key
    ? { key, label: directory ? basename(directory) : key }
    : null;

  function debug(message) {
    if (config.debug) console.error(`[agent-run-metrics] ${message}`);
  }

  // tool.execute.before -> after pairing by callID for wall-clock durations;
  // bounded so an abandoned call id cannot grow the map without limit
  const pendingToolStarts = new Map();
  const MAX_PENDING_TOOL_STARTS = 1000;

  function rememberToolStart(callID, tool) {
    if (!callID) return;
    while (pendingToolStarts.size >= MAX_PENDING_TOOL_STARTS) {
      pendingToolStarts.delete(pendingToolStarts.keys().next().value);
    }
    pendingToolStarts.set(String(callID), { tool, startedAt: Date.now() });
  }

  function takeToolDuration(callID) {
    const entry = callID ? pendingToolStarts.get(String(callID)) : undefined;
    if (!entry) return undefined;
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
        time: Date.now(),
      });
      const diff = result?.metadata?.diff;
      if (typeof diff === "string") {
        const { added, deleted } = countDiffLines(diff);
        metrics.handle({ type: "file.edited", sessionID, project, added, deleted, time: Date.now() });
      }
    },
    event: async ({ event }) => {
      if (event?.type === "session.idle") {
        const sessionID = event.properties?.sessionID; // direct property, not info
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
          time: Date.now(),
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
        time: Date.now(),
      });
    },
    dispose: () => metrics.dispose(),
  };
};
