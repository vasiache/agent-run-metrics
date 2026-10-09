# agent-run-metrics

Counters for AI coding agents: how many tokens a session burned, which tools
it ran, how long it took. The data lands in your own monitoring (Prometheus
PushGateway, VictoriaMetrics, Grafana) and stays on your infrastructure.

Supported agents: OpenCode and Claude Code. Others are planned.

## Repository layout

```text
├── integrations/            one folder per agent
│   ├── opencode/            plugin.js (live counters) + run_timeline.py (report)
│   └── claude-code/         push-metrics.mjs (live counters) + session_timeline.py (report)
├── dashboards/              Grafana dashboard
├── alerts/vmalert.yml       anomaly rules (token burst, slow feedback, runs without user)
└── deploy/                  local monitoring stack in docker compose
```

## Quick start

1. Start the monitoring stack:

```bash
cd deploy && docker compose up -d
```

Grafana opens at http://localhost:3000. The "Agent run cost" dashboard is
already loaded; on first open pick "VictoriaMetrics" in the datasource
dropdown. Metrics are received on port 9091.

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

Live counters: install the hook script and add hooks to settings, following
[integrations/claude-code/README.md](integrations/claude-code/README.md):

```bash
mkdir -p ~/.claude/hooks/agent-metrics
cp integrations/claude-code/push-metrics.mjs ~/.claude/hooks/agent-metrics/
```

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
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | none | extra labels, `k=v,k2=v2` |
| `AGENT_METRICS_TOKEN` | none | access token (Claude Code part) |

The `user` label is filled on its own: the name is taken from
`~/.harness/telemetry.json`, or from the OS username.

## Metrics reference

Live: `opencode_agent_tokens_total{kind}`, `opencode_agent_tool_calls_total{tool}`,
`opencode_agent_context_max_tokens`; `claude_code_agent_tokens_total{kind}`,
`claude_code_agent_tool_calls_total{tool}`, `claude_code_agent_context_max_tokens`,
`claude_code_agent_run_duration_seconds`.

Per-session summary (both report scripts): `agent_session_tokens_total`,
`agent_session_cost_total`, `agent_session_turns`, `agent_session_edits_total`,
`agent_session_tool_calls_total`, `agent_session_duration_seconds`,
`agent_edit_to_gate_seconds{gate}`.

## License

Apache-2.0
