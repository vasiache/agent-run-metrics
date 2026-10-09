# Claude Code integration

This folder adds metrics to Claude Code. Two parts:

1. `push-metrics.mjs` sends counters to PushGateway while you work.
2. `session_timeline.py` builds a report for a finished session.

How part 1 works: Claude Code saves every session to a log file and calls our
script through [hooks](https://code.claude.com/docs/en/hooks) at the right
moments. The script reads the log and sends the totals. It holds no state, so
a crash or a missed push never corrupts the numbers.

## Install

```bash
mkdir -p ~/.claude/hooks/agent-metrics
cp integrations/claude-code/push-metrics.mjs ~/.claude/hooks/agent-metrics/
# then merge the "hooks" block from settings.example.json into
# ~/.claude/settings.json (or <project>/.claude/settings.json),
# keeping the path to push-metrics.mjs correct
```

Settings for the script (shell env):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_METRICS_PUSHGATEWAY` | required | PushGateway URL, pushes stop without it |
| `AGENT_METRICS_JOB` | `claude-code` | job label |
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | none | extra labels, `k=v,k2=v2` |
| `AGENT_METRICS_TOKEN` | none | access token, sent in the `Authorization` header |
| `AGENT_METRICS_DEBUG` | none | print push errors to stderr |

Who is "user": the script takes the name from `~/.harness/telemetry.json`
(field `user_identity`) and falls back to the OS username. A `profile` label
is added from the harness profile when one exists. Setting
`AGENT_METRICS_LABELS=user=...` overrides both.

When the script runs:

| Hook | What happens |
|---|---|
| `PostToolUse` | push, at most once per 15 seconds per session |
| `Stop` | push at the end of every assistant turn (main data path) |
| `SessionEnd` | final push |

## What is counted

Tokens by kind (`input`, `output`, `reasoning`, `cache_read`, `cache_write`),
tool calls by tool name, the largest context window, session duration.
Sub-agent (sidechain) work is excluded. A retried assistant message is counted
once, not twice.

## Offline check

```bash
node push-metrics.mjs --self-test fixtures/sample-transcript.jsonl
```

Prints what would be sent, without any network access.

## Report for a finished session

```bash
python3 integrations/claude-code/session_timeline.py --list
python3 integrations/claude-code/session_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=vasche
```

Writes `run.md` and `run.timeline.csv` next to the current directory and sends
the session summary (tokens, turns, tool calls, duration) to PushGateway.
Access token comes from `--token` or from `AGENT_METRICS_TOKEN`.
