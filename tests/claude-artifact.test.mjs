import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { runSnapshotAdapterSuite } from "../contract-tests/snapshot-adapter.suite.mjs";

const ARTIFACT = path.resolve("dist/claude-code/push-metrics.mjs");
const FIXTURE = path.resolve("integrations/claude-code/fixtures/sample-transcript.jsonl");

async function runHook({ gateway, token, tokenFile, sessionID, transcript, extraEnv = {} }) {
  const requests = [];
  const dir = await mkdtemp(path.join(tmpdir(), "arm-claude-hook-"));
  const copy = path.join(dir, "push-metrics.mjs");
  await cp(ARTIFACT, copy);
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const env = { ...process.env, AGENT_METRICS_DEBUG: "1", ...extraEnv };
  for (const [key, value] of [
    ["AGENT_METRICS_TOKEN", token],
    ["AGENT_METRICS_TOKEN_FILE", tokenFile],
  ]) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (gateway) env.AGENT_METRICS_PUSHGATEWAY = `http://127.0.0.1:${port}`;
  else delete env.AGENT_METRICS_PUSHGATEWAY;
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [copy], {
        stdio: ["pipe", "ignore", "inherit"],
        env,
      });
      child.stdin.end(JSON.stringify({
        hook_event_name: "Stop",
        session_id: sessionID,
        transcript_path: transcript,
      }));
      child.on("error", reject);
      child.on("close", resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { code, requests };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function runHookWithEnv(extraEnv) {
  return (args) => runHook({ ...args, extraEnv });
}

test("claude artifact rejects reserved env labels without delivery", async () => {
  const hook = runHookWithEnv({ AGENT_METRICS_LABELS: "project=evil" });
  const { code, requests } = await hook({ gateway: "http://gateway.example", token: "t", sessionID: "ses_A-full", transcript: FIXTURE });
  assert.equal(code, 0);
  assert.equal(requests.length, 0); // misconfiguration disables delivery
});

test("claude artifact rejects invalid env label names without delivery", async () => {
  const hook = runHookWithEnv({ AGENT_METRICS_LABELS: "my-label=1" });
  const { code, requests } = await hook({ gateway: "http://gateway.example", token: "t", sessionID: "ses_A-full", transcript: FIXTURE });
  assert.equal(code, 0);
  assert.equal(requests.length, 0);
});

test("claude artifact env labels cannot override decoded project", async () => {
  const user = os.userInfo().username;
  const projectsDir = await mkdtemp(path.join(tmpdir(), "arm-claude-proj-"));
  const projectRoot = path.join(projectsDir, ".claude", "projects", `-home-${user}-proj`);
  await mkdir(projectRoot, { recursive: true });
  const transcript = path.join(projectRoot, "ses_A-full.jsonl");
  await cp(FIXTURE, transcript);
  try {
    const hook = runHookWithEnv({ AGENT_METRICS_LABELS: "team=platform" });
    const { requests } = await hook({ gateway: "http://gateway.example", token: "t", sessionID: "ses_A-full", transcript });
    assert.equal(requests.length, 1);
    assert.match(requests[0].body, /project="proj"/); // decoded slug wins, never a custom project
    assert.match(requests[0].body, /team="platform"/); // non-reserved custom labels pass
  } finally {
    await rm(projectsDir, { recursive: true, force: true });
  }
});

runSnapshotAdapterSuite({ label: "claude artifact", runHook, fixture: FIXTURE });

async function importArtifactCopy() {
  const dir = await mkdtemp(path.join(tmpdir(), "arm-claude-artifact-"));
  const copy = path.join(dir, "push-metrics.mjs");
  await cp(ARTIFACT, copy);
  return { copy, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("claude artifact is self-contained executable without vendor fallbacks", async () => {
  const source = await readFile(ARTIFACT, "utf8");
  assert.equal(source.split("\n")[0], "#!/usr/bin/env node");
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
    assert.match(match[1], /^node:/, `non-builtin import in artifact: ${match[1]}`);
  }
  for (const forbidden of [".harness", "eharness", ".saas", "port_transport", "python"]) {
    assert.equal(source.includes(forbidden), false, `artifact references ${forbidden}`);
  }
});

test("claude artifact --self-test parses the fixture", async () => {
  const { copy, cleanup } = await importArtifactCopy();
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [copy, "--self-test", FIXTURE], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /agent_tokens_total/);
  } finally {
    await cleanup();
  }
});

test("claude artifact hook posts full session label and bearer to the gateway", async () => {
  const { copy, cleanup } = await importArtifactCopy();
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [copy], {
        stdio: ["pipe", "ignore", "inherit"],
        env: {
          ...process.env,
          AGENT_METRICS_PUSHGATEWAY: `http://127.0.0.1:${port}`,
          AGENT_METRICS_TOKEN: "hook-token",
          AGENT_METRICS_SESSION: "ses_ce7aAAAA-and-more",
          AGENT_METRICS_DEBUG: "1",
        },
      });
      child.stdin.end(JSON.stringify({
        hook_event_name: "Stop",
        session_id: "ses_ce7aAAAA-and-more",
        transcript_path: FIXTURE,
      }));
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/metrics\/job\/claude-code\/instance\//);
    assert.equal(seen[0].headers.authorization, "Bearer hook-token");
    assert.match(seen[0].body, /session="ses_ce7aAAAA-and-more"/); // full id
    assert.match(seen[0].body, /agent_tokens_total/);
  } finally {
    server.close();
    await cleanup();
  }
});
