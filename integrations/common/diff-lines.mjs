// Counts added and deleted lines in a unified diff text. File headers
// (+++/---), hunk headers (@@), context lines, and "\ No newline" markers
// are ignored; only +/- content lines count. Non-diff text yields zeros.

export function countDiffLines(diffText) {
  if (typeof diffText !== "string") return { added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) deleted++;
  }
  return { added, deleted };
}

// Line delta between two text revisions. Trims the common prefix and suffix,
// then counts the longest common subsequence of what remains: unchanged
// middle lines are never double-counted. Revisions above the LCS size cap
// fall back to raw remaining counts (documented approximation). An empty
// string counts as zero lines, not one empty line.
export function lineDelta(oldText, newText) {
  const lines = (t) => (typeof t === "string" && t.length ? t.split("\n") : []);
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  const oldRemaining = oldLines.slice(start, endOld);
  const newRemaining = newLines.slice(start, endNew);
  if (!oldRemaining.length) return { added: newRemaining.length, deleted: 0 };
  if (!newRemaining.length) return { added: 0, deleted: oldRemaining.length };
  if (oldRemaining.length > 2000 || newRemaining.length > 2000) {
    return { added: newRemaining.length, deleted: oldRemaining.length };
  }
  const lcs = lcsLength(oldRemaining, newRemaining);
  return { added: newRemaining.length - lcs, deleted: oldRemaining.length - lcs };
}

// LCS length over whole lines, O(n*m) time with a rolling single row.
function lcsLength(a, b) {
  const row = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0; // row[i-1][j-1]
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]; // row[i-1][j]
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}
