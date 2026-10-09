#!/usr/bin/env python3
"""Timeline of one Claude Code session from the local transcript (read-only).

Companion to run_timeline.py (OpenCode): same CLI surface and the same
agent_session_* push metrics, but the source is Claude Code's transcript
JSONL (~/.claude/projects/<cwd>/<session>.jsonl) instead of a SQLite DB.
"""
import argparse, csv, json, os, socket, sys
from datetime import datetime

DEFAULT_PROJECTS = os.path.expanduser("~/.claude/projects")


def ts(ms):
    if ms is None:
        return ""
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S")


def list_sessions(project_dir):
    rows = []
    for root, _, files in os.walk(project_dir):
        for f in files:
            if not f.endswith(".jsonl"):
                continue
            p = os.path.join(root, f)
            rows.append((os.path.getmtime(p), p))
    rows.sort(reverse=True)
    for mtime, p in rows[:20]:
        sid = os.path.basename(p)[:-6]
        print(f"{sid}  {datetime.fromtimestamp(mtime):%Y-%m-%d %H:%M}  {os.path.dirname(p)}")


def load_events(path):
    """Assistant turns and tool calls from a transcript. Skips sidechain
    lines, malformed lines and retried assistant messages (dedup by id)."""
    ev, seen = [], set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") != "assistant" or e.get("isSidechain"):
                continue
            msg = e.get("message") or {}
            mid = msg.get("id")
            if mid and mid in seen:
                continue
            if mid:
                seen.add(mid)
            u = msg.get("usage") or {}
            t = int((u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
                    + (u.get("cache_read_input_tokens") or 0)
                    + (u.get("cache_creation_input_tokens") or 0)
                    + ((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0))
            ts_ms = int(datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp() * 1000) \
                if e.get("timestamp") else None
            ev.append({"t": ts_ms, "kind": "turn", "tokens": t,
                       "detail": f"{msg.get('model', '')} ({t} tok)"})
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name"):
                    ev.append({"t": ts_ms, "kind": "tool", "tokens": 0, "detail": b["name"]})
    ev.sort(key=lambda e: (e["t"] or 0))
    cum = 0
    for e in ev:
        cum += e["tokens"]
        e["cum"] = cum
    return ev


def summarize(ev):
    turns = [e for e in ev if e["kind"] == "turn"]
    tools = [e for e in ev if e["kind"] == "tool"]
    res = {"total_tokens": sum(e["tokens"] for e in turns),
           "turns": len(turns), "tool_calls": len(tools)}
    if ev:
        res["duration_min"] = round(((ev[-1]["t"] or 0) - (ev[0]["t"] or 0)) / 60000, 1)
    return res


def esc(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def push_summary(res, sid, a):
    """Same agent_session_* families as the OpenCode analyzer."""
    import urllib.request
    extra = f',tenant="{esc(a.tenant)}"' + "".join(
        f',{esc(k.split("=", 1)[0])}="{esc(k.split("=", 1)[1])}"' for k in a.label if "=" in k)
    base = f'session="{esc(sid)}"{extra}'
    lines = [
        "# TYPE agent_session_tokens_total gauge",
        f"agent_session_tokens_total{{{base}}} {res.get('total_tokens', 0)}",
        "# TYPE agent_session_turns gauge",
        f"agent_session_turns{{{base}}} {res.get('turns', 0)}",
        "# TYPE agent_session_tool_calls_total gauge",
        f"agent_session_tool_calls_total{{{base}}} {res.get('tool_calls', 0)}",
    ]
    if "duration_min" in res:
        lines += ["# TYPE agent_session_duration_seconds gauge",
                  f"agent_session_duration_seconds{{{base}}} {int(res['duration_min'] * 60)}"]
    url = (f"{a.push_gateway.rstrip('/')}/metrics/job/claude_code_agent"
           f"/instance/{socket.gethostname()}/session/{esc(sid)}")
    headers = {"Content-Type": "text/plain"}
    token = a.token or os.environ.get("AGENT_METRICS_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=("\n".join(lines) + "\n").encode(),
                                 headers=headers, method="POST")
    try:
        urllib.request.urlopen(req, timeout=30).read()
        print(f"pushed -> {url}")
    except OSError as e:
        # keep the report files even when the push endpoint is unreachable
        print(f"WARNING: push failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects", default=DEFAULT_PROJECTS, help="~/.claude/projects dir")
    ap.add_argument("--list", action="store_true", help="list recent sessions")
    ap.add_argument("--session", help="session id (default: most recently modified)")
    ap.add_argument("--out", default="run", help="output file prefix")
    ap.add_argument("--push-gateway", help="PushGateway URL — push session summary")
    ap.add_argument("--token", help="bearer token (or AGENT_METRICS_TOKEN env)")
    ap.add_argument("--label", action="append", default=[],
                    help="PushGateway label: key=value")
    ap.add_argument("--tenant", default="local", help="tenant label")
    a = ap.parse_args()

    if a.list:
        return list_sessions(a.projects)

    if a.session:
        matches = []
        for root, _, files in os.walk(a.projects):
            for f in files:
                if f[:-6] == a.session or f == a.session:
                    matches.append(os.path.join(root, f))
        if not matches:
            sys.exit(f"session not found: {a.session}")
        path = matches[0]
    else:
        best = max((os.path.join(root, f) for root, _, fs in os.walk(a.projects)
                    for f in fs if f.endswith(".jsonl")),
                   key=os.path.getmtime, default=None)
        if not best:
            sys.exit(f"no transcripts under {a.projects}")
        path = best
    sid = os.path.basename(path)[:-6]

    ev = load_events(path)
    res = summarize(ev)

    if a.push_gateway:
        push_summary(res, sid, a)

    with open(f"{a.out}.timeline.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "kind", "tokens", "cum_tokens", "detail"])
        for e in ev:
            w.writerow([ts(e["t"]), e["kind"], e["tokens"], e["cum"], e["detail"]])

    by_tool = {}
    for e in ev:
        if e["kind"] == "tool":
            by_tool[e["detail"]] = by_tool.get(e["detail"], 0) + 1

    L = [f"# Session: `{sid}`", f"transcript: `{path}`", "",
         "| Metric | Value |", "|---|---|"]
    for k in ("total_tokens", "turns", "tool_calls", "duration_min"):
        L.append(f"| {k} | {res.get(k, '')} |")
    if by_tool:
        L += ["", "## Tools", *[f"- {t}: {n}" for t, n in sorted(by_tool.items(), key=lambda x: -x[1])]]
    open(f"{a.out}.md", "w").write("\n".join(L) + "\n")
    print("\n".join(L))
    print(f"\nfiles: {a.out}.md, {a.out}.timeline.csv")


if __name__ == "__main__":
    main()
