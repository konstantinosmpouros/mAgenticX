import { describe, expect, it } from "vitest";

import { DIAGRAM_PENDING_TEXT, prepareStreamingMarkdown } from "@/shared/lib/streaming-markdown";

/**
 * A ```mermaid block still being written would render Mermaid's parse error on
 * every chunk. Pinned: while streaming it is held back as "Generating diagram…";
 * in a finished answer (a run stopped mid-diagram) it is plain code, not an
 * error box; a closed diagram, any other open fence, and text with no fence at
 * all pass through untouched.
 */

const pending = `*${DIAGRAM_PENDING_TEXT}*`;

describe("prepareStreamingMarkdown", () => {
  it("leaves text without fences untouched", () => {
    expect(prepareStreamingMarkdown("just **text**", true)).toBe("just **text**");
  });

  it("holds back an open mermaid block while streaming", () => {
    const md = "Here is the flow:\n\n```mermaid\nflowchart LR\n  A -->";
    expect(prepareStreamingMarkdown(md, true)).toBe(`Here is the flow:\n\n${pending}\n`);
  });

  it("shows a stopped diagram as plain code once the answer has finished", () => {
    const md = "Flow:\n```mermaid\nflowchart LR\n  A -->";
    expect(prepareStreamingMarkdown(md, false)).toBe(
      "Flow:\n```text\nflowchart LR\n  A -->\n```\n",
    );
  });

  it("passes a closed diagram through, even while streaming", () => {
    const md = "```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.";
    expect(prepareStreamingMarkdown(md, true)).toBe(md);
  });

  it("only holds back the open block, keeping an earlier closed diagram", () => {
    const md = "```mermaid\nflowchart LR\n  A --> B\n```\n\nNext:\n```mermaid\nsequenceDiagram";
    expect(prepareStreamingMarkdown(md, true)).toBe(
      `\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\nNext:\n\n${pending}\n`,
    );
  });

  it("leaves an open fence of another language alone", () => {
    const md = "```python\nprint('hi')";
    expect(prepareStreamingMarkdown(md, true)).toBe(md);
  });

  it("matches the info string case-insensitively and ignores attributes after it", () => {
    expect(prepareStreamingMarkdown("~~~Mermaid title\ngraph TD", true)).toBe(`\n\n${pending}\n`);
  });

  it("does not close a fence with a shorter or different marker", () => {
    const md = "````mermaid\ngraph TD\n```\n  A --> B";
    expect(prepareStreamingMarkdown(md, true)).toBe(`\n\n${pending}\n`);
  });
});
