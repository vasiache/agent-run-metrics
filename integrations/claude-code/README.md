# Claude Code integration

Two parts:

1. `push-metrics.mjs` sends counters to PushGateway while you work.
2. `session_timeline.py` builds a report for a finished session.

How part 1 works: Claude Code saves every session to a transcript file and
calls the script through [hooks](https://code.claude.com/docs/en/hooks) at the
right moments. The script re-reads the transcript and pushes cumulative totals.
It holds no state, so a crash or a missed push never corrupts the numbers.

## Install

```bash
node install.mjs
# or: node install.mjs --push-gateway http://host:9091
# undo: node install.mjs --uninstall
```

The installer copies the hook script to `~/.claude/hooks/agent-metrics/`,
merges the hooks and `AGENT_METRICS_PUSHGATEWAY` into `~/.claude/settings.json`
(idempotent, existing hooks are preserved), checks the pushgateway and runs a
self-test on the most recent transcript. Restart Claude Code (or open
`/hooks`) afterwards.

Manual install (fallback): copy `push-metrics.mjs` to
`~/.claude/hooks/agent-metrics/` and merge
[settings.example.json](settings.example.json) into `~/.claude/settings.json`.

## Script settings (env)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_METRICS_PUSHGATEWAY` | required | PushGateway URL, pushes stop without it |
| `AGENT_METRICS_JOB` | `claude-code` | job label |
| `AGENT_METRICS_RUNTIME` | `claude-code` | runtime label on every series |
| `AGENT_METRICS_INSTANCE` | hostname | instance label |
| `AGENT_METRICS_LABELS` | none | extra labels, `k=v,k2=v2` |
| `AGENT_METRICS_TOKEN` | none | access token, sent in the `Authorization` header |
| `AGENT_METRICS_DEBUG` | none | print push errors to stderr |

Identity and scope labels are filled automatically:

- `user`: from `~/.harness/telemetry.json` (`user_identity`), else the OS
  username; `AGENT_METRICS_LABELS=user=...` overrides.
- `profile`: the harness profile, when one exists.
- `session`: the first 8 chars of the session id, so parallel sessions on one
  host push under separate grouping keys instead of overwriting each other.
- `project`: the basename of the working directory, derived from the transcript
  path (`.../-home-me-projects-myrepo/...` becomes `myrepo`).

| Hook | What happens |
|---|---|
| `PostToolUse` | push, at most once per 15 seconds per session |
| `Stop` | push at the end of every assistant turn (main data path) |
| `SessionEnd` | final push |

## What is counted

Tokens by kind (`input`, `output`, `reasoning`, `cache_read`, `cache_write`),
tool calls by tool name, skill calls (the `Skill` tool) and plugin calls (the
`plugin:skill` prefix; every plugin is counted, including this integration),
the largest context window, session duration. Sub-agent (sidechain) work is
excluded. A retried assistant message is counted once, not twice.

## Offline check

```bash
node push-metrics.mjs --self-test fixtures/sample-transcript.jsonl
```

Prints what would be sent, without any network access.

## Report for a finished session

```bash
python3 session_timeline.py --list
python3 session_timeline.py --session <id> \
    --push-gateway http://localhost:9091 --label user=vasche
```

Writes `run.md` and `run.timeline.csv` next to the current directory and sends
the session summary (tokens, turns, tool calls, edits, duration) to
PushGateway. Access token comes from `--token` or `AGENT_METRICS_TOKEN`.
Skills and plugins used in the session are listed in the report.
