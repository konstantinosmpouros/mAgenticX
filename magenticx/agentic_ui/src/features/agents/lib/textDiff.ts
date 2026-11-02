/**
 * A line diff for an agent's prompt files — what one save changed in AGENT.md,
 * a sub-agent's prompt or a reference file, shown on the agent's History tab.
 *
 * Longest-common-subsequence over lines, after trimming the common prefix and
 * suffix (a typical edit touches a few lines of a long prompt, so the table
 * that remains is small). The table is O(n·m), so past `MAX_DIFF_CELLS` the
 * diff is not attempted and the caller says the file is too large to compare
 * instead of freezing the tab.
 */

export type DiffLineKind = "same" | "added" | "removed";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old text; absent on an added line. */
  oldNo?: number;
  /** 1-based line number in the new text; absent on a removed line. */
  newNo?: number;
};

export type TextDiff =
  { tooLarge: true } | { tooLarge: false; lines: DiffLine[]; added: number; removed: number };

/** A run of unchanged lines folded away, or one line to show. */
export type DiffSegment = { type: "line"; line: DiffLine } | { type: "skip"; count: number };

/** The most LCS table cells (changed old lines × changed new lines) we compute. */
export const MAX_DIFF_CELLS = 1_000_000;

/** Unchanged lines kept on each side of a change when the rest is collapsed. */
export const DIFF_CONTEXT = 3;

/**
 * A text as lines. CRLF and lone CR are read as LF, and one trailing newline
 * ends the last line rather than starting an empty one; an empty text has no
 * lines at all, so creating or emptying a file reads as all-added/all-removed.
 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Diff two texts line by line, or report that they are too large to compare. */
export function diffLines(before: string, after: string, maxCells = MAX_DIFF_CELLS): TextDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return { tooLarge: true };

  // lcs[i * (m + 1) + j] = LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (let k = 0; k < start; k++) {
    lines.push({ kind: "same", text: a[k], oldNo: k + 1, newNo: k + 1 });
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      lines.push({ kind: "same", text: a[start + i], oldNo: start + i + 1, newNo: start + j + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      // On a tie the removal goes first: within one change, the old lines
      // above the new ones reads like the edit it was.
      lines.push({ kind: "removed", text: a[start + i], oldNo: start + i + 1 });
      removed++;
      i++;
    } else {
      lines.push({ kind: "added", text: b[start + j], newNo: start + j + 1 });
      added++;
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    lines.push({ kind: "same", text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return { tooLarge: false, lines, added, removed };
}

/**
 * Fold long runs of unchanged lines, keeping `context` lines next to each
 * change. A run is only folded when that hides at least two lines — replacing
 * one line with a "1 unchanged line" marker saves nothing.
 */
export function collapseUnchanged(lines: DiffLine[], context = DIFF_CONTEXT): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k].kind !== "same") {
      segments.push({ type: "line", line: lines[k] });
      k++;
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end].kind === "same") end++;
    const keepHead = k === 0 ? 0 : context;
    const keepTail = end === lines.length ? 0 : context;
    const hidden = end - k - keepHead - keepTail;
    if (hidden >= 2) {
      for (let x = k; x < k + keepHead; x++) segments.push({ type: "line", line: lines[x] });
      segments.push({ type: "skip", count: hidden });
      for (let x = end - keepTail; x < end; x++) segments.push({ type: "line", line: lines[x] });
    } else {
      for (let x = k; x < end; x++) segments.push({ type: "line", line: lines[x] });
    }
    k = end;
  }
  return segments;
}
