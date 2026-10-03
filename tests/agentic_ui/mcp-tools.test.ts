import { describe, expect, it } from "vitest";

import {
  arxivAbsUrl,
  authorLine,
  extractJsonString,
  mcpMeta,
  mcpServerTitle,
  parseDownload,
  parsePaperContent,
  parsePapers,
  parseTavilyPages,
  parseTavilyResults,
  plainSnippet,
  safeHttpUrl,
  salvageJsonArray,
} from "@/features/chat/lib/mcpToolPresentation";

import { MCP_RESULTS } from "./fixtures/mcpToolResults";

/**
 * MCP tool steps (Tavily, arXiv): every parser here runs on **real outputs**
 * captured from local runs. Two properties matter most: a result cut at the
 * bridge's 16,000-character limit still yields what decodes (never a wall of
 * escaped JSON), and untrusted links are refused unless they are http(s).
 */

describe("server names", () => {
  it.each([
    ["tavily", "Tavily"],
    ["arxiv", "arXiv"],
    ["arxiv-mcp-server", "arXiv"],
    ["brave", "Brave"],
  ])("%s → %s", (id, title) => {
    expect(mcpServerTitle(id)).toBe(title);
  });
});

describe("tavily-search", () => {
  it("reads Title / URL / Content blocks, multi-line content included", () => {
    const results = parseTavilyResults(MCP_RESULTS.search)!;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("The Future of Large Language Models");
    expect(results[0].url).toBe("https://aimultiple.com/future-of-large-language-models");
    expect(results[0].content).toContain("## Limitations of large language models");
  });

  it("titles the step with the query and the result count", () => {
    // A query with its own quotes is not wrapped in a second pair.
    expect(mcpMeta("tavily-search", { query: '"large language models" OR "AI agents"' }, MCP_RESULTS.search)).toMatch(
      /^"large language models" OR "AI agents" · \d+ results?$/,
    );
    expect(mcpMeta("tavily-search", { query: "rust async" }, undefined)).toBe('"rust async"');
  });

  it("strips markdown for the card snippet", () => {
    expect(plainSnippet("## Heading\n\n**bold** [link](https://x.com) ![img](https://x.com/a.png)")).toBe(
      "Heading bold link",
    );
  });
});

describe("tavily-extract", () => {
  it("drops `Content: undefined` in favour of Raw Content", () => {
    const [page] = parseTavilyResults(MCP_RESULTS.extract)!;
    expect(page.title).toBe("Example Domain");
    expect(page.content).not.toBe("undefined");
    expect(page.content).toContain("This domain is for use in documentation examples");
  });

  it("puts the host in the meta", () => {
    expect(mcpMeta("tavily-extract", { urls: ["https://example.com"] }, MCP_RESULTS.extract)).toBe("example.com");
    expect(mcpMeta("tavily-extract", { urls: ["https://a.com/x", "https://b.com"] }, undefined)).toBe("a.com/x +1");
  });
});

describe("tavily-crawl / tavily-map", () => {
  it("reads crawled pages with their content", () => {
    const crawl = parseTavilyPages(MCP_RESULTS.crawl)!;
    expect(crawl.base).toBe("https://docs.python.org/3/");
    expect(crawl.pages[0].url).toBe("https://docs.python.org/3/index.html");
    expect(crawl.pages[0].content).toContain("Global module index");
  });

  it("reads an empty map", () => {
    expect(parseTavilyPages(MCP_RESULTS.mapEmpty)).toEqual({ base: "https://example.com", pages: [] });
    expect(mcpMeta("tavily-map", { url: "https://example.com" }, MCP_RESULTS.mapEmpty)).toBe("example.com · 0 pages");
  });

  it("reads mapped URLs, numbered or bare", () => {
    const text = "Site Map Results:\nBase URL: https://x.com\n\nMapped Pages:\nhttps://x.com/a\n[2] URL: https://x.com/b";
    expect(parseTavilyPages(text)?.pages.map((p) => p.url)).toEqual(["https://x.com/a", "https://x.com/b"]);
  });
});

describe("arXiv", () => {
  it("search_papers: paper cards with an abstract-page link", () => {
    const [paper] = parsePapers(MCP_RESULTS.searchPapers)!;
    expect(paper.title).toBe("Attention Is All You Need");
    expect(paper.published).toBe("2017-06-12");
    expect(paper.categories).toEqual(["cs.CL", "cs.LG"]);
    expect(paper.url).toBe("https://arxiv.org/abs/1706.03762v7");
    expect(authorLine(paper.authors)).toBe("Ashish Vaswani, Noam Shazeer, Niki Parmar et al.");
  });

  it("list_papers: `summary` and `links` map onto the same card", () => {
    const [paper] = parsePapers(MCP_RESULTS.listPapers)!;
    expect(paper.abstract).toContain("dominant sequence transduction");
    expect(paper.url).toBe("https://arxiv.org/abs/1706.03762v7");
    expect(mcpMeta("list_papers", {}, MCP_RESULTS.listPapers)).toBe("1 paper");
  });

  it("salvages the complete papers from a result cut mid-array", () => {
    const cut = '{"total": 3, "papers": [{"title": "A"}, {"title": "B"}, {"title": "C", "abstr';
    expect(salvageJsonArray(cut, "papers")?.map((p) => p.title)).toEqual(["A", "B"]);
  });

  it("download_paper: status + PDF link, never the gateway's file:// path", () => {
    const download = parseDownload(MCP_RESULTS.download)!;
    expect(download.status).toBe("converting");
    expect(download.pdf).toBe("https://arxiv.org/pdf/1706.03762.pdf");
    expect(JSON.stringify(download)).not.toContain("file://");
    expect(mcpMeta("download_paper", { paper_id: "1706.03762" }, MCP_RESULTS.download)).toBe("1706.03762");
  });

  it("read_paper: decodes the content even though the JSON was cut", () => {
    const paper = parsePaperContent(MCP_RESULTS.readPaperCut)!;
    expect(paper.status).toBe("success");
    expect(paper.content).toContain("Google hereby grants permission");
    expect(paper.content).toContain("\n"); // real line breaks…
    expect(paper.content).not.toContain("\\n"); // …not escaped ones
  });
});

describe("tolerant JSON strings", () => {
  it("drops a dangling escape left by the cut", () => {
    expect(extractJsonString('{"status": "ok", "content": "line one\\nline tw\\', "content")).toBe("line one\nline tw");
    expect(extractJsonString('{"content": "star \\u22', "content")).toBe("star ");
  });

  it("stops at the closing quote of an intact value", () => {
    expect(extractJsonString('{"a": 1, "content": "x \\"q\\" y", "b": 2', "content")).toBe('x "q" y');
  });
});

describe("safety", () => {
  it.each([
    ["https://example.com/a", "https://example.com/a"],
    ["http://example.com", "http://example.com/"],
    ["javascript:alert(1)", null],
    ["file:///app/papers/1706.03762.md", null],
    ["data:text/html,<script>", null],
    ["not a url", null],
  ])("%s → %s", (value, expected) => {
    expect(safeHttpUrl(value)).toBe(expected);
  });

  it("does not turn an unsafe link into an arXiv link", () => {
    expect(arxivAbsUrl("javascript:alert(1)")).toBeNull();
  });
});
