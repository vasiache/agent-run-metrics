import test from "node:test";
import assert from "node:assert/strict";

import { countDiffLines } from "../integrations/common/diff-lines.mjs";

test("diff lines counts content and skips headers context and markers", () => {
  const diff = [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,4 @@",
    " context",
    "-removed",
    "+added",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(countDiffLines(diff), { added: 1, deleted: 1 });
});

test("diff lines ignores non-diff and empty input", () => {
  assert.deepEqual(countDiffLines("plain text\nmore text"), { added: 0, deleted: 0 });
  assert.deepEqual(countDiffLines(""), { added: 0, deleted: 0 });
  assert.deepEqual(countDiffLines(undefined), { added: 0, deleted: 0 });
});

test("line delta trims common prefix and suffix", async () => {
  const { lineDelta } = await import("../integrations/common/diff-lines.mjs");
  assert.deepEqual(lineDelta("one\ntwo\nthree", "one\nTWO\nthree\nfour"), { added: 2, deleted: 1 });
  assert.deepEqual(lineDelta("a", "a\nb"), { added: 1, deleted: 0 });
  assert.deepEqual(lineDelta("p\nq", "q"), { added: 0, deleted: 1 });
  assert.deepEqual(lineDelta("", "x\ny"), { added: 2, deleted: 0 });
  assert.deepEqual(lineDelta("same", "same"), { added: 0, deleted: 0 });
});
