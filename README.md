# agent-run-metrics

Metrics for coding-agent runs: **tokens, cost, tool calls, retries, time from
edit to gate feedback**. Self-hosted — data never leaves your machine.

Works with OpenCode and Claude Code. Codex CLI and others — planned.

## Components

| Path | What |
|---|---|
| `analyzers/opencode/opencode_run_timeline.py` | Post-run analyzer: reads local OpenCode DB (read-only), builds a timeline of model turns, tool calls and gate feedback |
| `plugin/opencode/metrics.js` | OpenCode plugin: realtime counters pushed to PushGateway |
| `hooks/claude-code/` | Claude Code adapter: realtime counters via hooks + session transcript (see [hooks/claude-code/README.md](hooks/claude-code/README.md)) |
| `dashboards/agent-run-cost.json` | Grafana dashboard |
| `alerts/vmalert.yml` | vmalert rules for run anomalies |

## Analyzer

```bash
python3 analyzers/opencode/opencode_run_timeline.py --list
python3 analyzers/opencode/opencode_run_timeline.py --session <id> \
    --gate-regex 'gate:|verifier' \
    --push-gateway http://pushgateway:9091 \
    --label user=vasche --label task=BLK-15397
```

Parameters:

| Flag | Meaning |
|---|---|
| `--list` | show recent sessions |
| `--session ID` | session to analyze (default: latest) |
| `--gate-regex RE` | text pattern that marks gate feedback in the session |
| `--watch RE` | file path pattern where the defect is expected |
| `--plan P` / `--src P` | path substrings to check "plan written before code" |
| `--push-gateway URL` | push session summary as a batch job |
| `--label k=v` | extra labels for pushed metrics |
| `--db PATH` | OpenCode DB path (default `~/.local/share/opencode/opencode.db`) |
| `--out PREFIX` | output file prefix (default `run`) |

Output: `PREFIX.md` (report) + `PREFIX.timeline.csv` (event timeline).

## Plugin

```bash
mkdir -p <project>/.opencode/plugin
cp plugin/opencode/metrics.js <project>/.opencode/plugin/metrics.js
```

Env:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_METRICS_PUSHGATEWAY` | — (required) | PushGateway URL |
| `AGENT_METRICS_JOB` | `opencode` | job label |
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | — | extra labels, `k=v,k2=v2` |

Pushes `opencode_agent_tokens_total{kind}`, `opencode_agent_tool_calls_total{tool}`,
`opencode_agent_context_max_tokens` after each tool call (throttled 15s) and on
session idle. Errors never break the agent.

## Stack

```text
agent (plugin) ──▶ PushGateway ──vmagent──▶ VictoriaMetrics ──▶ Grafana
```

One-click local stack (Pushgateway + vmagent + VictoriaMetrics + Grafana with the
dashboard provisioned):

```bash
cd deploy && docker compose up -d
# Grafana:      http://localhost:3000  (dashboard "Agent run cost";
#               pick the VictoriaMetrics datasource in the dropdown on first open)
# Push target:  http://localhost:9091  → AGENT_METRICS_PUSHGATEWAY
```

Already have your own Pushgateway/vmagent/VM? Import `dashboards/agent-run-cost.json`
into Grafana and load `alerts/vmalert.yml` into vmalert.

## Metrics

`agent_session_tokens_total`, `agent_session_cost_total`, `agent_session_turns`,
`agent_session_edits_total`, `agent_session_tool_calls_total`,
`agent_session_duration_seconds`, `agent_edit_to_gate_seconds{gate}` (analyzer),
`opencode_agent_tokens_total{kind}`, `opencode_agent_tool_calls_total{tool}`,
`opencode_agent_context_max_tokens` (plugin),
`claude_code_agent_tokens_total{kind}`, `claude_code_agent_tool_calls_total{tool}`,
`claude_code_agent_context_max_tokens`, `claude_code_agent_run_duration_seconds`
(Claude Code adapter).

## License

Apache-2.0
