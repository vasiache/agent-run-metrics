import os from "node:os";

export function buildPushgatewayUrl({ endpoint, job, instance, labels = {} }) {
  if (!endpoint) return null;
  const base = String(endpoint);
  const suffix = Object.entries(labels)
    .map(([key, value]) => `/${encodeURIComponent(key)}/${encodeURIComponent(value)}`)
    .join("");
  return `${base.replace(/\/+$/, "")}/metrics/job/${encodeURIComponent(job)}/instance/${encodeURIComponent(instance || os.hostname())}${suffix}`;
}

export function createPushgatewayClient({
  config,
  tokenProvider = async () => null,
  fetchImpl = fetch,
  timeoutMs = 5000,
  logger = console.error,
} = {}) {
  function debug(message) {
    if (config.debug) logger(`[agent-run-metrics] ${message}`);
  }

  return {
    async push({ labels, body }) {
      if (!config.enabled) return false;
      try {
        const token = await tokenProvider();
        const url = buildPushgatewayUrl({
          endpoint: config.endpoint,
          job: config.job,
          instance: config.instance,
          labels,
        });
        if (!url) {
          debug("push skipped because endpoint configuration is invalid");
          return false;
        }
        const headers = { "Content-Type": "text/plain" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          debug(`push failed with HTTP ${response.status}`);
          return false;
        }
        return true;
      } catch {
        debug("push failed");
        return false;
      }
    },
  };
}
