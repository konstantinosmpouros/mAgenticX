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

import { TOOL_PRESENTATION, toolIcon, toolIsBare, toolLabel } from "@/shared/lib/consts";

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

describe("icons", () => {
  it("gives every builtin verb a glyph of its own", () => {
    // A column of identical wrenches gives the eye nothing to scan by.
    for (const name of [
      "read_file",
      "ls",
      "grep",
      "glob",
      "write_file",
      "edit_file",
      "execute",
      "remember",
      "forget",
      "search_past_conversations",
      "view_image",
    ]) {
      expect(toolIcon(name), `${name} should have an icon`).toBeTruthy();
    }
  });

  it("shares one glyph across tools that do the same kind of thing", () => {
    // Scanning is by action, not by name: two searches, two writes, three
    // memory verbs.
    expect(toolIcon("glob")).toBe(toolIcon("grep"));
    expect(toolIcon("edit_file")).toBe(toolIcon("write_file"));
    expect(toolIcon("forget")).toBe(toolIcon("remember"));
    expect(toolIcon("search_past_conversations")).toBe(toolIcon("remember"));
  });

  it("leaves an unlisted tool without one, so the caller keeps its default", () => {
    expect(toolIcon("write_todos")).toBeUndefined();
    expect(toolIcon("tavily/tavily-search")).toBeUndefined();
  });
});

describe("the map itself", () => {
  it("lets each field stand alone", () => {
    // An icon-only entry needs no label: `toolLabel` already falls back to the
    // tool's own name, so repeating it here would be noise that can drift.
    for (const [name, presentation] of Object.entries(TOOL_PRESENTATION)) {
      const hasSomething =
        presentation.label !== undefined ||
        presentation.bare !== undefined ||
        presentation.icon !== undefined;
      expect(hasSomething, `${name} entry does nothing`).toBe(true);
    }
  });
});
