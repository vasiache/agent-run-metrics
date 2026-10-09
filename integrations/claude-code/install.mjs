#!/usr/bin/env node
// install.mjs: one-command setup of the Claude Code metrics hook.
//
//   node install.mjs                          # install with default gateway http://localhost:9091
//   node install.mjs --push-gateway http://host:9091
//   node install.mjs --uninstall
//
// Idempotent: existing hooks/env in ~/.claude/settings.json are preserved,
// re-running never duplicates. After install, restart Claude Code (or open
// /hooks) so the session picks the hooks up.
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = path.join(os.homedir(), ".claude", "hooks", "agent-metrics");
const HOOK_SCRIPT = path.join(HOOK_DIR, "push-metrics.mjs");
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_CMD = `node ${HOOK_SCRIPT}`;
const HOOK_EVENTS = ["PostToolUse", "Stop", "SessionEnd"];

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const gwIdx = args.indexOf("--push-gateway");
const gateway = gwIdx !== -1 ? args[gwIdx + 1] : "http://localhost:9091";
if (args.includes("--help") || args.includes("-h") || (gwIdx !== -1 && !gateway)) {
  console.log("usage: node install.mjs [--push-gateway URL] [--uninstall]");
  process.exit(0);
}

function die(msg) {
  console.error(`install: ${msg}`);
  process.exit(1);
}

function hookEntries() {
  // same shape as settings.example.json, plus async so the agent never waits
  const entry = { type: "command", command: HOOK_CMD, async: true, timeout: 30 };
  return {
    PostToolUse: [{ matcher: "*", hooks: [entry] }],
    Stop: [{ hooks: [entry] }],
    SessionEnd: [{ hooks: [entry] }],
  };
}

async function readSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    die(`${SETTINGS} is not valid JSON (${e.message}); fix or remove it first`);
  }
}

async function writeSettings(s) {
  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}

function eventHooks(s, ev) {
  const arr = (s.hooks = s.hooks || {})[ev] || (s.hooks[ev] = []);
  return arr.flatMap((m) => m.hooks || []);
}

function hasHook(s) {
  return HOOK_EVENTS.some((ev) => eventHooks(s, ev).some((h) => h.command === HOOK_CMD));
}

async function checkGateway() {
  try {
    const res = await fetch(`${gateway.replace(/\/+$/, "")}/-/healthy`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return true;
  } catch { /* unreachable */ }
  return false;
}

async function latestTranscript() {
  const projects = path.join(os.homedir(), ".claude", "projects");
  let best = null, bestM = 0;
  let dirs;
  try { dirs = await stat(projects); } catch { return null; }
  if (!dirs.isDirectory()) return null;
  for (const d of await readdir(projects)) {
    let files;
    try { files = await readdir(path.join(projects, d)); } catch { continue; }
    for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
      const p = path.join(projects, d, f);
      const m = (await stat(p)).mtimeMs;
      if (m > bestM) { bestM = m; best = p; }
    }
  }
  return best;
}

if (uninstall) {
  const s = await readSettings();
  for (const ev of HOOK_EVENTS) {
    if (!s.hooks?.[ev]) continue;
    s.hooks[ev] = s.hooks[ev]
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => h.command !== HOOK_CMD) }))
      .filter((m) => (m.hooks || []).length > 0);
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  if (s.env?.AGENT_METRICS_PUSHGATEWAY === gateway) delete s.env.AGENT_METRICS_PUSHGATEWAY;
  await writeSettings(s);
  await rm(HOOK_DIR, { recursive: true, force: true });
  console.log("uninstalled: hooks, env and hook script removed. Restart Claude Code to apply.");
  process.exit(0);
}

// 1. environment
if (Number(process.versions.node.split(".")[0]) < 18) die(`node >= 18 required, found ${process.versions.node}`);

// 2. copy the hook script
await mkdir(HOOK_DIR, { recursive: true });
await copyFile(path.join(HERE, "push-metrics.mjs"), HOOK_SCRIPT);

// 3. merge settings.json
const s = await readSettings();
let changed = false;
if (!hasHook(s)) {
  for (const [ev, blocks] of Object.entries(hookEntries())) s.hooks[ev] = [...(s.hooks[ev] || []), ...blocks];
  changed = true;
}
if (s.env?.AGENT_METRICS_PUSHGATEWAY !== gateway) {
  s.env = { ...(s.env || {}), AGENT_METRICS_PUSHGATEWAY: gateway };
  changed = true;
}
await writeSettings(s);

// 4. sanity checks
const gwOk = await checkGateway();
const t = await latestTranscript();
let selfTestOk = false;
if (t) {
  try {
    const out = await execFileP(process.execPath, [HOOK_SCRIPT, "--self-test", t], { timeout: 15000 });
    selfTestOk = out.stdout.includes("agent_tokens_total");
  } catch { /* reported below */ }
}

console.log(`hook script : ${HOOK_SCRIPT}`);
console.log(`settings    : ${SETTINGS}${changed ? " (updated)" : " (hooks already present, kept as-is)"}`);
console.log(`pushgateway : ${gateway}: ${gwOk ? "reachable" : "NOT reachable (start deploy/docker-compose.yml?)"}`);
if (t) console.log(`self-test   : ${selfTestOk ? "ok, transcript parsed" : "FAILED, run: node " + HOOK_SCRIPT + " --self-test " + t}`);
else console.log("self-test   : skipped (no transcripts under ~/.claude/projects)");
console.log(`
next: restart Claude Code (or open /hooks) so the session loads the hooks.
verify after a couple of tool calls:
  curl -s ${gateway}/api/v1/metrics | grep agent_tokens_total
  curl -s '${gateway === "http://localhost:9091" ? "http://localhost:8428" : "<victoria-metrics>"}/api/v1/query?query=agent_tokens_total'`);
