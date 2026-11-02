import { describe, expect, it } from "vitest";

import {
  collapseUnchanged,
  diffLines,
  splitLines,
  type DiffLine,
} from "@/features/agents/lib/textDiff";

/**
 * The History tab's line diff: LCS over lines with the common ends trimmed, a
 * size cap that answers "too large" instead of building a huge table, and long
 * unchanged runs folded down to a few lines of context around each change.
 */
const kinds = (lines: DiffLine[]) =>
  lines.map((l) => `${l.kind === "same" ? " " : l.kind === "added" ? "+" : "-"}${l.text}`);

const diff = (a: string, b: string) => {
  const result = diffLines(a, b);
  if (result.tooLarge) throw new Error("unexpectedly too large");
  return result;
};

describe("splitLines", () => {
  it("reads CRLF as LF, drops one trailing newline and has no lines for an empty text", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("diffLines", () => {
  it("finds nothing between equal texts", () => {
    const result = diff("a\nb\nc", "a\nb\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines.every((l) => l.kind === "same")).toBe(true);
  });

  it("marks one changed line as a removal followed by an addition, numbered on each side", () => {
    const result = diff("a\nb\nc", "a\nB\nc");
    expect(kinds(result.lines)).toEqual([" a", "-b", "+B", " c"]);
    expect(result.lines[1]).toMatchObject({ oldNo: 2 });
    expect(result.lines[1].newNo).toBeUndefined();
    expect(result.lines[2]).toMatchObject({ newNo: 2 });
    expect(result.lines[2].oldNo).toBeUndefined();
    expect(result.lines[3]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it("keeps the longest common subsequence across inserts and deletes", () => {
    const result = diff("a\nb\nc\nd\ne", "a\nc\nd\nx\ne\nf");
    expect(kinds(result.lines)).toEqual([" a", "-b", " c", " d", "+x", " e", "+f"]);
    expect(result).toMatchObject({ added: 2, removed: 1 });
  });

  it("reads a new file as all added and a deleted one as all removed", () => {
    expect(diff("", "x\ny")).toMatchObject({ added: 2, removed: 0 });
    expect(diff("x\ny", "")).toMatchObject({ added: 0, removed: 2 });
  });

  it("ignores a line-ending change", () => {
    expect(diff("a\r\nb\r\n", "a\nb\n")).toMatchObject({ added: 0, removed: 0 });
  });

  it("refuses past the size cap, but only for the part that actually differs", () => {
    const many = (prefix: string) =>
      Array.from({ length: 400 }, (_, i) => `${prefix}${i}`).join("\n");
    expect(diffLines(many("a"), many("b"), 1000)).toEqual({ tooLarge: true });
    // A long shared prefix and suffix is trimmed before the cap applies.
    const shared = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = diffLines(`${shared}\nold\n${shared}`, `${shared}\nnew\n${shared}`, 10);
    expect(result).toMatchObject({ tooLarge: false, added: 1, removed: 1 });
  });
});

describe("collapseUnchanged", () => {
  const long = Array.from({ length: 20 }, (_, i) => `l${i}`);

  it("keeps three lines of context around a change and folds the rest", () => {
    const after = [...long];
    after[10] = "changed";
    const { lines } = diff(long.join("\n"), after.join("\n"));
    const segments = collapseUnchanged(lines);
    expect(segments[0]).toEqual({ type: "skip", count: 7 });
    expect(segments.at(-1)).toEqual({ type: "skip", count: 6 });
    const shown = segments.filter((s) => s.type === "line");
    // 3 before + removed + added + 3 after.
    expect(shown).toHaveLength(8);
  });

  it("does not fold a run that would hide fewer than two lines", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const after = ["A", "b", "c", "d", "e", "f", "g", "H"];
    const segments = collapseUnchanged(diff(before.join("\n"), after.join("\n")).lines);
    expect(segments.some((s) => s.type === "skip")).toBe(false);
  });

  it("folds the gap between two distant changes into one marker", () => {
    const after = [...long];
    after[0] = "first";
    after[19] = "last";
    const segments = collapseUnchanged(diff(long.join("\n"), after.join("\n")).lines);
    expect(segments.filter((s) => s.type === "skip")).toEqual([{ type: "skip", count: 12 }]);
  });
});
