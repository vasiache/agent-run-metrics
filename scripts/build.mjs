#!/usr/bin/env node
// Build the self-contained distribution artifacts. Relative imports are
// bundled; node: builtins stay external. Checked-in outputs are verified by
// `npm run check:artifacts` (regeneration must produce no diff).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

// Keep the Agent Plugins manifest version aligned with the package version.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifestPath = new URL("../plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// ARM_DIST_ROOT lets scripts/check-artifacts.mjs rebuild into a temporary
// tree; the default output root stays the checked-in dist/.
const distRoot = process.env.ARM_DIST_ROOT || process.cwd();

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  packages: "external",
  legalComments: "none",
  logLevel: "info",
};

await build({ ...common, entryPoints: ["integrations/opencode/plugin.js"], outfile: `${distRoot}/dist/opencode/v1/plugin.js` });
await build({ ...common, entryPoints: ["integrations/opencode/embed.mjs"], outfile: `${distRoot}/dist/opencode/v1/core.embed.js` });
// push-metrics.mjs starts with its own shebang; esbuild preserves it
await build({ ...common, entryPoints: ["integrations/claude-code/push-metrics.mjs"], outfile: `${distRoot}/dist/claude-code/push-metrics.mjs` });
