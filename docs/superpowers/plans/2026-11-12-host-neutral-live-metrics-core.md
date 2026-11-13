# Host-Neutral Live Metrics Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship self-contained, vendor-neutral OpenCode V1 and Claude Code live metrics artifacts backed by shared configuration, credential, transport, and correctness logic.

**Architecture:** `integrations/common/` hosts generic modules. OpenCode uses normalized events and a stateful per-project/per-session core; Claude Code keeps cumulative transcript aggregation and reuses generic config, token, rendering, and HTTP modules. Checked-in esbuild artifacts are tested after copying them into an isolated directory without dependencies.

**Tech Stack:** JavaScript ESM, Node.js >=18, `node:test`, native `fetch`, esbuild `0.25.5`.

**Spec:** `docs/superpowers/specs/2026-11-12-host-neutral-live-metrics-core-design.md`

## Global Constraints

- Change only `/home/vasche/projects/agent-run-metrics`; do not modify Harness or its OpenCode fork.
- No DeepSeekCode, KiloCode, QwenCode, or empty next-generation OpenCode adapter.
- No CRPT, Harness, eharness, `~/.saas`, or external Python runtime discovery in generic live code.
- Self-contained OSS takes precedence over the unfinished external-port migration; no runtime or report code may depend on `adapters.*`, `saas_agent`, or an external Python package.
- Keep the repository-owned stdlib report helper and local timeline imports; no new report features.
- Missing endpoint means disabled metrics and no token, telemetry, or network I/O.
- Full session IDs only; no silent anonymous session/project bucket.
- Monitoring remains fail-open for agent work and never logs credentials.
- Do not commit or push unless the user explicitly asks.

## Review Focus

- Reserved or malformed custom labels can merge otherwise isolated sessions; Task 1 tests rejection.
- Missing session/message/project identifiers can corrupt deltas; Tasks 3 and 5 test ignore behavior.
- Rotated, empty, or unreadable token files can cause stale or unauthenticated delivery; Tasks 1 and 2 test exact behavior.
- Teardown during an active request can lose the newest revision or leave work alive; Task 4 tests final delivery and quiescence.
- A copied artifact can accidentally retain relative imports or runtime dependencies; Tasks 5 and 6 test isolated execution.

---

### Task 1: Generic Configuration and Token Provider

**Files:**
- Create: `package.json`, `package-lock.json`
- Create: `integrations/common/config.mjs`
- Create: `integrations/common/token-provider.mjs`
- Create: `tests/config.test.mjs`, `tests/token-provider.test.mjs`

**Interfaces:**
- Produces: `resolveMetricsConfig({ options, env, runtime, defaults }) -> { enabled, endpoint, job, runtime, instance, labels, token, tokenFile, debug }`.
- Produces: `createTokenProvider({ token, tokenFile, readFile }) -> async () => string | null`; explicit file failures throw `TokenConfigurationError`.
- Consumes: no existing runtime modules.

- [ ] **Step 1: Add the test toolchain and failing configuration tests**

Set `type: "module"`, `scripts.test` to `node --test tests`, and `scripts.build` to `node scripts/build.mjs`. Pin esbuild `0.25.5` as the only dev dependency and generate the lockfile. Tests assert options override ENV, runtime defaults are adapter-supplied, absent endpoint returns `{ enabled: false }`, and reserved/invalid custom label names throw `MetricsConfigurationError`.

- [ ] **Step 2: Run configuration tests and verify failure**

Run: `npm test -- --test-name-pattern='configuration'`
Expected: FAIL because `config.mjs` does not exist.

- [ ] **Step 3: Implement pure configuration resolution**

Map existing ENV names, add `AGENT_METRICS_TOKEN_FILE`, and preserve `AGENT_METRICS_DEBUG` as the generic options listed in the spec. Return early with `enabled: false` when endpoint is blank. Reserve `runtime`, `session`, `project`, `instance`, `job`, `kind`, `tool`, `skill`, `plugin`, and `agent`; validate remaining names as Prometheus identifiers.

- [ ] **Step 4: Add failing token-provider tests**

Cover direct token precedence, raw file trimming, rereading on every call for rotation, absent optional file returning `null`, and explicitly configured missing/empty/unreadable file throwing without exposing file contents.

- [ ] **Step 5: Implement token provider and run Task 1 tests**

Run: `npm test -- --test-name-pattern='configuration|token provider'`
Expected: PASS. Confirm with a read-count fake that disabled configuration performs no token-file read.

### Task 2: Native PushGateway Transport

**Files:**
- Create: `integrations/common/pushgateway.mjs`
- Create: `tests/pushgateway.test.mjs`
- Test: `tests/pushgateway.test.mjs`

**Interfaces:**
- Consumes: Task 1 token provider and resolved config.
- Produces: `buildPushgatewayUrl({ endpoint, job, instance, labels, token }) -> string`.
- Produces: `createPushgatewayClient({ config, tokenProvider, fetchImpl, timeoutMs = 5000, logger }) -> { push({ labels, body }) -> Promise<boolean> }`.

- [ ] **Step 1: Write failing URL and delivery tests**

Cover label escaping, job/instance encoding, `<tenant>` substitution, missing tenant claim, raw bearer header, token rotation between pushes, non-2xx result, network exception, and abort after the configured timeout. Assert no request or token read occurs for disabled config and no token appears in logs.

- [ ] **Step 2: Run transport tests and verify failure**

Run: `npm test -- --test-name-pattern='pushgateway'`
Expected: FAIL because `pushgateway.mjs` does not exist.

- [ ] **Step 3: Implement native bounded delivery**

Use `fetchImpl(url, { method: "POST", headers, body, signal })` with `AbortSignal.timeout(timeoutMs)`. Require a 2xx response for `true`; return `false` for request, token, and tenant failures and emit only optional concise debug diagnostics.

- [ ] **Step 4: Run transport and regression tests**

Run: `npm test -- --test-name-pattern='configuration|token provider|pushgateway'`
Expected: PASS.

### Task 3: Per-Project Session Aggregation

**Files:**
- Create: `integrations/common/session-aggregator.mjs`
- Create: `integrations/common/prometheus.mjs`
- Create: `tests/session-aggregator.test.mjs`, `tests/prometheus.test.mjs`

**Interfaces:**
- Consumes: normalized events defined by the spec.
- Produces: `createSessionAggregator({ maxSessions = 1000, maxMessages = 1000 }) -> { apply(event), snapshot(project, sessionID, now), has(sessionKey), revision(sessionKey) }`.
- Produces: `renderPrometheus({ labels, tokens, tools, contextMax, durationSeconds }) -> string`.

- [ ] **Step 1: Write failing isolation and delta tests**

Use sessions `ses_ce7aAAAA` and `ses_ce7aBBBB` with interleaved snapshots. Assert 100 and 50 input tokens remain separate, duplicate snapshots add zero, negative growth adds zero, identical session IDs in different project keys remain separate, and missing project/session/message IDs are ignored.

- [ ] **Step 2: Write failing context, bounds, and rendering tests**

Assert context is `input + cacheRead + cacheWrite`, excluding output/reasoning. Assert LRU bounds of 1000 sessions and 1000 message snapshots per session, full session/project labels, valid Prometheus escaping, one TYPE line per family, and duration from the session's first event.

- [ ] **Step 3: Run aggregation tests and verify failure**

Run: `npm test -- --test-name-pattern='session aggregator|prometheus'`
Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement bounded aggregation and rendering**

Key state by `[project.key, sessionID]`; keep full IDs in labels and basename only in `project.label`. Apply nonnegative deltas, increment the session revision only for actual changes, and mark that revision for delivery. Implement deterministic LRU eviction and document the new-baseline behavior for later events after eviction.

- [ ] **Step 5: Run Task 3 tests**

Run: `npm test -- --test-name-pattern='session aggregator|prometheus'`
Expected: PASS.

### Task 4: Throttle, Trailing Delivery, and Disposal

**Files:**
- Create: `integrations/common/event-metrics.mjs`
- Create: `tests/event-metrics.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `createEventMetrics({ config, client, aggregator, clock, scheduler }) -> { handle(event), flush({ project, sessionID }), dispose() }`.
- Scheduler shape: `{ setTimeout, clearTimeout }`; clock shape: `{ now() }`.

- [ ] **Step 1: Write failing in-flight queue tests**

Use controllable deferred fetches. Start push A, add newer usage, call idle, and assert no concurrent second request for that session. Resolve A and assert exactly one trailing request containing the newest totals. Verify another session can push independently.

- [ ] **Step 2: Write failing throttle and disposal tests**

Assert a 15-second per-session throttle, one unreferenced trailing timer, idle bypass only for dirty state, and no push for an unchanged idle session. During disposal, assert timer cancellation, final dirty delivery, waiting for active plus trailing requests, one failed final attempt on HTTP failure, and no timers/network afterward.

- [ ] **Step 3: Run queue tests and verify failure**

Run: `npm test -- --test-name-pattern='event metrics'`
Expected: FAIL because `event-metrics.mjs` does not exist.

- [ ] **Step 4: Implement revision-based delivery**

Use monotonically increasing session revisions rather than a boolean dirty flag. Set the active-push guard synchronously before any `await`; a completed request schedules one trailing push whenever its rendered revision is stale. `dispose()` follows the spec's final-attempt guarantee.

- [ ] **Step 5: Run all core tests**

Run: `npm test`
Expected: PASS.

### Task 5: OpenCode V1 Adapter and Copyable Artifact

**Files:**
- Modify: `integrations/opencode/plugin.js`
- Create: `scripts/build.mjs`
- Create: `dist/opencode/v1/plugin.js`
- Create: `tests/opencode-v1.test.mjs`, `tests/opencode-artifact.test.mjs`

**Interfaces:**
- Consumes: Task 4 `createEventMetrics` and Tasks 1–2 config/client.
- Produces: `MetricsPlugin(input, options?) -> { event, tool.execute.after, dispose }`.
- Produces: self-contained `dist/opencode/v1/plugin.js` with named export `MetricsPlugin`.

- [ ] **Step 1: Write failing adapter normalization tests**

Assert assistant usage mapping, cache fields, `tool.execute.after`, direct `event.properties.sessionID` for idle, non-assistant/unknown-event ignoring, full session labels, and plugin `dispose` delegation. Capture `project.id` from `PluginInput`, falling back to worktree/directory as specified.

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `npm test -- --test-name-pattern='opencode v1'`
Expected: FAIL against the legacy mixed-state implementation.

- [ ] **Step 3: Replace the OpenCode entrypoint with a thin adapter**

Remove Python transport, Harness telemetry, eharness grant discovery, truncated IDs, global counters, and direct `info.contextWindow` access. Normalize host events and delegate everything else to common modules. Explicit V1 options override ENV.

- [ ] **Step 4: Build and test the isolated artifact**

Configure esbuild ESM bundling with Node builtins external. Copy only `dist/opencode/v1/plugin.js` into a temporary empty directory, import it, and run parallel-session and in-flight-idle scenarios with mocked fetch. Also assert the artifact has no relative imports and disabled config performs no I/O.

Run: `npm run build && npm test -- --test-name-pattern='opencode'`
Expected: PASS and a generated `dist/opencode/v1/plugin.js` with named `MetricsPlugin` export.

### Task 6: Claude Code Migration and Installable Artifact

**Files:**
- Modify: `integrations/claude-code/push-metrics.mjs`
- Modify: `integrations/claude-code/install.mjs`
- Modify: `scripts/build.mjs`
- Delete: `integrations/common/port_transport.mjs` if present after all JS consumers are migrated
- Create: `dist/claude-code/push-metrics.mjs`
- Create: `tests/claude-code.test.mjs`, `tests/claude-artifact.test.mjs`, `tests/claude-install.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3 common config, token, HTTP, and escaping primitives.
- Produces: self-contained executable `dist/claude-code/push-metrics.mjs`.
- Preserves: `aggregate(transcriptPath)`, `render(acc, labels, subagents)`, CLI `--self-test`, and existing Claude-specific metric families.

- [ ] **Step 1: Add failing Claude regression tests**

Use the existing JSONL fixtures to pin cumulative tokens, tools, skills, plugins, subagents, malformed-line tolerance, and context formula. Add parallel transcripts with shared session prefixes and assert full session labels. Assert no Harness identity/profile reads and no eharness/Python invocation.

- [ ] **Step 2: Migrate transcript delivery without changing aggregation semantics**

Keep transcript/subagent aggregation local. Replace port transport and implicit credential fallbacks with common modules; export pure functions for tests and invoke `main()` only for direct execution. Use canonical transcript directory internally and full session ID externally.

- [ ] **Step 3: Build and test the isolated Claude hook**

Preserve the shebang in the esbuild output. Copy only the artifact into an empty directory, run `--self-test` against a fixture, then execute a hook against a local HTTP test server and verify body and bearer header. Assert installer copies this built artifact, remains idempotent, and performs health checks with bounded native fetch.

Run: `npm run build && npm test -- --test-name-pattern='claude'`
Expected: PASS.

- [ ] **Step 4: Remove any obsolete JS port and run regression tests**

Verify no JS imports of `port_transport.mjs` remain and delete that file if present. Keep timeline scripts on the repository-owned local Python helper; do not add report features.

Run: `npm test`
Expected: PASS.

### Task 7: Adapter Contracts, Documentation, and Release Checks

**Files:**
- Create: `contract-tests/event-adapter.suite.mjs`
- Create: `contract-tests/snapshot-adapter.suite.mjs`
- Create: `docs/adapter-template.md`
- Modify: `tests/opencode-artifact.test.mjs`, `tests/claude-artifact.test.mjs`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: working OpenCode event adapter and Claude snapshot adapter.
- Produces: reusable contract suites and a two-style adapter implementation checklist; no future runtime entrypoint.

- [ ] **Step 1: Extract shared contract suites**

Move common disabled-mode, credential, full-session, and HTTP assertions into the snapshot suite; move parallel project/session, duplicate growth, trailing push, and disposal scenarios into the event suite. Invoke the applicable suite from each existing artifact test without weakening assertions.

- [ ] **Step 2: Document the adapter template**

Document normalized event schemas, project key versus public label, snapshot-style reuse, reserved labels, capabilities required from a host, token provider injection, build provenance, and the mandatory contract suites. Explicitly mark DeepSeekCode and the next OpenCode API as outside this phase.

- [ ] **Step 3: Update OSS installation and compatibility documentation**

Document V1 stable/Harness support, generic options and ENV, full session labels, observed prompt-context semantics, artifact paths, token rotation, and removal of implicit Harness/eharness fallbacks. Mark the next OpenCode API as pending feasibility. Add `check:artifacts` running build followed by `git diff --exit-code -- dist`.

- [ ] **Step 4: Verify self-contained report scripts and complete verification**

Confirm `integrations/common/agent_metrics.py` remains repository-owned, timeline scripts import it locally, and no integration source references `adapters.metrics`, `saas_agent`, or `port_transport`. Run both report entrypoints with isolated Python and `--help`; imports must succeed without an external package.

Run:
```bash
python3 -I integrations/opencode/run_timeline.py --help
python3 -I integrations/claude-code/session_timeline.py --help
npm test
npm run build
npm run check:artifacts
git diff --check
```
Expected: both report commands exit 0, all tests PASS, artifact regeneration produces no diff, and whitespace validation is clean. Report any pre-existing unrelated test/build failure rather than hiding it.
