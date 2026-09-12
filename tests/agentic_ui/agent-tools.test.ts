import { describe, expect, it } from "vitest";

import {
  countEnabled,
  groupTools,
  isToolLocked,
  isToolOn,
  matchesToolQuery,
  passesToolFilter,
} from "@/features/settings/lib/agentTools";
import type { AgentToolRow } from "@/shared/lib/types";

/**
 * The Agents tab shows two kinds of tool and two independent switches, and the
 * same list renders every combination.
 *
 * **Kinds.** A prebuilt tool is constructed by the framework downstream of the
 * tool list the runtime is handed, so nothing stored could switch it off — only
 * its approval is configurable. An MCP tool is configurable on both axes.
 *
 * **Axes.** Availability and approval are independent facts about one row, so
 * every helper takes the axis it reports on. Reading the wrong field gives a
 * switch that shows one thing and writes the other, which is invisible from the
 * screen until someone notices the agent behaving differently from its settings.
 *
 * The floor used to be a hardcoded name list here, mirroring the server with
 * nothing enforcing the match — a gate present there but missing here once made
 * every agent save fail. The server reports it per row now.
 */

const tool = (over: Partial<AgentToolRow> & { key: string }): AgentToolRow => ({
  name: over.key.split("/").pop() ?? over.key,
  description: "",
  kind: over.key.includes("/") ? "mcp" : "builtin",
  group: over.key.includes("/") ? (over.key.split("/")[0] ?? "mcp") : "Filesystem",
  declared: true,
  available: true,
  unavailableReason: null,
  enabled: true,
  approval: false,
  approvalLocked: false,
  ...over,
});

describe("axes", () => {
  it("reads availability on the enable axis", () => {
    expect(isToolOn(tool({ key: "rag/a", enabled: true }), "enable")).toBe(true);
    expect(isToolOn(tool({ key: "rag/a", enabled: false }), "enable")).toBe(false);
  });

  it("reads the gate on the approval axis", () => {
    expect(isToolOn(tool({ key: "rag/a", approval: true }), "approval")).toBe(true);
    expect(isToolOn(tool({ key: "rag/a", approval: false }), "approval")).toBe(false);
  });

  it("defaults to the enable axis", () => {
    // Existing callers pass no axis and must keep meaning availability.
    expect(isToolOn(tool({ key: "rag/a", enabled: false }))).toBe(false);
  });

  it("treats the two axes as independent", () => {
    // "Give this agent the tool, but ask me first" is a real state.
    const both = tool({ key: "arxiv/download_paper", enabled: true, approval: true });
    expect(isToolOn(both, "enable")).toBe(true);
    expect(isToolOn(both, "approval")).toBe(true);
  });
});

describe("locks", () => {
  it("locks a prebuilt tool on the enable axis only", () => {
    // Its approval is still the user's to set.
    const builtin = tool({ key: "write_file", kind: "builtin" });
    expect(isToolLocked(builtin, "enable")).toBe(true);
    expect(isToolLocked(builtin, "approval")).toBe(false);
  });

  it("locks a mandated gate on the approval axis only", () => {
    const locked = tool({ key: "execute", kind: "builtin", approvalLocked: true });
    expect(isToolLocked(locked, "approval")).toBe(true);
  });

  it("never locks an MCP tool on the enable axis", () => {
    expect(isToolLocked(tool({ key: "rag/a" }), "enable")).toBe(false);
  });
});

describe("filtering", () => {
  it("filters on the axis being shown", () => {
    // A row that differs between axes proves the filter is not reading one
    // field twice.
    const gatedButOff = tool({ key: "rag/x", enabled: false, approval: true });
    expect(passesToolFilter(gatedButOff, "on", "enable")).toBe(false);
    expect(passesToolFilter(gatedButOff, "on", "approval")).toBe(true);
  });

  it("passes everything on 'all'", () => {
    expect(passesToolFilter(tool({ key: "rag/x", enabled: false }), "all")).toBe(true);
  });

  it("matches name and description, case-insensitively", () => {
    const row = tool({ key: "rag/sql_query", description: "Runs a READ-ONLY query" });
    expect(matchesToolQuery(row, "SQL")).toBe(true);
    expect(matchesToolQuery(row, "read-only")).toBe(true);
    expect(matchesToolQuery(row, "nope")).toBe(false);
    expect(matchesToolQuery(row, "  ")).toBe(true);
  });
});

describe("grouping", () => {
  const rows = [
    tool({ key: "arxiv/search_papers" }),
    tool({ key: "write_file", kind: "builtin", group: "Filesystem" }),
    tool({ key: "task", kind: "builtin", group: "Delegation" }),
    tool({ key: "rag/sql_query" }),
  ];

  it("puts prebuilt families before MCP servers", () => {
    const groups = groupTools(rows);
    expect(groups.map((g) => g.id)).toEqual(["Delegation", "Filesystem", "arxiv", "rag"]);
    expect(groups.filter((g) => g.builtin).map((g) => g.id)).toEqual([
      "Delegation",
      "Filesystem",
    ]);
  });

  it("groups MCP tools by their server", () => {
    const arxiv = groupTools(rows).find((g) => g.id === "arxiv");
    expect(arxiv?.tools.map((t) => t.name)).toEqual(["search_papers"]);
    expect(arxiv?.builtin).toBe(false);
  });

  it("counts on the axis being shown", () => {
    const mixed = [
      tool({ key: "rag/a", enabled: true, approval: false }),
      tool({ key: "rag/b", enabled: true, approval: true }),
    ];
    const [byEnable] = groupTools(mixed, { axis: "enable" });
    const [byApproval] = groupTools(mixed, { axis: "approval" });
    expect(byEnable.enabled).toBe(2);
    expect(byApproval.enabled).toBe(1);
  });

  it("drops a group whose every tool was filtered out", () => {
    // A server with nothing on screen is noise, not information.
    const groups = groupTools(rows, { query: "search_papers" });
    expect(groups.map((g) => g.id)).toEqual(["arxiv"]);
  });
});

describe("countEnabled", () => {
  const rows = [
    tool({ key: "rag/a", enabled: true, approval: true }),
    tool({ key: "rag/b", enabled: false, approval: false }),
    tool({ key: "write_file", kind: "builtin", enabled: true, approval: true }),
  ];

  it("tallies the axis being shown, over the unfiltered set", () => {
    expect(countEnabled(rows, "enable")).toEqual({ enabled: 2, total: 3 });
    expect(countEnabled(rows, "approval")).toEqual({ enabled: 2, total: 3 });
  });

  it("defaults to the enable axis", () => {
    expect(countEnabled(rows).enabled).toBe(2);
  });
});
