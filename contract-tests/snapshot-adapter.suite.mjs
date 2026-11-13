// Shared contract suite for snapshot-driven adapters (stateless hooks that
// recompute totals per invocation, e.g. transcript-based runtimes). A host
// integration proves its delivery semantics by passing a runHook function.
// See docs/adapter-template.md.
import test from "node:test";
import assert from "node:assert/strict";

// runHook({ gateway, token, tokenFile, sessionID, transcript }) -> {
//   code, requests: [{ url, headers, body }]
// }
export function runSnapshotAdapterSuite({ label, runHook, fixture }) {
  test(`${label}: full session label bearer and families reach the gateway`, async () => {
    const sessionID = "ses_ce7aAAAA-and-more";
    const { code, requests } = await runHook({ gateway: "http://gateway.example", token: "hook-token", sessionID, transcript: fixture });
    assert.equal(code, 0);
    assert.ok(requests.length >= 1);
    for (const request of requests) {
      assert.match(request.url, /\/metrics\/job\//);
      assert.equal(request.headers.authorization, "Bearer hook-token");
      assert.match(request.body, new RegExp(`session="${sessionID}"`));
      assert.match(request.body, /agent_tokens_total/);
    }
  });

  test(`${label}: rereads credentials between invocations`, async () => {
    const sessionID = "ses_A-full";
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${process.env.TMPDIR || "/tmp"}/arm-snapshot-`));
    const tokenFileA = `${dir}/tokenA`;
    const tokenFileB = `${dir}/tokenB`;
    const writeFile = (await import("node:fs/promises")).writeFile;
    const rm = (await import("node:fs/promises")).rm;
    await writeFile(tokenFileA, " token-one \n");
    await writeFile(tokenFileB, "token-two\n");
    try {
      const first = await runHook({ gateway: "http://gateway.example", tokenFile: tokenFileA, sessionID, transcript: fixture });
      const second = await runHook({ gateway: "http://gateway.example", tokenFile: tokenFileB, sessionID, transcript: fixture });
      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      const bearers = [...first.requests, ...second.requests].map((request) => request.headers.authorization);
      assert.ok(bearers.includes("Bearer token-one"));
      assert.ok(bearers.includes("Bearer token-two"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${label}: no gateway means no delivery`, async () => {
    const { code, requests } = await runHook({ gateway: undefined, sessionID: "ses_A-full", transcript: fixture });
    assert.equal(code, 0);
    assert.equal(requests.length, 0);
  });
}
