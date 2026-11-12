// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SourceCards } from "@/features/chat/components/message_parts/SourceCards";
import { createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import type { CitationSource, ThinkingBlock, TimelineToolExecution } from "@/shared/lib/types";

/**
 * A search step shows the pages it found as chips — for any search tool — and
 * the result's text never needs to reach the browser (plan 42).
 */

const source = (id: string, over: Partial<CitationSource> = {}): CitationSource => ({
  id,
  url: `https://www.${id}.example.com/reports/2010`,
  title: `Report ${id}`,
  snippet: "",
  tool: "brave_web_search",
  ...over,
});

const toolSteps = (timeline: ReturnType<typeof createTimeline>): TimelineToolExecution[] =>
  timeline.blocks
    .filter((block): block is ThinkingBlock => block.kind === "thinking")
    .flatMap((block) => block.items)
    .filter((item): item is TimelineToolExecution => item.kind === "tool");

describe("a search step's sources", () => {
  it("land on the tool step that found them", () => {
    const timeline = reduceTimelineEvents(createTimeline(), [
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "brave_web_search" },
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "" },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      { type: "CUSTOM", name: "SOURCES", value: { tool_call_id: "c1", sources: [source("aaa111")] } },
    ]);
    const [step] = toolSteps(timeline);
    expect(step.sources?.map((s) => s.id)).toEqual(["aaa111"]);
    expect(step.result).toBe("");
  });

  it("render as chips that open the page safely", () => {
    render(<SourceCards sources={[source("aaa111"), source("bbb222", { title: "" })]} />);
    expect(screen.getByRole("list", { name: "Sources" })).toBeTruthy();
    const link = screen.getByRole("link", { name: /Report aaa111/ });
    expect(link.getAttribute("href")).toBe("https://www.aaa111.example.com/reports/2010");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.getAttribute("title")).toBe("Report aaa111 — aaa111.example.com");
    // No title: the chip is named after the site.
    const bare = screen.getByRole("link", { name: /bbb222\.example\.com/ });
    expect(bare.getAttribute("title")).toBe("bbb222.example.com");
    // No heading and no big cards any more.
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("never link anything but http(s)", () => {
    const { container } = render(<SourceCards sources={[source("ccc333", { url: "javascript:alert(1)" })]} />);
    expect(container.querySelector("a")).toBeNull();
  });
});
