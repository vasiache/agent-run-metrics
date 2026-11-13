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
