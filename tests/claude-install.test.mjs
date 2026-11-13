import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const INSTALL = path.resolve("integrations/claude-code/install.mjs");
const ARTIFACT = path.resolve("dist/claude-code/push-metrics.mjs");

function runInstall(home, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INSTALL, ...extraArgs], {
      env: { ...process.env, HOME: home, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const settingsPath = (home) => path.join(home, ".claude", "settings.json");

async function hookCommands(home) {
  const settings = JSON.parse(await readFile(settingsPath(home), "utf8"));
  const commands = [];
  for (const blocks of Object.values(settings.hooks || {})) {
    for (const block of blocks) for (const hook of block.hooks || []) commands.push(hook.command);
  }
  return commands;
}

test("claude installer copies the built artifact and stays idempotent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "arm-install-"));
  try {
    const first = await runInstall(home);
    assert.equal(first.code, 0, first.stderr);

    const hookScript = path.join(home, ".claude", "hooks", "agent-metrics", "push-metrics.mjs");
    assert.equal(await readFile(hookScript, "utf8"), await readFile(ARTIFACT, "utf8"),
      "installer must ship the built artifact byte-for-byte");

    const afterFirst = await hookCommands(home);
    assert.equal(afterFirst.length, 3); // PostToolUse, Stop, SessionEnd

    const second = await runInstall(home);
    assert.equal(second.code, 0, second.stderr);
    const afterSecond = await hookCommands(home);
    assert.deepEqual(afterSecond, afterFirst); // no duplicates on re-run

    const settings = JSON.parse(await readFile(settingsPath(home), "utf8"));
    assert.equal(settings.env.AGENT_METRICS_PUSHGATEWAY, "http://localhost:9091");

    const uninstall = await runInstall(home, ["--uninstall"]);
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.deepEqual(await hookCommands(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude installer health check uses bounded native fetch and never blocks install", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "arm-install-health-"));
  try {
    // gateway unreachable on this port; install must still succeed
    const result = await runInstall(home, ["--push-gateway", "http://127.0.0.1:1"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /NOT reachable/);
    const source = await readFile(INSTALL, "utf8");
    assert.equal(source.includes("port_transport"), false);
    assert.match(source, /AbortSignal\.timeout/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude installer refuses to ship without the built artifact", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "arm-install-nodist-"));
  try {
    // point the artifact path at a file that does not exist; the shared dist/
    // tree is never touched (parallel test processes read it)
    const result = await runInstall(home, [], {
      AGENT_METRICS_HOOK_SOURCE: path.join(home, "does-not-exist.mjs"),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /npm run build/);
    const hookScript = path.join(home, ".claude", "hooks", "agent-metrics", "push-metrics.mjs");
    await assert.rejects(readFile(hookScript, "utf8"), /ENOENT/); // no broken hook shipped
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
