# agent-run-metrics

Counters for AI coding agents: how many tokens a session burned, which tools
it ran, how long it took. The data lands in your own monitoring (Prometheus
PushGateway, VictoriaMetrics, Grafana) and stays on your infrastructure.

Supported agents: OpenCode (V1 plugin API — 1.18.x and 1.19.x
distributions) and Claude Code. Others are planned; see
[docs/adapter-template.md](docs/adapter-template.md) for the adapter
contract.

## Repository layout

```text
├── integrations/            one folder per agent
│   ├── common/              host-neutral core: config, token, PushGateway,
│   │                        session aggregation, delivery queue, report helper
│   ├── opencode/            plugin.js (V1 adapter, live counters) + run_timeline.py
│   └── claude-code/         install.mjs + push-metrics.mjs + session_timeline.py
├── contract-tests/          adapter contract suites (event / snapshot styles)
├── dist/                    built, self-contained artifacts (npm run build)
├── tests/                   unit + artifact tests
├── dashboards/              Grafana dashboard
├── alerts/vmalert.yml       anomaly rules (token burst, slow feedback)
└── deploy/                  local monitoring stack in docker compose
```

## Quick start

1. Start the monitoring stack:

```bash
cd deploy && docker compose up -d
```

Grafana opens at http://localhost:3000. The "Agent run cost" dashboard is
already loaded against the provisioned VictoriaMetrics datasource. Metrics are
received on port 9091.

2. Connect your agent (next two sections).

## OpenCode

Copy the self-contained plugin into the project, or into
`~/.config/opencode/plugin/` to cover all projects:

```bash
npm run build   # or use the checked-in dist/opencode/v1/plugin.js
mkdir -p <project>/.opencode/plugin
cp dist/opencode/v1/plugin.js <project>/.opencode/plugin/metrics.js
export AGENT_METRICS_PUSHGATEWAY=http://localhost:9091
```

OpenCode V1 also accepts per-plugin options (the `"plugin": [[name, options]]`
tuple in `opencode.json`); explicit options win over environment variables:

```jsonc
{ "plugin": [["./metrics.js", { "endpoint": "http://localhost:9091", "labels": { "user": "alice" } }]] }
```

Report for a finished session:

```bash
python3 integrations/opencode/run_timeline.py --list
python3 integrations/opencode/run_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=alice
```

The report reads the local OpenCode database read-only and writes `run.md`
plus `run.timeline.csv`. It can also answer "how much time passed between the
code edit and the test result" (`--gate-regex`, `--watch`).

## Claude Code

One command: it copies the built hook artifact, adds the hooks and the
gateway env to `~/.claude/settings.json` (idempotent, existing hooks are
preserved), checks the pushgateway and runs a self-test:

```bash
npm run build   # refresh dist/claude-code/push-metrics.mjs first
node integrations/claude-code/install.mjs
# or: node integrations/claude-code/install.mjs --push-gateway http://host:9091
# undo: node integrations/claude-code/install.mjs --uninstall
```

Manual install (fallback): copy
[dist/claude-code/push-metrics.mjs](dist/claude-code/push-metrics.mjs)
to `~/.claude/hooks/agent-metrics/` and merge
[settings.example.json](integrations/claude-code/settings.example.json) into
`~/.claude/settings.json`. Restart Claude Code (or open `/hooks`) afterwards.

Report for a finished session:

```bash
python3 integrations/claude-code/session_timeline.py --list
python3 integrations/claude-code/session_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=alice
```

## Configuration (live counters)

Explicit plugin options win over environment variables.

| Option / Variable | Default | Meaning |
|---|---|---|
| `endpoint` / `AGENT_METRICS_PUSHGATEWAY` | required | PushGateway URL, used verbatim (tenant or path routing is part of the URL the caller passes), e.g. `https://gateway.example/push`. Without it the integration stays idle and performs no I/O |
| `job` / `AGENT_METRICS_JOB` | `opencode` / `claude-code` | job label |
| `runtime` / `AGENT_METRICS_RUNTIME` | runtime default | runtime label on every series |
| `instance` / `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `labels` / `AGENT_METRICS_LABELS` | none | extra labels, `k=v,k2=v2`; the names `runtime`, `session`, `project`, `instance`, `job`, `kind`, `tool`, `skill`, `plugin`, `agent` are reserved |
| `token` / `AGENT_METRICS_TOKEN` | none | bearer token |
| `tokenFile` / `AGENT_METRICS_TOKEN_FILE` | none | raw token file, trimmed, reread per push (rotation applies on the next delivery); a missing, empty, or unreadable explicitly configured file fails that push |
| `debug` / `AGENT_METRICS_DEBUG` | off | concise failure logging to stderr; never logs credentials |

The `user` label defaults to the OS username. Previous implicit
deployment-specific identity and grant-discovery fallbacks (vendor
telemetry and token files) were removed from the generic integrations;
configure them via labels or a token file instead.

## Metrics reference

Both runtimes emit the same families; `runtime` (`opencode` / `claude-code`)
tells them apart. Live: `agent_tokens_total{runtime,kind}`,
`agent_tool_calls_total{runtime,tool}`, `agent_skill_calls_total{runtime,skill}`,
`agent_plugin_calls_total{runtime,plugin}`, `agent_context_max_tokens{runtime}`,
`agent_run_duration_seconds{runtime}`. Skills and plugins come from Skill tool
calls in the Claude Code transcript (`plugin:skill` names feed the plugin
family); every plugin is counted, including the metrics integration itself.

Edit and permission families appear when the host provides the data (graceful
degradation): `agent_file_edits_total{runtime,kind}` counts approximate added
and deleted lines (OpenCode: unified diff from edit tool metadata; Claude Code:
LCS delta of `old_string`/`new_string` from the transcript); `agent_permission_decisions_total{runtime,decision}`
counts permission outcomes (`allow` / `deny`) — a permission decision is not
"accepted code" (OpenCode only: Claude Code hooks expose no deny signal, so it
emits no permission family); `agent_tool_duration_seconds_total{runtime,tool}`
sums wall-clock tool execution time (OpenCode pairs `tool.execute.before`/`after`
by call id; Claude Code pairs transcript `tool_use`/`tool_result` timestamps).

`agent_context_max_tokens` is the maximum observed prompt usage per session
(`input + cache_read + cache_write`), not the model's context-window
capacity. OpenCode derives it from usage deltas; Claude Code from transcript
snapshots.

Subagent runs (Claude Code) are counted separately, per agent type
(`Explore`, `Plan`, ...): `agent_subagent_spawns_total{agent}`,
`agent_subagent_tokens_total{agent,kind}`,
`agent_subagent_tool_calls_total{agent,tool}`,
`agent_subagent_context_max_tokens{agent}`,
`agent_subagent_duration_seconds{agent}`. The hook reads them from
`<session>/subagents/` transcript files next to the main transcript; runs of
the same agent type merge into one series. The main-session series do not
include subagent work, so a session's full spend is main + subagent series.

Parallel sessions are separated, not merged: every live series carries
`session` (the **full** session id) and `project` (basename of the working
directory), so two concurrent runs on one host get their own grouping keys
instead of overwriting each other. Delivery is serialized per session: one
active request, one trailing request with the newest totals, a 15-second
throttle, and an idle flush that never stacks a second concurrent request.
Subagent series carry the parent session's `session` label. Session groups
expire from the dashboard's "Active sessions" panel 5 minutes after their
last push. Alerts aggregate over sessions (`sum by (instance, user)`).

Per-session summary (both report scripts): `agent_session_tokens_total`,
`agent_session_turns`, `agent_session_edits_total`,
`agent_session_tool_calls_total`, `agent_session_duration_seconds`, all with a
`runtime` label. `agent_session_cost_total` comes from OpenCode only (its DB
tracks cost); Claude Code transcripts carry no pricing, so cost needs a pricing
table first. The OpenCode analyzer emits `agent_edit_to_gate_seconds{gate}`
when you pass `--gate-regex` and `--watch`.

## Compatibility

- OpenCode V1 plugin API (`MetricsPlugin(input, options)`) — supported:
  1.18.x and 1.19.x distributions. The next-generation
  OpenCode plugin API is **pending feasibility**: its current dev
  documentation does not expose the usage snapshots and completed-tool
  events this project needs.
- DeepSeekCode, KiloCode, QwenCode — not started; the adapter contract and
  contract suites are in [docs/adapter-template.md](docs/adapter-template.md).
- Artifacts are built with esbuild (`npm run build`); `npm run
  check:artifacts` verifies regeneration produces no diff.

## License

Apache-2.0
