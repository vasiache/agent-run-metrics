import { existsSync, readFileSync } from "node:fs";

const RESERVED_LABELS = new Set([
  "runtime", "session", "project", "instance", "job",
  "kind", "tool", "skill", "plugin", "agent", "decision",
]);
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// npm-installed plugins receive no options, so deployments deliver settings
// through a JSON file. Callers pass candidate paths (string or array); the
// first existing file wins, a missing file is skipped, a malformed file is a
// configuration error. Precedence per field: options > env > file > defaults.
function readConfigFile(configFilePath) {
  const paths = Array.isArray(configFilePath) ? configFilePath : [configFilePath];
  for (const path of paths) {
    if (!path) continue;
    let raw;
    try {
      if (!existsSync(path)) continue;
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // vanished between check and read; treat as absent
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new MetricsConfigurationError(`invalid config file ${path}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MetricsConfigurationError(`config file must contain a JSON object: ${path}`);
    }
    return parsed;
  }
  return null;
}

export class MetricsConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricsConfigurationError";
  }
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

function booleanValue(value) {
  return value === true || value === "1" || value === "true";
}

function parseLabels(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  const labels = {};
  for (const item of String(value).split(",").filter(Boolean)) {
    const [key, raw] = item.split("=", 2);
    if (!key || raw === undefined) throw new MetricsConfigurationError("labels must use key=value entries");
    labels[key.trim()] = raw.trim();
  }
  return labels;
}

function validateLabels(labels) {
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_NAME.test(key)) throw new MetricsConfigurationError(`invalid label name: ${key}`);
    if (RESERVED_LABELS.has(key)) throw new MetricsConfigurationError(`reserved label name: ${key}`);
    labels[key] = String(value);
  }
  return labels;
}

export function resolveMetricsConfig({ options = {}, env = process.env, runtime, defaults = {}, configFilePath }) {
  const file = readConfigFile(configFilePath) ?? {};
  const endpoint = first(options.endpoint, env.AGENT_METRICS_PUSHGATEWAY, file.endpoint);
  const debug = booleanValue(options.debug ?? env.AGENT_METRICS_DEBUG ?? file.debug);
  if (!endpoint) {
    return {
      enabled: false, endpoint: null, job: null, runtime, instance: null,
      labels: {}, token: null, tokenFile: null, debug,
    };
  }

  return {
    enabled: true,
    endpoint,
    job: first(options.job, env.AGENT_METRICS_JOB, defaults.job, file.job, runtime),
    runtime: first(options.runtime, env.AGENT_METRICS_RUNTIME, file.runtime, runtime),
    instance: first(options.instance, env.AGENT_METRICS_INSTANCE, defaults.instance, file.instance),
    labels: validateLabels(parseLabels(options.labels ?? env.AGENT_METRICS_LABELS ?? file.labels)),
    token: first(options.token, env.AGENT_METRICS_TOKEN, file.token),
    tokenFile: first(options.tokenFile, env.AGENT_METRICS_TOKEN_FILE, file.tokenFile),
    debug,
  };
}
