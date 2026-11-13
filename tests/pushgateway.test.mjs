import test from "node:test";
import assert from "node:assert/strict";

import { buildPushgatewayUrl, createPushgatewayClient } from "../integrations/common/pushgateway.mjs";

const endpoint = "https://gateway.example/push";
const config = {
  enabled: true,
  endpoint,
  job: "job a/b",
  runtime: "opencode",
  instance: "host a/b",
  labels: {},
  token: null,
  tokenFile: null,
  debug: true,
};

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

test("pushgateway URL encodes job instance and labels", () => {
  const url = buildPushgatewayUrl({
    endpoint,
    job: "job a/b",
    instance: "host a/b",
    labels: { user: "a b/x", project: "demo" },
  });
  assert.equal(
    url,
    "https://gateway.example/push/metrics/job/job%20a%2Fb/instance/host%20a%2Fb/user/a%20b%2Fx/project/demo",
  );
});

test("pushgateway URL uses the endpoint verbatim", () => {
  const url = buildPushgatewayUrl({
    endpoint: "https://gateway.example/push/tenant-a",
    job: "job",
    instance: "host",
    labels: {},
  });
  assert.equal(url, "https://gateway.example/push/tenant-a/metrics/job/job/instance/host");
});

test("pushgateway URL does not substitute tenant placeholders and ignores tokens", () => {
  const url = buildPushgatewayUrl({
    endpoint: "https://gateway.example/push/<tenant>",
    job: "job",
    instance: "host",
    labels: {},
    token: jwt({ tenant_id: "tenant-a" }),
  });
  assert.equal(url, "https://gateway.example/push/<tenant>/metrics/job/job/instance/host");
});

test("pushgateway delivery sends body and bearer token", async () => {
  const calls = [];
  const client = createPushgatewayClient({
    config,
    tokenProvider: async () => "raw-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    logger: () => {},
  });

  assert.equal(await client.push({ labels: { session: "full-session" }, body: "metric 1\n" }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer raw-token");
  assert.equal(calls[0].options.headers["Content-Type"], "text/plain");
  assert.equal(calls[0].options.body, "metric 1\n");
});

test("pushgateway delivery rereads rotated credentials", async () => {
  const tokens = ["first", "second"];
  const authorization = [];
  const client = createPushgatewayClient({
    config,
    tokenProvider: async () => tokens.shift(),
    fetchImpl: async (_url, options) => {
      authorization.push(options.headers.Authorization);
      return { ok: true, status: 200 };
    },
    logger: () => {},
  });
  await client.push({ labels: {}, body: "first\n" });
  await client.push({ labels: {}, body: "second\n" });
  assert.deepEqual(authorization, ["Bearer first", "Bearer second"]);
});

test("pushgateway delivery returns false for HTTP and network failures", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401 }),
    async () => { throw new Error("offline"); },
  ]) {
    const client = createPushgatewayClient({
      config,
      tokenProvider: async () => null,
      fetchImpl,
      logger: () => {},
    });
    assert.equal(await client.push({ labels: {}, body: "metric\n" }), false);
  }
});

test("pushgateway delivery aborts slow requests", async () => {
  let observedSignal;
  // AbortSignal.timeout arms an unref'd timer; keep the loop alive while the
  // push is pending or the test runner drains first and cancels the file
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const client = createPushgatewayClient({
      config,
      tokenProvider: async () => null,
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
      logger: () => {},
    });
    assert.equal(await client.push({ labels: {}, body: "metric\n" }), false);
    assert.equal(observedSignal.aborted, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test("pushgateway disabled config performs no token or network I/O", async () => {
  let reads = 0;
  let requests = 0;
  const client = createPushgatewayClient({
    config: { ...config, enabled: false, endpoint: null },
    tokenProvider: async () => { reads++; return "secret"; },
    fetchImpl: async () => { requests++; return { ok: true, status: 200 }; },
    logger: () => {},
  });
  assert.equal(await client.push({ labels: {}, body: "metric\n" }), false);
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test("pushgateway debug logs never expose credentials", async () => {
  const messages = [];
  const client = createPushgatewayClient({
    config,
    tokenProvider: async () => { throw new Error("super-secret-token"); },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    logger: (message) => messages.push(message),
  });
  assert.equal(await client.push({ labels: {}, body: "metric\n" }), false);
  assert.equal(messages.join("\n").includes("super-secret-token"), false);
});
