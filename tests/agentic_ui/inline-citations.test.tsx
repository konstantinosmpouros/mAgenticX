// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Inline citations (plan 42), the UI side.
 *
 * Pinned: the source contract rejects non-http URLs and bad ids and drops a
 * bad entry without losing the list; markers parse single, multiple and with
 * spaces, unknown ids are dropped and a marker with no known id renders
 * nothing; markers in inline code and code blocks stay text; an unclosed
 * trailing marker is hidden while streaming; the timeline folds `SOURCES`
 * events live, wrapped in a sub-agent envelope, and on replay; the registry
 * merges the durable list, settled messages, tasks and the live run; Copy
 * numbers citations in order of first appearance with a Sources list; the
 * pill names the host (without www.) plus "+N", and the card's link is
 * http(s) with the safe rel/target.
 */
import {
  hideUnclosedCitationMarker,
  citationHostname,
  replaceCitationMarkers,
} from "@/shared/lib/citations";
import { CitationSourcesContext } from "@/shared/lib/citations-context";
import { CitationSourceSchema, ConversationSourcesSchema } from "@/shared/lib/schemas";
import { transformSharedConversationDetail } from "@/shared/lib/consts";
import type { CitationSource, CitationSourceMap, MessageOut } from "@/shared/lib/types";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { SourceCitation } from "@/shared/ui/ai-elements/inline-citation";
import {
  collectRunSources,
  createTimeline,
  foldTimeline,
  reduceTimelineEvents,
} from "@/features/inference/timeline";
import { buildSourceRegistry, mergeSources } from "@/features/chat/lib/sources";
import { citationsToPlainText } from "@/features/chat/lib/citationText";
import { answerGroupText, groupAnswers } from "@/features/chat/lib/answerGroups";

const source = (id: string, over: Partial<CitationSource> = {}): CitationSource => ({
  id,
  url: `https://www.${id}.example.com/page`,
  title: `Title ${id}`,
  snippet: `Snippet ${id}`,
  tool: "tavily-search",
  ...over,
});

const registryOf = (...sources: CitationSource[]): CitationSourceMap =>
  new Map(sources.map((item) => [item.id, item]));

const sourcesEvent = (sources: unknown[], name = "SOURCES") => ({
  type: "CUSTOM",
  name,
  value: { tool_call_id: "call-1", sources },
});
const subagent = (event: unknown) => ({
  type: "CUSTOM",
  name: "SUBAGENT_EVENT",
  value: { task_id: "t1", namespace: ["tools:abc"], event },
});

const msg = (over: Partial<MessageOut>): MessageOut =>
  ({
    id: Math.random().toString(36),
    sender: "ai",
    created_at: new Date(),
    updated_at: new Date(),
    attachments: [],
    ...over,
  }) as MessageOut;

function renderMarkdown(content: string, registry: CitationSourceMap, streaming = false) {
  return render(
    <CitationSourcesContext.Provider value={registry}>
      <MarkdownRenderer content={content} citations streaming={streaming} />
    </CitationSourcesContext.Provider>,
  );
}

const A = "3fa2c1";
const B = "9b02e4";
const C = "c0ffee";

describe("source contract", () => {
  it("accepts an http(s) source and caps and cleans its text", () => {
    const parsed = CitationSourceSchema.parse({
      id: A,
      url: "https://example.com/a",
      title: `  A\u0000 title\n\twith   space ${"x".repeat(400)}`,
      snippet: null,
      tool: "tavily-search",
    });
    expect(parsed.title.startsWith("A title with space x")).toBe(true);
    expect(parsed.title.length).toBe(300);
    expect(parsed.snippet).toBe("");
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "/relative", "not a url"])(
    "rejects the url %s",
    (url) => {
      expect(CitationSourceSchema.safeParse({ id: A, url, title: "t" }).success).toBe(false);
    },
  );

  it("rejects an id outside the contract", () => {
    expect(CitationSourceSchema.safeParse({ id: "XYZ123", url: "https://a.io" }).success).toBe(false);
    expect(CitationSourceSchema.safeParse({ id: "3fa2c", url: "https://a.io" }).success).toBe(false);
  });

  it("drops a bad entry of the durable list without losing the rest", () => {
    const list = ConversationSourcesSchema.parse({
      sources: [source(A), { id: B, url: "javascript:alert(1)" }, "junk", source(C)],
    });
    expect(list.map((item) => item.id)).toEqual([A, C]);
    expect(ConversationSourcesSchema.parse({})).toEqual([]);
  });

  it("reads a shared snapshot's frozen sources, re-checked", () => {
    const shared = transformSharedConversationDetail({
      token: "t",
      agent: { id: "a", name: "A" },
      messages: [],
      sources: [source(A), { id: B, url: "data:text/html,x" }],
      created_at: new Date().toISOString(),
    });
    expect(shared.sources.map((item) => item.id)).toEqual([A]);
    expect(transformSharedConversationDetail({ token: "t", agent: {}, messages: [] }).sources).toEqual([]);
  });
});

describe("marker helpers", () => {
  it("names the host without www.", () => {
    expect(citationHostname("https://www.Example.com/x?y=1")).toBe("example.com");
    expect(citationHostname("nope")).toBe("");
  });

  it("hides an unclosed trailing marker while streaming", () => {
    expect(hideUnclosedCitationMarker("Revenue grew 12% [src:3fa")).toBe("Revenue grew 12%");
    expect(hideUnclosedCitationMarker("Revenue grew [")).toBe("Revenue grew");
    expect(hideUnclosedCitationMarker("Revenue [src:3fa2c1, 9b")).toBe("Revenue");
    expect(hideUnclosedCitationMarker("Closed [src:3fa2c1]")).toBe("Closed [src:3fa2c1]");
    expect(hideUnclosedCitationMarker("a [see the docs")).toBe("a [see the docs");
    // Inside code it is not a marker.
    expect(hideUnclosedCitationMarker("```js\nconst a = [src:3f")).toBe("```js\nconst a = [src:3f");
    expect(hideUnclosedCitationMarker("call `fn([src:3f")).toBe("call `fn([src:3f");
  });

  it("replaces markers outside code only", () => {
    const text = "One [src:3fa2c1]. `[src:9b02e4]`\n```\n[src:c0ffee]\n```\nTwo [src: 3fa2c1 , 9b02e4 ].";
    const out = replaceCitationMarkers(text, (ids) => `<${ids.join("|")}>`);
    expect(out).toBe("One<3fa2c1>. `[src:9b02e4]`\n```\n[src:c0ffee]\n```\nTwo<3fa2c1|9b02e4>.");
  });
});

describe("remarkCitations in the markdown renderer", () => {
  const registry = registryOf(source(A), source(B), source(C, { url: "https://c.example.org/" }));

  it("renders a single marker as a pill named after the host", () => {
    renderMarkdown(`Revenue grew 12% [src:${A}].`, registry);
    const pill = screen.getByRole("link", { name: `Open ${A}.example.com` });
    // A click on the pill opens the page.
    expect(pill).toHaveAttribute("href", `https://www.${A}.example.com/page`);
    expect(pill).toHaveAttribute("target", "_blank");
    expect(pill).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(pill).toHaveTextContent(`${A}.example.com`);
    expect(screen.queryByText(/\[src:/)).toBeNull();
    // The whitespace before the marker goes with it: the pill brings its gap.
    expect(pill.closest("p")?.textContent).toBe(`Revenue grew 12%${A}.example.com.`);
  });

  it("renders several ids as one pill with +N, spaces allowed", () => {
    renderMarkdown(`Both agree [src: ${A} , ${B},${C} ].`, registry);
    const pill = screen.getByRole("link", { name: /^Open / });
    expect(pill).toHaveTextContent(`${A}.example.com+2`);
  });

  it("drops unknown ids and renders nothing when none is known", () => {
    renderMarkdown(`Known [src:${A},deadbe]. Invented [src:deadbe].`, registry);
    const pills = screen.getAllByRole("link", { name: /^Open / });
    expect(pills).toHaveLength(1);
    expect(pills[0]).toHaveTextContent(`${A}.example.com`);
    expect(pills[0]).not.toHaveTextContent("+");
    expect(document.body.textContent).not.toContain("[src:");
    expect(document.body.textContent).toContain("Invented.");
  });

  it("renders nothing for a marker outside any provider", () => {
    render(<MarkdownRenderer content={`Fact [src:${A}].`} citations />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).toBe("Fact.");
  });

  it("leaves markers in inline code and code blocks untouched", () => {
    renderMarkdown(`Use \`[src:${A}]\` like this:\n\n\`\`\`\n[src:${B}]\n\`\`\``, registry);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(`[src:${A}]`)).toBeInTheDocument();
    expect(document.body.textContent).toContain(`[src:${B}]`);
  });

  it("hides an unclosed trailing marker while streaming", () => {
    renderMarkdown(`Revenue grew 12% [src:3fa`, registry, true);
    expect(document.body.textContent).toBe("Revenue grew 12%");
  });

  it("keeps the text verbatim when citations are off", () => {
    render(
      <CitationSourcesContext.Provider value={registry}>
        <MarkdownRenderer content={`Typed [src:${A}]`} />
      </CitationSourcesContext.Provider>,
    );
    expect(document.body.textContent).toBe(`Typed [src:${A}]`);
  });
});

describe("the citation card", () => {
  it("opens with title, safe link and snippet, and pages through several sources", () => {
    const registry = registryOf(
      source(A, { title: "<b>Not HTML</b>" }),
      source(B, { url: "https://b.example.net/x" }),
    );
    render(
      <CitationSourcesContext.Provider value={registry}>
        <SourceCitation ids={[A, B]} />
      </CitationSourcesContext.Provider>,
    );
    // Hover (or keyboard focus) shows the card.
    vi.useFakeTimers();
    fireEvent.focus(screen.getByRole("link", { name: /^Open / }));
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();

    const card = screen.getByRole("group", { name: "1 of 2" });
    expect(within(card).getByText("<b>Not HTML</b>")).toBeInTheDocument();
    const link = within(card).getByRole("link");
    expect(link).toHaveAttribute("href", `https://www.${A}.example.com/page`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(within(card).getByText(`Snippet ${A}`)).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous source" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next source" }));
    const second = screen.getByRole("group", { name: "2 of 2" });
    expect(within(second).getByRole("link")).toHaveAttribute("href", "https://b.example.net/x");
    expect(screen.getByRole("button", { name: "Next source" })).toBeDisabled();
  });

  it("closes the card and lets go of focus when the pill is clicked", () => {
    render(
      <CitationSourcesContext.Provider value={registryOf(source(A))}>
        <SourceCitation ids={[A]} />
      </CitationSourcesContext.Provider>,
    );
    const pill = screen.getByRole("link", { name: /^Open / });
    vi.useFakeTimers();
    pill.focus();
    fireEvent.focus(pill);
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector('[aria-roledescription="slide"]')).not.toBeNull();

    fireEvent.click(pill);
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();
    expect(document.activeElement).not.toBe(pill);
    expect(document.querySelector('[aria-roledescription="slide"]')).toBeNull();
  });

  it("never links a source whose url is not http(s)", () => {
    const bad = { ...source(A), url: "javascript:alert(1)" } as CitationSource;
    render(
      <CitationSourcesContext.Provider value={registryOf(bad)}>
        <SourceCitation ids={[A]} />
      </CitationSourcesContext.Provider>,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("SOURCES in the run timeline", () => {
  it("folds a live event, a sub-agent's wrapped one, and drops bad entries", () => {
    let timeline = reduceTimelineEvents(createTimeline(), [
      sourcesEvent([source(A), { id: B, url: "javascript:x" }]),
    ]);
    expect(Object.keys(timeline.sources ?? {})).toEqual([A]);
    const before = timeline.sources;
    timeline = reduceTimelineEvents(timeline, [
      { type: "CUSTOM", name: "TASK_SUBAGENT", value: { task_id: "t1", subagent_type: "researcher", description: "d" } },
      subagent(sourcesEvent([source(C)])),
    ]);
    expect(Object.keys(timeline.sources ?? {}).sort()).toEqual([A, C].sort());
    // Copy-on-write: the earlier map is untouched.
    expect(Object.keys(before ?? {})).toEqual([A]);
  });

  it("replays the same sources from a persisted log", () => {
    const events = [
      { type: "TEXT_MESSAGE_CONTENT", delta: `Fact [src:${A}].` },
      sourcesEvent([source(A)], "sources"),
      subagent(sourcesEvent([source(B)])),
    ];
    const replayed = foldTimeline(events, { status: "completed" });
    expect(Object.keys(replayed.sources ?? {}).sort()).toEqual([A, B].sort());
    expect(collectRunSources(events)).toEqual(replayed.sources);
  });
});

describe("source registry", () => {
  it("merges the durable list, settled messages, tasks and the live run", () => {
    const registry = buildSourceRegistry({
      durable: [source(A, { title: "durable" })],
      messages: [msg({ rawEvents: [subagent(sourcesEvent([source(B)]))] as never })],
      timelines: [
        { sources: { [C]: source(C) } },
        { sources: { [A]: source(A, { title: "live" }) } },
      ],
    });
    expect([...registry.keys()].sort()).toEqual([A, B, C].sort());
    expect(registry.get(A)?.title).toBe("live");
  });

  it("merges lists and records alike", () => {
    expect([...mergeSources([source(A)], { [B]: source(B) }, null).keys()]).toEqual([A, B]);
  });
});

describe("citations as plain text", () => {
  const registry = registryOf(source(A), source(B, { title: "" }));

  it("numbers sources by first appearance and lists them", () => {
    const text = `One [src:${B}]. Two [src:${A},${B}]. Three [src:${B}].`;
    expect(citationsToPlainText(text, registry)).toBe(
      `One [1]. Two [2, 1]. Three [1].\n\nSources:\n1. https://www.${B}.example.com/page\n2. Title ${A} — https://www.${A}.example.com/page`,
    );
  });

  it("removes unknown ids and markers, and leaves code alone", () => {
    const text = `Made up [src:deadbe]. Mixed [src:deadbe,${A}]. \`[src:${A}]\``;
    expect(citationsToPlainText(text, registry)).toBe(
      `Made up. Mixed [1]. \`[src:${A}]\`\n\nSources:\n1. Title ${A} — https://www.${A}.example.com/page`,
    );
    expect(citationsToPlainText("No citations here.", registry)).toBe("No citations here.");
  });

  it("numbers across a whole answer group on Copy", () => {
    const messages = [
      msg({ id: "u", sender: "user", content: "q" }),
      msg({ id: "a1", content: `First [src:${A}].` }),
      msg({ id: "n", sender: "user", kind: "task_notification", content: "" }),
      msg({ id: "a2", content: `Then [src:${B}] and [src:${A}].` }),
    ];
    const group = groupAnswers(messages).get("a2")!.group;
    expect(answerGroupText(group, registry)).toBe(
      `First [1].\n\nThen [2] and [1].\n\nSources:\n1. Title ${A} — https://www.${A}.example.com/page\n2. https://www.${B}.example.com/page`,
    );
  });
});
