import { describe, expect, it } from "vitest";

import {
  compareWorkflowSpecs,
  isEmptyWorkflowComparison,
  isLayoutOnlyComparison,
  previewValue,
  stableJson,
  toGraphVersions,
  workflowVersionKindLabel,
  workflowVersionSummary,
} from "@/features/workflows/lib/workflowHistory";
import { layoutVersionGraph } from "@/shared/lib/versionHistory";
import { WorkflowVersionDetailSchema, WorkflowVersionPageSchema } from "@/shared/lib/schemas";
import type { WorkflowSpec, WorkflowVersionSummary } from "@/shared/lib/types";

/**
 * A workflow's History, as data: what one version changed against another
 * (diffed on the client from the two specs), the rows' one-line summaries,
 * the version graph's straight lane, and the API contract the panel reads.
 */

const base = (): WorkflowSpec => ({
  version: 1,
  name: "Poller",
  description: "Polls a job",
  inputs: [{ name: "job_url", type: "string", required: true }],
  state: [{ name: "attempts", type: "number", reducer: "overwrite", default: 0 }],
  nodes: [
    { id: "start", kind: "trigger.manual", label: "Run now", config: {}, position: { x: 0, y: 0 } },
    {
      id: "poll",
      kind: "fetch",
      label: "Poll the job",
      config: { method: "GET", url: "{{input.job_url}}" },
      position: { x: 240, y: 0 },
    },
    { id: "done", kind: "end", label: null, config: {}, position: { x: 480, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "poll", branch: null },
    { id: "e2", source: "poll", target: "done", branch: null },
  ],
});

const summary = (over: Partial<WorkflowVersionSummary>): WorkflowVersionSummary => ({
  versionNo: 1,
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "u1",
  restoredFrom: null,
  name: "Poller",
  description: "",
  nodeCount: 3,
  edgeCount: 2,
  ...over,
});

describe("compareWorkflowSpecs", () => {
  it("finds nothing between a spec and itself", () => {
    const c = compareWorkflowSpecs(base(), base());
    expect(isEmptyWorkflowComparison(c)).toBe(true);
  });

  it("reports the name and description side by side", () => {
    const after = { ...base(), name: "Job poller", description: "" };
    expect(compareWorkflowSpecs(base(), after).fields).toEqual([
      { label: "Name", before: "Poller", after: "Job poller" },
      { label: "Description", before: "Polls a job", after: "" },
    ]);
  });

  it("reports steps added and removed, and the connections that came and went with them", () => {
    const after = base();
    after.nodes = after.nodes.filter((n) => n.id !== "done");
    after.nodes.push({ id: "wait", kind: "wait", label: "Pause", config: { seconds: 5 }, position: { x: 1, y: 1 } });
    after.edges = [after.edges[0], { id: "e3", source: "poll", target: "wait", branch: null }];
    const c = compareWorkflowSpecs(base(), after);
    expect(c.steps.added.map((s) => s.label)).toEqual(["Pause"]);
    expect(c.steps.removed.map((s) => s.label)).toEqual(["done"]);
    expect(c.connections.added.map((e) => e.label)).toEqual(["Poll the job → Pause"]);
    expect(c.connections.removed.map((e) => e.label)).toEqual(["Poll the job → done"]);
  });

  it("calls a new label a rename, and a new id with the same kind and settings one too, following its connections", () => {
    const after = base();
    after.nodes[0] = { ...after.nodes[0], label: "Start here" };
    after.nodes[1] = { ...after.nodes[1], id: "check" };
    after.edges = [
      { id: "e1", source: "start", target: "check", branch: null },
      { id: "e2", source: "check", target: "done", branch: null },
    ];
    const c = compareWorkflowSpecs(base(), after);
    expect(c.steps.added).toEqual([]);
    expect(c.steps.removed).toEqual([]);
    expect(c.steps.renamed).toEqual(
      expect.arrayContaining([
        { id: "start", from: "Run now", to: "Start here" },
        { id: "check", from: "Poll the job", to: "Poll the job" },
      ]),
    );
    // The renamed step's connections are the same connections.
    expect(c.connections.added).toEqual([]);
    expect(c.connections.removed).toEqual([]);
  });

  it("lists each changed setting before → after, and a branch on a connection", () => {
    const after = base();
    after.nodes[1] = { ...after.nodes[1], config: { method: "POST", url: "{{input.job_url}}", body: { a: 1 } } };
    after.edges[1] = { ...after.edges[1], branch: "true" };
    const c = compareWorkflowSpecs(base(), after);
    expect(c.steps.changed).toEqual([
      {
        id: "poll",
        label: "Poll the job",
        kind: expect.any(String),
        settings: [
          { key: "body", before: "", after: '{"a":1}' },
          { key: "method", before: "GET", after: "POST" },
        ],
      },
    ]);
    expect(c.connections.added).toEqual([
      expect.objectContaining({ label: "Poll the job → done", detail: "true" }),
    ]);
    expect(c.connections.removed).toEqual([expect.objectContaining({ label: "Poll the job → done" })]);
  });

  it("reports inputs and variables added, removed and changed", () => {
    const after = base();
    after.inputs = [{ name: "job_url", type: "string" }, { name: "token", type: "string", default: "" }];
    after.state = [{ name: "statuses", type: "array", reducer: "append" }];
    const c = compareWorkflowSpecs(base(), after);
    expect(c.inputs.added.map((i) => i.label)).toEqual(["token"]);
    expect(c.inputs.changed).toEqual([
      { key: "job_url", label: "job_url", before: "string, required", after: "string" },
    ]);
    expect(c.variables.added.map((v) => v.label)).toEqual(["statuses"]);
    expect(c.variables.removed.map((v) => v.label)).toEqual(["attempts"]);
  });

  it("tells a version that only moved steps apart from one that changed the workflow", () => {
    const after = base();
    after.nodes[2] = { ...after.nodes[2], position: { x: 600, y: 80 } };
    const c = compareWorkflowSpecs(base(), after);
    expect(c.steps.moved.map((s) => s.key)).toEqual(["done"]);
    expect(isEmptyWorkflowComparison(c)).toBe(false);
    expect(isLayoutOnlyComparison(c)).toBe(true);
  });

  it("compares values by content, not key order, and shortens long ones", () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(previewValue("x".repeat(200))).toHaveLength(80);
    expect(previewValue(null)).toBe("");
  });
});

describe("the version rows", () => {
  it("says how each version came to be", () => {
    expect(workflowVersionKindLabel(summary({ versionNo: 1 }))).toBe("Created");
    expect(workflowVersionKindLabel(summary({ versionNo: 4 }))).toBe("Saved");
    expect(workflowVersionKindLabel(summary({ versionNo: 5, restoredFrom: 2 }))).toBe("Restored from version 2");
  });

  it("summarises counts and how they moved against the version below", () => {
    const older = summary({ versionNo: 1 });
    expect(workflowVersionSummary(older, null)).toBe("3 steps, 2 connections");
    expect(workflowVersionSummary(summary({ versionNo: 2, nodeCount: 4, edgeCount: 2 }), older)).toBe(
      "4 steps, 2 connections (+1 step)",
    );
    expect(
      workflowVersionSummary(summary({ versionNo: 2, nodeCount: 1, edgeCount: 0, name: "Renamed" }), older),
    ).toBe("1 step, 0 connections (−2 steps, −2 connections, renamed “Renamed”)");
  });

  it("draws an append-only history as one straight lane", () => {
    const graph = layoutVersionGraph(
      toGraphVersions([summary({ versionNo: 3, restoredFrom: 1 }), summary({ versionNo: 2 }), summary({ versionNo: 1 })]),
    );
    expect(graph.lanes).toBe(1);
    expect(graph.rows.map((r) => r.down)).toEqual([true, true, false]);
  });
});

describe("the history API contract", () => {
  it("maps a page of versions, dropping rows without a number", () => {
    const page = WorkflowVersionPageSchema.parse({
      items: [
        {
          versionNo: 2, createdAt: "2026-11-01T10:00:00Z", createdBy: "u1", restoredFrom: 1,
          name: "Flow", description: "d", nodeCount: 3, edgeCount: 2,
        },
        { name: "no number" },
      ],
      nextBefore: 2,
    });
    expect(page).toEqual({
      items: [
        {
          versionNo: 2, createdAt: "2026-11-01T10:00:00Z", createdBy: "u1", restoredFrom: 1,
          name: "Flow", description: "d", nodeCount: 3, edgeCount: 2,
        },
      ],
      nextBefore: 2,
    });
  });

  it("maps one version with its spec", () => {
    const detail = WorkflowVersionDetailSchema.parse({
      versionNo: 1, createdAt: null, createdBy: "u1", restoredFrom: null, spec: base(),
    });
    expect(detail.versionNo).toBe(1);
    expect(detail.spec.nodes.map((n) => n.id)).toEqual(["start", "poll", "done"]);
  });
});
