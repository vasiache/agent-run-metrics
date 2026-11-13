#!/usr/bin/env node
// Build the self-contained distribution artifacts. Relative imports are
// bundled; node: builtins stay external. Checked-in outputs are verified by
// `npm run check:artifacts` (regeneration must produce no diff).
import { build } from "esbuild";

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
// push-metrics.mjs starts with its own shebang; esbuild preserves it
await build({ ...common, entryPoints: ["integrations/claude-code/push-metrics.mjs"], outfile: `${distRoot}/dist/claude-code/push-metrics.mjs` });
