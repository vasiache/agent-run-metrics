import test from "node:test";
import assert from "node:assert/strict";

import { MetricsConfigurationError, resolveMetricsConfig } from "../integrations/common/config.mjs";

test("configuration prefers explicit options over environment", () => {
  const config = resolveMetricsConfig({
    options: {
      endpoint: "https://options.example/push",
      job: "options-job",
      runtime: "options-runtime",
      instance: "options-instance",
      labels: { user: "options-user" },
      token: "options-token",
      tokenFile: "/options/token",
      debug: true,
    },
    env: {
      AGENT_METRICS_PUSHGATEWAY: "https://env.example/push",
      AGENT_METRICS_JOB: "env-job",
      AGENT_METRICS_RUNTIME: "env-runtime",
      AGENT_METRICS_INSTANCE: "env-instance",
      AGENT_METRICS_LABELS: "user=env-user,profile=test",
      AGENT_METRICS_TOKEN: "env-token",
      AGENT_METRICS_TOKEN_FILE: "/env/token",
      AGENT_METRICS_DEBUG: "0",
    },
    runtime: "adapter-runtime",
    defaults: { instance: "adapter-instance" },
  });

  assert.deepEqual(config, {
    enabled: true,
    endpoint: "https://options.example/push",
    job: "options-job",
    runtime: "options-runtime",
    instance: "options-instance",
    labels: { user: "options-user" },
    token: "options-token",
    tokenFile: "/options/token",
    debug: true,
  });
});

test("configuration maps environment and adapter defaults", () => {
  const config = resolveMetricsConfig({
    env: {
      AGENT_METRICS_PUSHGATEWAY: "https://env.example/push",
      AGENT_METRICS_LABELS: "user=env-user, profile=test",
      AGENT_METRICS_DEBUG: "1",
    },
    runtime: "opencode",
    defaults: { instance: "host-a" },
  });

  assert.equal(config.job, "opencode");
  assert.equal(config.runtime, "opencode");
  assert.equal(config.instance, "host-a");
  assert.deepEqual(config.labels, { user: "env-user", profile: "test" });
  assert.equal(config.debug, true);
});

test("configuration disables delivery without endpoint", () => {
  const config = resolveMetricsConfig({ env: {}, runtime: "opencode" });
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, null);
});

test("configuration rejects reserved and malformed custom labels", () => {
  for (const labels of [{ session: "collision" }, { decision: "collision" }, { "bad-name": "value" }]) {
    assert.throws(
      () => resolveMetricsConfig({
        options: { endpoint: "https://example.test", labels },
        env: {},
        runtime: "opencode",
      }),
      MetricsConfigurationError,
    );
  }
});

// --- config file source (npm-installed plugins receive no options) ---

async function writeConfigFile(dir, content) {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "arm-cfg-"));
  const file = path.join(root, "agent-metrics.json");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

test("config file provides settings when options and env are absent", async () => {
  const file = await writeConfigFile(undefined, {
    endpoint: "https://gateway.example/push", tokenFile: "~/gateway.token", job: "file-job",
  });
  const config = resolveMetricsConfig({ options: {}, env: {}, runtime: "opencode", configFilePath: file });
  assert.equal(config.enabled, true);
  assert.equal(config.endpoint, "https://gateway.example/push");
  assert.equal(config.tokenFile, "~/gateway.token");
  assert.equal(config.job, "file-job");
});

test("env overrides config file and options override env", async () => {
  const file = await writeConfigFile(undefined, {
    endpoint: "https://file.example/push", job: "file-job",
  });
  const fromFile = resolveMetricsConfig({ options: {}, env: {}, runtime: "opencode", configFilePath: file });
  assert.equal(fromFile.endpoint, "https://file.example/push");

  const fromEnv = resolveMetricsConfig({
    options: {}, env: { AGENT_METRICS_PUSHGATEWAY: "https://env.example/push" },
    runtime: "opencode", configFilePath: file,
  });
  assert.equal(fromEnv.endpoint, "https://env.example/push");
  assert.equal(fromEnv.job, "file-job"); // file fills what env does not set

  const fromOptions = resolveMetricsConfig({
    options: { endpoint: "https://options.example/push" }, env: { AGENT_METRICS_PUSHGATEWAY: "https://env.example/push" },
    runtime: "opencode", configFilePath: file,
  });
  assert.equal(fromOptions.endpoint, "https://options.example/push");
});

test("missing or absent config file path is silently skipped", async () => {
  const absent = resolveMetricsConfig({
    options: {}, env: {}, runtime: "opencode",
    configFilePath: "/nonexistent/agent-metrics.json",
  });
  assert.equal(absent.enabled, false);

  const none = resolveMetricsConfig({
    options: {}, env: {}, runtime: "opencode",
    configFilePath: ["/nonexistent/a.json", "/nonexistent/b.json"],
  });
  assert.equal(none.enabled, false);
});

test("first existing config file candidate wins", async () => {
  const file = await writeConfigFile(undefined, { endpoint: "https://first.example/push" });
  const { readFile, writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "arm-cfg2-"));
  const second = path.join(root, "agent-metrics.json");
  await writeFile(second, JSON.stringify({ endpoint: "https://second.example/push" }));
  const config = resolveMetricsConfig({
    options: {}, env: {}, runtime: "opencode", configFilePath: [file, second],
  });
  assert.equal(config.endpoint, "https://first.example/push");
});

test("malformed config file disables delivery with a configuration error", async () => {
  const file = await writeConfigFile(undefined, "{not json");
  assert.throws(
    () => resolveMetricsConfig({ options: {}, env: {}, runtime: "opencode", configFilePath: file }),
    MetricsConfigurationError,
  );
});
