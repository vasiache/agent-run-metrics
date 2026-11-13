# Host-Neutral Live Metrics Core Design

**Date:** 2026-11-12

## Intent

Make `agent-run-metrics` a vendor-neutral OSS project whose live OpenCode and Claude Code integrations share configuration, credential, transport, and correctness logic. Harness must be able to vendor a ready OpenCode V1 JavaScript artifact without patching it or supplying a JavaScript adapter.

## Goals

- Support OpenCode V1 used by Harness `1.18.29` and the latest stable OpenCode `1.19.x`.
- Migrate Claude Code live hooks to the same generic configuration and native HTTP transport.
- Provide one self-contained OpenCode V1 artifact and one self-contained Claude Code hook artifact, built and tested in OSS.
- Use full session IDs and isolate counters by project and session.
- Preserve monitoring fail-open behavior: metrics failures must not fail agent work.
- Define reusable adapter contracts and contract tests from the two working runtimes.

## Non-goals

- No DeepSeekCode, KiloCode, or QwenCode research or implementation in this phase.
- No Harness-specific or eharness-specific behavior in generic OSS code.
- No changes to `harnessctl` or its OpenCode fork.
- No migration or new features for the Python timeline/report scripts. Existing reports must remain fully self-contained in OSS and use the repository-owned stdlib helper.
- No empty adapter for the next OpenCode API. Its current `dev` documentation does not expose the assistant usage snapshots and arbitrary completed-tool events required for equivalent metrics; V2 requires a separate feasibility decision.
- No git push. Commits only if the user explicitly requests them.

## Existing Constraints

The working tree already contains an unfinished migration to `integrations/common/port_transport.mjs`. That transport requires Python and an external `saas_agent` port. The live artifact must instead be self-contained and use native JavaScript HTTP.

The repository has no JavaScript package or test toolchain. Existing OpenCode and Claude Code implementations also contain implicit Harness identity, telemetry, grant-store, and CLI fallback behavior. Generic OSS code must not depend on those paths or commands. OSS self-containment takes precedence over preserving the unfinished external-port migration: report scripts keep the repository-owned `integrations/common/agent_metrics.py` helper and local imports, with no `adapters.*` or `saas_agent` dependency.

## Architecture

Keep the existing repository layout. `integrations/common/` becomes the host-neutral live core. OpenCode and Claude Code remain in their existing integration directories.

Two integration styles are supported explicitly:

1. **Event-driven hosts** such as OpenCode use normalized events and the stateful session core.
2. **Snapshot-driven hosts** such as Claude Code reread a transcript, calculate a cumulative snapshot locally, and reuse generic configuration, rendering primitives, token resolution, and HTTP delivery.

Do not force transcript aggregation into the event API and do not duplicate transport or credential code to avoid that abstraction.

### Common interfaces

```js
resolveMetricsConfig({ options, env, runtime, defaults })
createTokenProvider({ token, tokenFile, readFile })
createPushgatewayClient({ endpoint, tokenProvider, fetch, timeoutMs, debug })
createEventMetrics({ config, client, clock, scheduler, limits })
renderPrometheus(snapshot)
```

`createEventMetrics` returns:

```js
{ handle(event), flush(sessionKey), dispose() }
```

Normalized events are:

```js
{ type: "message.usage", sessionID, messageID, project, usage }
{ type: "tool.finished", sessionID, project, tool, durationMs? }
{ type: "file.edited", sessionID, project, added, deleted }
{ type: "permission.decided", sessionID, project, decision: "allow" | "deny" }
{ type: "session.idle", sessionID, project }
```

Usage fields are `input`, `output`, `reasoning`, `cacheRead`, and `cacheWrite`. Adapters own conversion from host-specific events. Core owns per-session deltas and delivery.

### OpenCode V1

`integrations/opencode/plugin.js` remains the source entrypoint and exports:

```js
MetricsPlugin(input, options?)
```

It maps `message.updated`, `tool.execute.after`, `permission.replied`, and `session.idle` into normalized events. Tool wall-clock duration comes from pairing `tool.execute.before`/`tool.execute.after` by call ID; edit line counts come from the unified diff in the edit tool result metadata (approximate: unified diff content lines only). Permission replies map `reject` to `deny` and every other response to `allow`. A missing pairing (after without before) still counts the call but contributes no duration. It accepts both generic plugin options and existing `AGENT_METRICS_*` environment variables. Explicit options take precedence over environment values. The built V1 artifact remains a named-export, self-contained JavaScript file suitable for Harness vendoring.

A session error counter was considered and deferred (2026-11-12): the Harness OpenCode fork publishes no `session.error` bus event and Claude Code hooks expose no equivalent, so the core event model intentionally has no error event until a host provides one.

### Claude Code

`integrations/claude-code/push-metrics.mjs` retains transcript parsing, cumulative aggregation, subagent handling, and Claude-specific metric families. It replaces Python transport, implicit grant discovery, and Harness identity/profile lookup with common generic modules. Session labels use the full session ID.

Edit lines and tool durations come from the transcript (2026-11-12): added/deleted lines from `Edit`/`MultiEdit`/`Write` tool inputs via prefix/suffix trim plus longest-common-subsequence (empty string counts as zero lines; revisions above 2000 remaining lines fall back to raw counts), and wall-clock durations from pairing `tool_use` ids with their `tool_result` entries' timestamps. Permission decisions are deferred: the `PermissionRequest` hook is pre-decision only, `PermissionDenied` fires in auto mode exclusively, and no hook fires when the user denies in the UI, so Claude Code emits no permission family. The transcript format is internal to Claude Code and may change between releases; parsing tolerates malformed lines by design.

`install.mjs` installs the self-contained built hook artifact and uses native HTTP for the optional health check.

## Configuration

Generic options are:

```text
endpoint
job
runtime
instance
labels
token
tokenFile
debug
```

Environment mappings remain:

```text
AGENT_METRICS_PUSHGATEWAY
AGENT_METRICS_JOB
AGENT_METRICS_RUNTIME
AGENT_METRICS_INSTANCE
AGENT_METRICS_LABELS
AGENT_METRICS_TOKEN
AGENT_METRICS_TOKEN_FILE
AGENT_METRICS_DEBUG
```

`endpoint` is required to enable delivery. If it is absent, the integration is disabled and performs no configuration, credential, telemetry, or network I/O beyond host event normalization.

`token` takes precedence over `tokenFile`. Token files contain a raw token, trimmed before use. An explicitly configured unreadable or empty token file disables delivery and reports one concise debug error; there is no unauthenticated fallback. Token files are reread for each delivery so rotation works. No secret is logged or copied.

The endpoint is used verbatim. No `<tenant>` substitution is performed: tenant routing was removed from the vendor-neutral core (2026-11-12), and callers compose the full URL, including any tenant path segment. No vendor base URL, provider credential, or environment prefix is inferred.

## Session and Delivery Semantics

- State is keyed by full project identity plus full session ID. Truncated session labels are forbidden.
- Event counters, throttle, message snapshots, and push serialization are per session.
- Repeated message snapshots contribute only nonnegative growth.
- A message snapshot with missing ID or session ID is ignored rather than merged into a shared anonymous bucket.
- `agent_context_max_tokens` is the maximum observed prompt usage: `input + cacheRead + cacheWrite`. It is not model context-window capacity and excludes output and reasoning tokens.
- One HTTP request is active per session. Changes during that request mark a newer revision; exactly one trailing delivery is scheduled after it. An idle flush bypasses throttle only when the session is dirty.
- The throttle remains 15 seconds and the HTTP timeout remains 5 seconds.
- HTTP non-2xx responses, network errors, timeouts, and token errors fail the current delivery without failing the agent. A later dirty event may retry.
- Pending timers are unreferenced where supported and never keep a CLI alive.
- Session and message caches are bounded: at most 1000 sessions and 1000 message snapshots per session, using least-recently-used eviction. Tests pin the bounds and document that later events for evicted snapshots start a new baseline.

### Project identity and reserved labels (design calls)

- OpenCode uses `PluginInput.project.id` as the internal `project.key`, with `worktree` then `directory` as deterministic fallbacks. The public `project` label remains the basename of `worktree` or `directory` for dashboard compatibility. If neither key nor directory is available, the event is ignored with one debug message instead of entering an anonymous shared bucket.
- Claude Code uses the canonical transcript directory as the internal `project.key`; this always has the transcript path as a fallback. The public `project` label retains the decoded basename when available and is omitted otherwise. Full filesystem paths are not emitted as labels.
- `runtime`, `session`, `project`, `instance`, `job`, `kind`, `tool`, `skill`, `plugin`, and `agent` are reserved. Custom `labels` cannot override them. Reserved or syntactically invalid Prometheus label names disable delivery with one debug configuration error instead of silently merging sessions or emitting duplicate labels. Top-level `runtime`/`instance` settings remain supported; session and project identity come only from the adapter.

### Disposal guarantee (design call)

`dispose()` is async. It rejects new events, cancels pending timers, marks every dirty session for final delivery, awaits each active request and its required trailing request, and returns only after all final deliveries have either completed or made one failed attempt. After `await dispose()` no timer or network operation remains. Delivery errors remain fail-open and are reported only through debug logging. OpenCode exposes this through its plugin `dispose` hook; Claude Code awaits its snapshot delivery before process exit.

## Packaging and Tests

Use Node.js `>=18`, built-in `node:test`, and a pinned esbuild dev dependency. Build checked-in artifacts:

```text
dist/opencode/v1/plugin.js
dist/claude-code/push-metrics.mjs
```

Node builtins remain external. The OpenCode artifact exports `MetricsPlugin`; the Claude artifact preserves its executable shebang. OSS tests import or execute copies of these exact artifacts from an isolated directory without `node_modules`.

Unit tests cover configuration precedence, token rotation and failures, URL rendering, HTTP status/timeout behavior, parallel projects/sessions, duplicate snapshots, in-flight trailing delivery, idle flush, bounded state, and disabled-mode zero I/O. Integration tests compare OpenCode and Claude behavior through shared fixtures where their semantics overlap and retain Claude-specific fixture coverage.

The adapter template is documentation plus reusable contract suites, not an empty future integration. It describes both event-driven and snapshot-driven styles.

## Documentation and Compatibility

README documents:

- the stable OpenCode V1 and Harness-compatible V1 artifact;
- generic options and environment variables;
- full-session and context metric semantics;
- the breaking removal of implicit Harness/eharness credential and telemetry fallbacks;
- the next OpenCode API as pending feasibility, not supported yet;
- build artifact provenance and the check that regeneration produces no diff.

No CRPT-specific configuration example belongs in generic OSS documentation. Deployment-specific mappings remain the consumer's responsibility.
