import test from "node:test";
import assert from "node:assert/strict";

import { resolveMetricsConfig } from "../integrations/common/config.mjs";
import { createTokenProvider, TokenConfigurationError } from "../integrations/common/token-provider.mjs";

test("token provider prefers direct token without reading a file", async () => {
  let reads = 0;
  const provider = createTokenProvider({
    token: " direct-token ",
    tokenFile: "/unused/token",
    readFile: async () => { reads++; return "file-token"; },
  });

  assert.equal(await provider(), "direct-token");
  assert.equal(reads, 0);
});

test("token provider trims and rereads token files for rotation", async () => {
  let value = " first-token\n";
  let reads = 0;
  const provider = createTokenProvider({
    tokenFile: "/token",
    readFile: async () => { reads++; return value; },
  });

  assert.equal(await provider(), "first-token");
  value = "second-token\n";
  assert.equal(await provider(), "second-token");
  assert.equal(reads, 2);
});

test("token provider returns null when no credential is configured", async () => {
  let reads = 0;
  const provider = createTokenProvider({
    readFile: async () => { reads++; return "unused"; },
  });
  assert.equal(await provider(), null);
  assert.equal(reads, 0);
});

test("token provider rejects missing empty and unreadable explicit files", async () => {
  for (const readFile of [
    async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    async () => " \n",
    async () => { throw new Error("permission denied"); },
  ]) {
    const provider = createTokenProvider({ tokenFile: "/secret/token", readFile });
    await assert.rejects(provider(), TokenConfigurationError);
  }
});

test("token provider errors do not expose file contents", async () => {
  const provider = createTokenProvider({
    tokenFile: "/secret/token",
    readFile: async () => { throw new Error("cannot read super-secret-value"); },
  });
  await assert.rejects(provider(), (error) => {
    assert.equal(error.message.includes("super-secret-value"), false);
    return true;
  });
});

test("token provider is not invoked for disabled configuration", async () => {
  let reads = 0;
  const config = resolveMetricsConfig({
    options: { tokenFile: "/secret/token" },
    env: {},
    runtime: "opencode",
  });
  const provider = createTokenProvider({
    ...config,
    readFile: async () => { reads++; return "secret"; },
  });
  if (config.enabled) await provider();
  assert.equal(reads, 0);
});

test("token file path expands leading tilde to the user home directory", async () => {
  const seen = [];
  const provider = createTokenProvider({
    tokenFile: "~/custom/gateway.token",
    readFile: async (path) => {
      seen.push(path);
      return "token-from-home";
    },
    homedir: () => "/home/tester",
  });
  const token = await provider();
  assert.equal(token, "token-from-home");
  assert.deepEqual(seen, ["/home/tester/custom/gateway.token"]);
});
