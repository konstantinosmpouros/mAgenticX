// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * The chat's own renderer (Streamdown) carries the citation plugin through its
 * default plugins (GFM, math, raw HTML, harden): pinned that the `mx-citation`
 * element survives that pipeline and becomes the pill, and that a streaming
 * answer holds back a marker that has not closed yet.
 */
import { CitationSourcesContext } from "@/shared/lib/citations-context";
import type { CitationSource } from "@/shared/lib/types";
import { Response } from "@/shared/ui/ai-elements/response";

const A = "3fa2c1";
const registry = new Map<string, CitationSource>([
  [A, { id: A, url: "https://www.example.com/a", title: "A", snippet: "", tool: "tavily-search" }],
]);

describe("Response with citations", () => {
  it("renders a marker as a pill through Streamdown's pipeline", async () => {
    render(
      <CitationSourcesContext.Provider value={registry}>
        <Response citations>{`Revenue grew **12%** [src:${A}]. Invented [src:deadbe].`}</Response>
      </CitationSourcesContext.Provider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open example.com" })).toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain("[src:");
  });

  it("hides an unclosed marker while streaming", async () => {
    render(
      <CitationSourcesContext.Provider value={registry}>
        <Response citations streaming>{`Revenue grew 12% [src:3f`}</Response>
      </CitationSourcesContext.Provider>,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Revenue grew 12%"));
    expect(document.body.textContent).not.toContain("src");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("leaves a person's text as typed", async () => {
    render(
      <CitationSourcesContext.Provider value={registry}>
        <Response>{`Typed [src:${A}]`}</Response>
      </CitationSourcesContext.Provider>,
    );
    await waitFor(() => expect(document.body.textContent).toContain(`Typed [src:${A}]`));
  });
});
