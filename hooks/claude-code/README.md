# Claude Code adapter

Realtime run metrics of Claude Code sessions, pushed to PushGateway.
Works via [hooks](https://code.claude.com/docs/en/hooks): Claude Code hands the
hook a `transcript_path` (JSONL log of the session), the script re-reads it and
pushes cumulative totals — stateless, crash-safe, no double counting.

## Install

```bash
mkdir -p ~/.claude/hooks/agent-metrics
cp hooks/claude-code/push-metrics.mjs ~/.claude/hooks/agent-metrics/
# edit the path inside settings.example.json if you chose another dir, then merge
# the "hooks" block into ~/.claude/settings.json (or <project>/.claude/settings.json)
```

Env (e.g. in your shell profile):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_METRICS_PUSHGATEWAY` | — (required) | PushGateway URL |
| `AGENT_METRICS_JOB` | `claude-code` | job label |
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | — | extra labels, `k=v,k2=v2` |
| `AGENT_METRICS_TOKEN` | — | bearer token, sent as `Authorization` header |
| `AGENT_METRICS_DEBUG` | — | log push failures to stderr |

The `user` label is filled automatically: `~/.harness/telemetry.json` →
`user_identity`, falling back to the OS username. A `profile` label is added
from the active harness profile if one exists. `AGENT_METRICS_LABELS=user=…`
overrides both.

## Hooks

| Event | Behaviour |
|---|---|
| `PostToolUse` | push, throttled to 1/15s per session |
| `Stop` | push at the end of every assistant turn (main data path) |
| `SessionEnd` | final push, throttle state cleaned up |

## Metrics

`claude_code_agent_tokens_total{kind=input|output|reasoning|cache_read|cache_write}`,
`claude_code_agent_tool_calls_total{tool}`, `claude_code_agent_context_max_tokens`,
`claude_code_agent_run_duration_seconds`.

Sidechain (sub-agent) lines are excluded; retried assistant messages are
deduplicated by message id.

## Offline check

```bash
node push-metrics.mjs --self-test fixtures/sample-transcript.jsonl
```

Prints the rendered Prometheus body without touching the network.
