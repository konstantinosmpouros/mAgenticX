import { describe, expect, it } from "vitest";

import { layoutVersionGraph, parentOf } from "@/shared/lib/versionHistory";
import type { AgentVersionSummary } from "@/shared/lib/types";

/**
 * The History tab's version graph: each version joined to the one it was
 * saved on top of, newest row first, so two saves on top of one version are
 * two branches that meet at it.
 */
const v = (
  versionNo: number,
  basedOn: number | null,
  kind: AgentVersionSummary["kind"] = "saved",
): AgentVersionSummary => ({
  versionNo,
  kind,
  changes: [],
  restoredFrom: null,
  basedOn,
  current: false,
  createdAt: null,
});

describe("the version graph", () => {
  it("is one straight lane for a plain run of saves", () => {
    const graph = layoutVersionGraph([v(3, 2), v(2, 1), v(1, null, "created")]);
    expect(graph.lanes).toBe(1);
    expect(graph.rows).toEqual([
      { lane: 0, joins: [], through: [], down: true },
      { lane: 0, joins: [0], through: [], down: true },
      { lane: 0, joins: [0], through: [], down: false },
    ]);
  });

  it("draws two saves on top of one version as two branches meeting at it", () => {
    // Version 3 edited (4), restored, edited again (5).
    const graph = layoutVersionGraph([
      v(5, 3),
      v(4, 3),
      v(3, 2),
      v(2, 1),
      v(1, null, "baseline"),
    ]);
    expect(graph.lanes).toBe(2);
    expect(graph.rows[0]).toEqual({ lane: 0, joins: [], through: [], down: true });
    // Version 4 starts a second lane next to the first, which runs past it.
    expect(graph.rows[1]).toEqual({ lane: 1, joins: [], through: [0], down: true });
    // Both end in version 3.
    expect(graph.rows[2]).toEqual({ lane: 0, joins: [0, 1], through: [], down: true });
    expect(graph.rows[3].through).toEqual([]);
  });

  it("follows the row below for versions kept before basedOn, and stops at a pruned one", () => {
    const versions = [v(5, 2), v(4, null, "restored"), v(3, null), v(1, null, "created")];
    expect(parentOf(versions, 0)).toBeNull(); // 2 is no longer kept
    expect(parentOf(versions, 1)).toBe(3);
    expect(parentOf(versions, 3)).toBeNull();
  });

  it("gives each branch its own lane until they meet", () => {
    const graph = layoutVersionGraph([
      v(6, 2),
      v(5, 3),
      v(4, 3),
      v(3, 2),
      v(2, 1),
      v(1, null, "created"),
    ]);
    expect(graph.rows.map((r) => r.lane)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(graph.lanes).toBe(3);
    expect(graph.rows[4].joins).toEqual([0, 1]);
  });
});
