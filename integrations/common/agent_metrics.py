"""Shared helpers for the report scripts: label escaping, user identity,
PushGateway push of the agent_session_* summary. No third-party deps."""
import getpass
import json
import os
import socket
import urllib.request

FAMILIES = [  # summary key -> metric family (gauge), emitted only when the key exists
    ("total_tokens", "agent_session_tokens_total"),
    ("total_cost", "agent_session_cost_total"),
    ("turns", "agent_session_turns"),
    ("edits", "agent_session_edits_total"),
    ("tool_calls", "agent_session_tool_calls_total"),
]


def esc(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def harness_identity():
    """user from ~/.harness/telemetry.json, or None."""
    try:
        with open(os.path.expanduser("~/.harness/telemetry.json")) as f:
            t = json.load(f)
        return str(t["user_identity"])
    except Exception:
        return None


def push_summary(res, sid, push_gateway, label=(), runtime="unknown", token=None,
                 gates=()):
    """POST the session summary to PushGateway. Print the URL, raise on failure."""
    labels = {k.split("=", 1)[0]: k.split("=", 1)[1] for k in label if "=" in k}
    labels.setdefault("runtime", runtime)
    labels.setdefault("user", harness_identity() or getpass.getuser())
    base = f'session="{esc(sid)}"' + "".join(f',{esc(k)}="{esc(v)}"' for k, v in labels.items())
    lines = []
    for key, family in FAMILIES:
        if key in res:
            lines += [f"# TYPE {family} gauge", f"{family}{{{base}}} {res[key]}"]
    if "duration_min" in res:
        lines += ["# TYPE agent_session_duration_seconds gauge",
                  f"agent_session_duration_seconds{{{base}}} {int(res['duration_min'] * 60)}"]
    for g in gates:
        if "min_edit_to_gate" in g:
            lines.append(f'agent_edit_to_gate_seconds{{session="{esc(sid)}",gate="{esc(g["time"])}"}} '
                         f'{int(g["min_edit_to_gate"] * 60)}')
    url = (f"{push_gateway.rstrip('/')}/metrics/job/agent"
           f"/instance/{socket.gethostname()}/session/{esc(sid)}")
    headers = {"Content-Type": "text/plain"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=("\n".join(lines) + "\n").encode(),
                                 headers=headers, method="POST")
    urllib.request.urlopen(req, timeout=30).read()
    print(f"pushed -> {url}")
