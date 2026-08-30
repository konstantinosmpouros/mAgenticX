import { describe, expect, it } from "vitest";

import {
  ALWAYS_GATED,
  BUILTIN_GROUP,
  countEnabled,
  groupTools,
  toolServerId,
} from "@/features/settings/lib/agentTools";
import type { AgentToolRow } from "@/shared/lib/types";

/**
 * The tool list is grouped by source and each group carries its own tally, so
 * a collapsed group still says whether anything inside it is live. That makes
 * the grouping rules the thing that decides whether the screen reads correctly
 * — pin them here rather than discovering a mis-grouped server in the UI.
 */

const tool = (over: Partial<AgentToolRow> & { key: string }): AgentToolRow => ({
  name: over.key.split("/").pop() ?? over.key,
  description: "",
  source: over.key.includes("/") ? "mcp" : "native",
  declared: true,
  disabled: false,
  ...over,
});

describe("toolServerId", () => {
  it("reads the server from an MCP key", () => {
    expect(toolServerId(tool({ key: "arxiv/search_papers" }))).toBe("arxiv");
  });

  it("returns null for a built-in, which has no server segment", () => {
    expect(toolServerId(tool({ key: "write_file" }))).toBeNull();
  });

  it("splits on the FIRST slash, since a tool name may contain more", () => {
    expect(toolServerId(tool({ key: "gateway/files/read" }))).toBe("gateway");
  });

  it("treats a leading slash as no server rather than an empty one", () => {
    expect(toolServerId(tool({ key: "/orphan" }))).toBeNull();
  });
});

describe("groupTools", () => {
  const rows = [
    tool({ key: "write_file" }),
    tool({ key: "read_file" }),
    tool({ key: "arxiv/search_papers", disabled: true }),
    tool({ key: "arxiv/read_paper" }),
    tool({ key: "tavily/search", disabled: true }),
  ];

  it("puts built-ins first, then servers alphabetically", () => {
    expect(groupTools(rows).map((g) => g.id)).toEqual([BUILTIN_GROUP, "arxiv", "tavily"]);
  });

  it("counts enabled per group, so a collapsed group still informs", () => {
    const [builtin, arxiv, tavily] = groupTools(rows);
    expect([builtin.enabled, builtin.total]).toEqual([2, 2]);
    expect([arxiv.enabled, arxiv.total]).toEqual([1, 2]);
    expect([tavily.enabled, tavily.total]).toEqual([0, 1]);
  });

  it("sorts tools by name inside a group", () => {
    const arxiv = groupTools(rows).find((g) => g.id === "arxiv");
    expect(arxiv?.tools.map((t) => t.name)).toEqual(["read_paper", "search_papers"]);
  });

  it("drops a group whose every tool was filtered out", () => {
    // Only arxiv/read_paper matches, so tavily and the built-ins disappear
    // entirely rather than rendering as empty headers.
    expect(groupTools(rows, { query: "read_paper" }).map((g) => g.id)).toEqual(["arxiv"]);
  });

  it("searches the description as well as the name", () => {
    const described = [tool({ key: "arxiv/x", description: "Fetch a preprint" })];
    expect(groupTools(described, { query: "preprint" })).toHaveLength(1);
    expect(groupTools(described, { query: "nothing" })).toHaveLength(0);
  });

  it("filters to on and off", () => {
    const on = groupTools(rows, { filter: "on" }).flatMap((g) => g.tools.map((t) => t.key));
    const off = groupTools(rows, { filter: "off" }).flatMap((g) => g.tools.map((t) => t.key));
    expect(on).toEqual(["read_file", "write_file", "arxiv/read_paper"]);
    expect(off).toEqual(["arxiv/search_papers", "tavily/search"]);
  });

  it("counts over the whole set, not the filtered view", () => {
    expect(countEnabled(rows)).toEqual({ enabled: 3, total: 5 });
  });
});

describe("ALWAYS_GATED", () => {
  it("matches the server's HITL floor exactly", () => {
    // Mirrors `_HITL_FLOOR` in agents/runtime/abstractions/user_agents.py. The
    // two are coupled with nothing enforcing it, and a mismatch once made every
    // agent save fail validation — so the list is pinned here too.
    expect([...ALWAYS_GATED].sort()).toEqual(
      ["create_skill", "edit_file", "execute", "task", "write_file"].sort(),
    );
  });
});
