# Adapter Template

How to integrate `agent-run-metrics` into a new AI coding agent host. The
project supports two adapter styles; every adapter delegates behavior to the
host-neutral core in `integrations/common/` and proves itself with the
matching contract suite. This document is the implementation checklist for
future runtimes — there are no scaffolded entrypoints for hosts that are not
implemented yet. DeepSeekCode, KiloCode, QwenCode and the next-generation
OpenCode plugin API are explicitly outside the current phase.

## Style 1: Event-driven hosts

For runtimes that stream events (assistant usage snapshots, completed tool
calls, session idle) into a long-lived plugin: OpenCode V1 is the reference
implementation (`integrations/opencode/plugin.js`).

The adapter owns only event normalization:

```js
// usage: one normalized event per assistant message update
{ type: "message.usage", sessionID, messageID, project: { key, label }, usage: {
    input, output, reasoning, cacheRead, cacheWrite }, time }
// tools (durationMs optional; when absent the duration family stays empty)
{ type: "tool.finished", sessionID, project, tool, durationMs?, time }
// file edits (approximate line counts from edit diffs; host-dependent)
{ type: "file.edited", sessionID, project, added, deleted, time }
// permission outcomes; unknown decision values are dropped by the core
{ type: "permission.decided", sessionID, project, decision: "allow" | "deny", time }
// lifecycle (delivery trigger only; core owns throttling)
adapter calls flush({ project, sessionID }) on session idle/end
```
Every family degrades gracefully: an adapter whose host cannot provide an
event simply never emits it; the core renders only non-empty families.

Requirements:

- `project.key` must be a stable host identity (project id, worktree, or
  canonical directory). `project.label` is a short public label (basename).
  An event without a determinable key is dropped with a debug message, never
  merged into an anonymous bucket.
- Session and message identifiers pass through unmodified; the public
  `session` label is the full id. Truncation is forbidden.
- Usage deltas are computed by the core from repeated snapshots; the adapter
  forwards raw totals. `contextMax` is derived by the core as
  `input + cacheRead + cacheWrite` — maximum observed prompt usage, not
  model window capacity.
- The adapter accepts explicit options first, then `AGENT_METRICS_*`
  environment variables (`integrations/common/config.mjs`). Reserved label
  names (`runtime`, `session`, `project`, `instance`, `job`, `kind`, `tool`,
  `skill`, `plugin`, `agent`, `decision`) are rejected in custom `labels`.
- The adapter exposes a `dispose` hook delegating to core `dispose()`.

Contract suite: `contract-tests/event-adapter.suite.mjs`
(`runEventAdapterSuite({ label, createPlugin, usage, idle })`). Invoke it
from the adapter's artifact test with a copy of the built artifact.

## Style 2: Snapshot-driven hosts

For hook-style runtimes where each invocation recomputes cumulative totals
(stateless, crash-safe): Claude Code is the reference implementation
(`integrations/claude-code/push-metrics.mjs`).

The adapter owns transcript aggregation and reuses the core for everything
else:

- `createTokenProvider` (direct token, then raw token file reread per push),
- `createPushgatewayClient` (bounded native fetch, bearer header,
  2xx-or-false delivery),
- label escaping rules and the shared metric naming vocabulary.

Requirements:

- Full session id in the `session` label; no truncation, no shared
  anonymous grouping.
- No host-side credential discovery: only `AGENT_METRICS_TOKEN` /
  `AGENT_METRICS_TOKEN_FILE`. An explicitly configured token file that is
  missing, empty, or unreadable fails that push.
- Without `AGENT_METRICS_PUSHGATEWAY` the hook exits cleanly and performs
  no network I/O.
- Monitoring stays fail-open: a push failure never fails the agent work.

Contract suite: `contract-tests/snapshot-adapter.suite.mjs`
(`runSnapshotAdapterSuite({ label, runHook, fixture })`). Invoke it from the
adapter's artifact test.

## Capabilities a host must expose

Before starting an adapter for a new runtime, confirm the host can provide:

| Capability | Event style | Snapshot style |
|---|---|---|
| Per-message usage totals (input/output/cache) | required | transcript or API |
| Session identity | required | required |
| Project/worktree identity | required | required |
| Completed tool calls with names | required | transcript or API |
| Idle/end-of-turn signal | required | recommended |
| Plugin `dispose`/shutdown hook | required | process exit |
| Long-lived background timers/network | required | not required |

If usage totals or tool completions are unavailable, metrics cannot be
reproduced faithfully — a wrapper, proxy, or upstream change is required
before an adapter makes sense.

## Configuration contract (shared)

Options: `endpoint`, `job`, `runtime`, `instance`, `labels`, `token`,
`tokenFile`, `debug`. Environment: `AGENT_METRICS_PUSHGATEWAY`,
`AGENT_METRICS_JOB`, `AGENT_METRICS_RUNTIME`, `AGENT_METRICS_INSTANCE`,
`AGENT_METRICS_LABELS`, `AGENT_METRICS_TOKEN`, `AGENT_METRICS_TOKEN_FILE`,
`AGENT_METRICS_DEBUG`. Explicit options win over environment. No vendor
credential prefixes, base URLs, or store paths are inferred by the core;
deployment-specific mappings belong to the consumer's configuration.

## Build provenance

Artifacts are built with esbuild into checked-in `dist/` paths
(`scripts/build.mjs`, `npm run build`). Node builtins stay external;
relative imports are bundled. Verify with `npm run check:artifacts`
(regeneration must produce no diff) and keep the artifact tests importing a
copied artifact from an isolated directory without `node_modules`.
