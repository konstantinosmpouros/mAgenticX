import { describe, expect, it } from "vitest";

import { answerSources, markerIds, splitAnswerSources } from "@/features/chat/lib/answerSources";
import type { CitationSource, MessageOut } from "@/shared/lib/types";

/**
 * An answer's Sources panel: first what its text points at, by first
 * appearance, then "More" — the rest its runs found (plan 42).
 */

const src = (id: string, over: Partial<CitationSource> = {}): CitationSource => ({
  id,
  url: `https://${id}.example.com/page`,
  title: `Page ${id}`,
  snippet: "",
  tool: "web_search",
  ...over,
});

const registryOf = (...sources: CitationSource[]) => new Map(sources.map((s) => [s.id, s]));

const sourcesEvent = (...sources: CitationSource[]) => ({
  type: "CUSTOM",
  name: "SOURCES",
  value: { tool_call_id: "c1", sources },
});

const ai = (id: string, content: string, events: Record<string, unknown>[] = []): MessageOut =>
  ({ id, sender: "ai", content, created_at: new Date(0), rawEvents: events }) as MessageOut;

describe("answer sources", () => {
  it("reads marker ids in order of first appearance, skipping code", () => {
    expect(
      markerIds([
        "A [src:bbb222]. B [src:aaa111, bbb222].",
        "`[src:ccc333]` and C [src:ddd444]",
        null,
      ]),
    ).toEqual(["bbb222", "aaa111", "ddd444"]);
  });

  it("puts the sources the text points at first, the rest under More", () => {
    const a = src("aaa111");
    const b = src("bbb222");
    const c = src("ccc333");
    const d = src("ddd444");
    const { cited, more } = splitAnswerSources(
      ["Second [src:bbb222], first [src:aaa111]."],
      registryOf(a, b, c),
      [{ [a.id]: a, [c.id]: c }, [d, b, c]],
    );
    expect(cited.map((s) => s.id)).toEqual(["bbb222", "aaa111"]);
    expect(more.map((s) => s.id)).toEqual(["ccc333", "ddd444"]);
  });

  it("drops unknown ids and non-http(s) pages, and never lists a page twice", () => {
    const a = src("aaa111");
    const twin = src("eee555", { url: a.url });
    const bad = src("fff666", { url: "javascript:alert(1)" });
    const { cited, more } = splitAnswerSources(
      ["X [src:abcdef] Y [src:aaa111] Z [src:fff666]"],
      registryOf(a, bad),
      [[twin, bad, a]],
    );
    expect(cited.map((s) => s.id)).toEqual(["aaa111"]);
    expect(more).toEqual([]);
  });

  it("resolves a marker against the answer's own runs when the registry lacks it", () => {
    const a = src("aaa111");
    const { cited } = splitAnswerSources(["[src:aaa111]"], new Map(), [[a]]);
    expect(cited.map((s) => s.id)).toEqual(["aaa111"]);
  });

  it("covers every member of a grouped answer", () => {
    const a = src("aaa111");
    const b = src("bbb222");
    const c = src("ccc333");
    const members = [
      ai("m1", "Started [src:bbb222].", [sourcesEvent(a, b)]),
      ai("m2", "Then [src:ccc333] and [src:bbb222].", [sourcesEvent(c)]),
    ];
    const { cited, more } = answerSources(members, registryOf(a, b, c));
    expect(cited.map((s) => s.id)).toEqual(["bbb222", "ccc333"]);
    expect(more.map((s) => s.id)).toEqual(["aaa111"]);
  });
});
