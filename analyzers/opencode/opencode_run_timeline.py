#!/usr/bin/env python3
"""
opencode-run-timeline: разбор одного прогона OpenCode по локальной базе.

Читает ~/.local/share/opencode/opencode.db только на чтение, ничего никуда не отправляет.
Строит таймлайн: ходы модели (токены, стоимость), вызовы инструментов (правки/чтения/bash),
события гейтов (сообщения, совпавшие с --gate-regex), и считает:
  - сколько токенов и времени прошло от правки файла до замечания гейта;
  - сколько токенов ушло между разворотами гейтов;
  - появился ли план раньше первой правки исходников (--plan / --src).

Пример:
  python3 opencode_run_timeline.py --list
  python3 opencode_run_timeline.py --session <id> --push-gateway http://pushgateway:9091 \\
      --label user=vasche --label task=BLK-15397   # итог сессии -> PushGateway (batch-job)
  python3 opencode_run_timeline.py --session <id> \
      --gate-regex 'gate:|test\\.logs_failed' \
      --watch 'Logging|logback' \
      --plan docs/ai/BLK-15397/plan.md --src smev-fns-service/ \
      --out report
"""
import argparse, csv, json, os, re, sqlite3, sys
from datetime import datetime

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
EDIT_TOOLS = {"edit", "write", "patch", "multiedit", "apply_patch"}


def ts(ms):
    """epoch ms -> HH:MM:SS"""
    if ms is None:
        return ""
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S")


def j(s):
    try:
        return json.loads(s) if isinstance(s, str) else (s or {})
    except Exception:
        return {}


def tok(t):
    """tokens dict -> total"""
    if not isinstance(t, dict):
        return 0
    if isinstance(t.get("total"), (int, float)):
        return int(t["total"])
    c = t.get("cache") or {}
    return int((t.get("input") or 0) + (t.get("output") or 0) + (t.get("reasoning") or 0)
               + (c.get("read") or 0) + (c.get("write") or 0))


def connect(path):
    if not os.path.exists(path):
        sys.exit(f"нет базы: {path}")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def list_sessions(db):
    rows = db.execute("SELECT id, title, time_created, time_updated FROM session "
                      "ORDER BY time_updated DESC LIMIT 20").fetchall()
    for r in rows:
        print(f"{r[0]}  {datetime.fromtimestamp(r[2]/1000):%Y-%m-%d %H:%M}  {r[1]}")


def file_of(inp):
    """filePath/path/file из input инструмента"""
    if not isinstance(inp, dict):
        return ""
    return inp.get("filePath") or inp.get("path") or inp.get("file") or ""


def load_events(db, sid, gate_re):
    """События сессии: ходы модели, вызовы инструментов, замечания гейтов."""
    ev = []
    for mid, mtime, data in db.execute(
            "SELECT id, time_created, data FROM message WHERE session_id=? ORDER BY time_created, id", (sid,)):
        m = j(data)
        role = m.get("role")
        t = (m.get("time") or {}).get("created") or mtime
        if role == "assistant":
            ev.append({"t": t, "kind": "llm", "tokens": tok(m.get("tokens")), "cost": m.get("cost") or 0,
                       "detail": m.get("modelID", ""), "mid": mid})
    for mid, ptime, data in db.execute(
            "SELECT p.message_id, p.time_created, p.data FROM part p WHERE p.session_id=? "
            "ORDER BY p.time_created, p.id", (sid,)):
        p = j(data)
        typ = p.get("type")
        if typ == "tool":
            st = p.get("state") or {}
            t = (st.get("time") or {}).get("start") or ptime
            name = p.get("tool", "")
            ev.append({"t": t, "kind": "edit" if name in EDIT_TOOLS else "tool", "tokens": 0, "cost": 0,
                       "detail": f"{name} {file_of(st.get('input'))}".strip(),
                       "file": file_of(st.get("input")), "status": st.get("status", ""), "mid": mid})
        elif typ == "text":
            txt = p.get("text") or ""
            if gate_re and gate_re.search(txt):
                first = gate_re.search(txt)
                snippet = txt[max(0, first.start() - 20): first.end() + 60].replace("\n", " ")
                ev.append({"t": ptime, "kind": "gate", "tokens": 0, "cost": 0, "detail": snippet, "mid": mid})
    ev.sort(key=lambda e: (e["t"] or 0))
    cum = 0
    for e in ev:
        cum += e["tokens"]
        e["cum"] = cum
    return ev


def analyze(ev, watch_re, plan, src):
    """Сводка прогона + гейты с привязкой к подозрительной правке."""
    out = {}
    llm = [e for e in ev if e["kind"] == "llm"]
    out["total_tokens"] = sum(e["tokens"] for e in llm)
    out["total_cost"] = round(sum(e["cost"] for e in llm), 4)
    out["turns"] = len(llm)
    out["edits"] = sum(1 for e in ev if e["kind"] == "edit")
    out["tool_calls"] = sum(1 for e in ev if e["kind"] in ("tool", "edit"))
    if ev:
        out["duration_min"] = round(((ev[-1]["t"] or 0) - (ev[0]["t"] or 0)) / 60000, 1)

    gates, prev = [], None
    for i, e in enumerate(ev):
        if e["kind"] != "gate":
            continue
        g = {"time": ts(e["t"]), "detail": e["detail"], "cum_tokens": e["cum"],
             "tokens_since_prev_gate": e["cum"] - (prev["cum"] if prev else 0)}
        if watch_re:
            src_edit = next((x for x in reversed(ev[:i]) if x["kind"] == "edit" and watch_re.search(x.get("file", ""))), None)
            if src_edit:
                g["suspect_edit"] = f'{ts(src_edit["t"])} {src_edit["detail"]}'
                g["min_edit_to_gate"] = round((e["t"] - src_edit["t"]) / 60000, 1)
                g["tokens_edit_to_gate"] = e["cum"] - src_edit["cum"]
        gates.append(g)
        prev = e
    out["gates"] = gates

    if plan or src:
        pw = next((e for e in ev if e["kind"] == "edit" and plan and plan in e.get("file", "")), None)
        se = next((e for e in ev if e["kind"] == "edit" and src and src in e.get("file", "")), None)
        out["plan_first_write"] = ts(pw["t"]) if pw else "не найдено"
        out["src_first_edit"] = ts(se["t"]) if se else "не найдено"
        out["plan_before_code"] = bool(pw and (not se or pw["t"] <= se["t"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--list", action="store_true", help="последние сессии")
    ap.add_argument("--session", help="id сессии (по умолчанию последняя)")
    ap.add_argument("--gate-regex", default=r"gate:|verifier|гейт", help="признак замечания гейта в тексте")
    ap.add_argument("--watch", help="regex путей файлов, где ожидается дефект")
    ap.add_argument("--plan", help="путь (подстрока) файла плана")
    ap.add_argument("--src", help="путь (подстрока) исходников")
    ap.add_argument("--out", default="run", help="префикс выходных файлов")
    ap.add_argument("--push-gateway", help="PushGateway URL (http://host:9091) — пуш итога сессии как batch-job")
    ap.add_argument("--label", action="append", default=[],
                    help="метка для PushGateway: key=value (user=vasche, task=BLK-15397, profile=test)")
    a = ap.parse_args()

    def push_summary(res, sid):
        """Итог сессии как batch-job в PushGateway (разовая задача завершилась —
        финальный пуш). Без внешних зависимостей: сырой POST text-format."""
        import urllib.request
        extra = "".join(f',{k.split("=",1)[0]}="{k.split("=",1)[1]}"' for k in a.label if "=" in k)
        base = f'session="{sid}"{extra}'
        lines = [
            "# TYPE agent_session_tokens_total gauge",
            f"agent_session_tokens_total{{{base}}} {res.get('total_tokens', 0)}",
            "# TYPE agent_session_cost_total gauge",
            f"agent_session_cost_total{{{base}}} {res.get('total_cost', 0)}",
            "# TYPE agent_session_turns gauge",
            f"agent_session_turns{{{base}}} {res.get('turns', 0)}",
            "# TYPE agent_session_edits_total gauge",
            f"agent_session_edits_total{{{base}}} {res.get('edits', 0)}",
            "# TYPE agent_session_tool_calls_total gauge",
            f"agent_session_tool_calls_total{{{base}}} {res.get('tool_calls', 0)}",
            "# TYPE agent_session_duration_seconds gauge",
            f"agent_session_duration_seconds{{{base}}} {int(res.get('duration_min', 0) * 60)}",
        ]
        for g in res.get("gates", []):
            if "min_edit_to_gate" in g:
                lines.append(f'agent_edit_to_gate_seconds{{session="{sid}",gate="{g["time"]}"}} '
                             f'{int(g["min_edit_to_gate"] * 60)}')
        body = ("\n".join(lines) + "\n").encode()
        url = f"{a.push_gateway.rstrip('/')}/metrics/job/opencode_agent/session/{sid}"
        urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "text/plain"}), timeout=30).read()
        print(f"pushed -> {url}")

    db = connect(a.db)
    if a.list:
        return list_sessions(db)
    sid = a.session or db.execute("SELECT id FROM session ORDER BY time_updated DESC LIMIT 1").fetchone()[0]
    title = (db.execute("SELECT title FROM session WHERE id=?", (sid,)).fetchone() or [""])[0]
    todos = db.execute("SELECT position, status, content FROM todo WHERE session_id=? ORDER BY position",
                       (sid,)).fetchall()

    ev = load_events(db, sid, re.compile(a.gate_regex, re.I) if a.gate_regex else None)
    res = analyze(ev, re.compile(a.watch, re.I) if a.watch else None, a.plan, a.src)

    if a.push_gateway:
        push_summary(res, sid)

    with open(f"{a.out}.timeline.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "kind", "tokens", "cum_tokens", "cost", "detail"])
        for e in ev:
            w.writerow([ts(e["t"]), e["kind"], e["tokens"], e["cum"], e["cost"], e["detail"]])

    L = [f"# Прогон: {title}", f"session: `{sid}`", "",
         "| Метрика | Значение |", "|---|---|"]
    for k in ("total_tokens", "total_cost", "turns", "tool_calls", "edits", "duration_min"):
        L.append(f"| {k} | {res.get(k, '')} |")
    if "plan_before_code" in res:
        L += ["", "## План до кода", f"- план записан: {res['plan_first_write']}",
              f"- первая правка исходников: {res['src_first_edit']}",
              f"- план раньше кода: **{'да' if res['plan_before_code'] else 'нет'}**"]
    L += ["", "## Замечания гейтов", "| время | токенов с прошлого гейта | подозрительная правка | мин от правки | токенов от правки | текст |",
          "|---|---|---|---|---|---|"]
    for g in res["gates"]:
        L.append(f"| {g['time']} | {g['tokens_since_prev_gate']} | {g.get('suspect_edit','')} | "
                 f"{g.get('min_edit_to_gate','')} | {g.get('tokens_edit_to_gate','')} | {g['detail'][:80]} |")
    if todos:
        L += ["", "## Todo", *[f"- [{s}] {c}" for _, s, c in todos]]
    open(f"{a.out}.md", "w").write("\n".join(L) + "\n")
    print("\n".join(L))
    print(f"\nфайлы: {a.out}.md, {a.out}.timeline.csv")


if __name__ == "__main__":
    main()
