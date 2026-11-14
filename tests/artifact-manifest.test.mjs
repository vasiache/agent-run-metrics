import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import packageJson from "../package.json" with { type: "json" };

test("package.json exports point at the built opencode artifact", () => {
  assert.equal(packageJson.exports, "./dist/opencode/v1/plugin.js");
  assert.ok(
    existsSync(packageJson.exports),
    "exported artifact is missing; run npm run build",
  );
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("dist"),
    "npm package must ship the dist directory",
  );
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("plugin.json"),
    "npm package must ship the Agent Plugins manifest",
  );
});

test("plugin.json identifies the plugin and matches package.json version", async () => {
  const manifest = JSON.parse(await readFile("plugin.json", "utf8"));
  assert.equal(manifest.name, "agent-run-metrics");
  assert.match(manifest.$schema, /plugin\.schema\.json$/);
  assert.equal(manifest.version, packageJson.version);
});
