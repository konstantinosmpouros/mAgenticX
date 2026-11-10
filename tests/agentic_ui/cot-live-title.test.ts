import { describe, expect, it } from "vitest";

import { liveCoTTitle, thoughtTitle } from "@/features/chat/lib/cotTitle";
import type { ThinkingBlockItem } from "@/shared/lib/types";

/**
 * A live chain of thought names its latest step in its header (a thought's
 * headline, the tool in use).
 */

const thought = (text: string): ThinkingBlockItem => ({ kind: "thought", id: `t-${text}`, text });
const tool = (name: string, args: unknown = {}): ThinkingBlockItem =>
  ({
    kind: "tool",
    id: `tool-${name}`,
    name,
    argsText: JSON.stringify({ name, args }),
    state: "input-available",
  }) as unknown as ThinkingBlockItem;

describe("thoughtTitle", () => {
  it("takes a reasoning summary's bold headline", () => {
    expect(thoughtTitle("**Weighing the sources**\n\nI need to compare…")).toBe("Weighing the sources");
  });

  it("falls back to the first line without markdown", () => {
    expect(thoughtTitle("\n## Planning the *search*\nmore")).toBe("Planning the search");
  });

  it("clips a long line", () => {
    const title = thoughtTitle("x".repeat(200));
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("liveCoTTitle", () => {
  it("names the latest thought", () => {
    expect(liveCoTTitle([thought("**One**\n\na"), thought("**Two**\n\nb")])).toBe("Two");
  });

  it("names a known tool by its step title", () => {
    expect(liveCoTTitle([thought("**One**"), tool("read_file", { file_path: "/docs/report.pdf" })])).toBe(
      "Read report.pdf",
    );
  });

  it("says which tool is in use otherwise", () => {
    expect(liveCoTTitle([tool("fetch_weather")])).toBe("Using Fetch weather");
  });

  it("names a hand-off", () => {
    expect(
      liveCoTTitle([{ kind: "delegation", id: "d", taskId: "tc-1", type: "fact-checker" }]),
    ).toBe("Delegating to the fact-checker sub-agent");
  });

  it("skips an empty thought and has nothing to say for an empty block", () => {
    expect(liveCoTTitle([thought("**Found it**"), thought("")])).toBe("Found it");
    expect(liveCoTTitle([])).toBeNull();
  });
});
