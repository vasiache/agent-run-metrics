#!/usr/bin/env node
// check:artifacts — rebuild into a temporary root and verify the checked-in
// dist/ tree is byte-identical. dist/ is intentionally untracked until the
// user commits, so a git-based diff cannot prove regeneration cleanliness.
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const checkRoot = await mkdtemp(path.join(tmpdir(), "arm-artifacts-check-"));

try {
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: root,
    env: { ...process.env, ARM_DIST_ROOT: checkRoot },
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const diff = spawnSync("diff", ["-r", path.join(checkRoot, "dist"), path.join(root, "dist")], {
    stdio: "inherit",
  });
  if (diff.status !== 0) {
    console.error("artifacts are stale: run `npm run build` and commit the regenerated dist/");
    process.exit(diff.status ?? 1);
  }
  console.log("artifacts are up to date");
} finally {
  await rm(checkRoot, { recursive: true, force: true }).catch(() => {});
}
