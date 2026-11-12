// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { parseEvictedToolResult } from "@/shared/lib/evictedToolResult";
import { ToolOutput } from "@/shared/ui/ai-elements/tool";

vi.mock("@/shared/ui/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}));

/**
 * A tool result too large for the context is saved to a file by deepagents and
 * replaced by a note for the model. The tool card shows where it went and the
 * preview, not the note's instructions.
 */

// The note exactly as deepagents 0.7 writes it (middleware/_message_eviction.py).
const NOTE = `Tool result too large, the result of this tool call call_NPQxY7 was saved in the filesystem at this path: /large_tool_results/call_NPQxY7

You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.

You can do this by specifying an offset and limit in the read_file tool call. For example, to read the first 100 lines, you can use the read_file tool with offset=0 and limit=100.

Here is a preview showing the head and tail of the result (lines of the form \`... [N lines truncated] ...\` indicate omitted lines in the middle of the content):

Detailed Results:
[src:3fa2c1] Title: Greek government-debt crisis
... [40 lines truncated] ...
Content: the end
`;

describe("an evicted tool result", () => {
  it("is read as its path and preview", () => {
    expect(parseEvictedToolResult(NOTE)).toEqual({
      path: "/large_tool_results/call_NPQxY7",
      preview:
        "Detailed Results:\n[src:3fa2c1] Title: Greek government-debt crisis\n... [40 lines truncated] ...\nContent: the end",
    });
  });

  it("leaves any other text alone", () => {
    expect(parseEvictedToolResult("Detailed Results:\nTitle: x")).toBeNull();
    expect(parseEvictedToolResult("")).toBeNull();
  });

  it("has no preview when the note has none", () => {
    const head = NOTE.split("\n\nHere is a preview")[0];
    expect(parseEvictedToolResult(head)).toEqual({ path: "/large_tool_results/call_NPQxY7", preview: "" });
  });

  it("renders the path and the preview, without the model's instructions", () => {
    render(<ToolOutput output={NOTE} errorText={undefined} />);
    expect(screen.getByText("/large_tool_results/call_NPQxY7")).toBeTruthy();
    expect(screen.getByTestId("code").textContent).toContain("Title: Greek government-debt crisis");
    expect(screen.queryByText(/read_file tool/)).toBeNull();
  });
});
