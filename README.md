# agent-run-metrics

Counters for AI coding agents: how many tokens a session burned, which tools
it ran, how long it took. The data lands in your own monitoring (Prometheus
PushGateway, VictoriaMetrics, Grafana) and stays on your infrastructure.

Supported agents: OpenCode and Claude Code. Others are planned.

## Repository layout

```text
├── integrations/            one folder per agent
│   ├── common/              shared report helpers (identity, PushGateway push)
│   ├── opencode/            plugin.js (live counters) + run_timeline.py (report)
│   └── claude-code/         install.mjs + push-metrics.mjs + session_timeline.py
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

Live counters: copy the plugin into the project, or into
`~/.config/opencode/plugin/` to cover all projects:

```bash
mkdir -p <project>/.opencode/plugin
cp integrations/opencode/plugin.js <project>/.opencode/plugin/metrics.js
```

Report for a finished session:

```bash
python3 integrations/opencode/run_timeline.py --list
python3 integrations/opencode/run_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=vasche
```

The report reads the local OpenCode database read-only and writes `run.md`
plus `run.timeline.csv`. It can also answer "how much time passed between the
code edit and the test result" (`--gate-regex`, `--watch`).

## Claude Code

One command: it copies the hook script, adds the hooks and the gateway env to
`~/.claude/settings.json` (idempotent, existing hooks are preserved), checks
the pushgateway and runs a self-test:

```bash
node integrations/claude-code/install.mjs
# or: node integrations/claude-code/install.mjs --push-gateway http://host:9091
# undo: node integrations/claude-code/install.mjs --uninstall
```

Manual install (fallback): copy
[integrations/claude-code/push-metrics.mjs](integrations/claude-code/push-metrics.mjs)
to `~/.claude/hooks/agent-metrics/` and merge
[settings.example.json](integrations/claude-code/settings.example.json) into
`~/.claude/settings.json`. Restart Claude Code (or open `/hooks`) afterwards.

Report for a finished session:

```bash
python3 integrations/claude-code/session_timeline.py --list
python3 integrations/claude-code/session_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=vasche
```

## Settings for the live counters

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_METRICS_PUSHGATEWAY` | required | PushGateway URL |
| `AGENT_METRICS_JOB` | `opencode` / `claude-code` | job label |
| `AGENT_METRICS_RUNTIME` | `opencode` / `claude-code` | runtime label on every series |
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | none | extra labels, `k=v,k2=v2` |
| `AGENT_METRICS_TOKEN` | none | access token (Claude Code part) |

The `user` label is filled on its own: the name is taken from
`~/.harness/telemetry.json`, or from the OS username.

## Metrics reference

Both runtimes emit the same families; `runtime` (`opencode` / `claude-code`)
tells them apart. Live: `agent_tokens_total{runtime,kind}`,
`agent_tool_calls_total{runtime,tool}`, `agent_skill_calls_total{runtime,skill}`,
`agent_plugin_calls_total{runtime,plugin}`, `agent_context_max_tokens{runtime}`,
`agent_run_duration_seconds{runtime}`. Skills and plugins come from Skill tool
calls in the Claude Code transcript (`plugin:skill` names feed the plugin
family); every plugin is counted, including the metrics integration itself.

Parallel sessions are separated, not merged: every live series also carries
`session` (first 8 chars of the session id) and `project` (basename of the
working directory, e.g. `agent-run-metrics`), so two concurrent runs on one
host get their own grouping keys instead of overwriting each other. Session
groups expire from the dashboard's "Active sessions" panel 5 minutes after
their last push. Alerts aggregate over sessions (`sum by (instance, user)`).

Per-session summary (both report scripts): `agent_session_tokens_total`,
`agent_session_turns`, `agent_session_edits_total`,
`agent_session_tool_calls_total`, `agent_session_duration_seconds`, all with a
`runtime` label. `agent_session_cost_total` comes from OpenCode only (its DB
tracks cost); Claude Code transcripts carry no pricing, so cost needs a pricing
table first. The OpenCode analyzer emits `agent_edit_to_gate_seconds{gate}`
when you pass `--gate-regex` and `--watch`.

## License

Apache-2.0
