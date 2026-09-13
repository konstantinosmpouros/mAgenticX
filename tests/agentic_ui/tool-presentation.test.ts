/**
 * How a tool call is presented in the chain of thought.
 *
 * `view_image` is shown as a labelled card holding only the picture — no raw
 * tool name, no Parameters pane, no "Result" heading. Every other tool keeps
 * the generic treatment, which is the property worth pinning: the map must be
 * opt-in, so adding a tool to the backend never needs a frontend change to
 * render at all.
 */
import { describe, expect, it } from "vitest";

import { TOOL_PRESENTATION, toolIsBare, toolLabel } from "@/shared/lib/consts";

describe("tool labels", () => {
  it("gives view_image a human label", () => {
    expect(toolLabel("view_image")).toBe("View image");
  });

  it("falls back to the raw name for anything unlisted", () => {
    expect(toolLabel("tavily/tavily-search")).toBe("tavily/tavily-search");
    expect(toolLabel("write_file")).toBe("write_file");
    expect(toolLabel("")).toBe("");
  });
});

describe("bare presentation", () => {
  it("strips the scaffolding from view_image", () => {
    expect(toolIsBare("view_image")).toBe(true);
  });

  it("leaves every other tool generic", () => {
    // read_file can also return an image, but its args (path, offset, limit)
    // are worth reading — only view_image is bare.
    for (const name of ["read_file", "write_file", "render_chart", "forget"]) {
      expect(toolIsBare(name)).toBe(false);
    }
  });

  it("does not treat a missing entry as bare", () => {
    expect(toolIsBare("nonexistent_tool")).toBe(false);
    // Guards against a prototype key being read off the record.
    expect(toolIsBare("constructor")).toBe(false);
    expect(toolLabel("toString")).toBe("toString");
  });
});

describe("the map itself", () => {
  it("gives every entry a label", () => {
    for (const [name, presentation] of Object.entries(TOOL_PRESENTATION)) {
      expect(presentation.label, `${name} needs a label`).toBeTruthy();
    }
  });
});
