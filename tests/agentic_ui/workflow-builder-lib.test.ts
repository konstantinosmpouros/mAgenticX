import { describe, expect, it } from "vitest";

import catalogJson from "./fixtures/workflow-catalog.json";
import type { WorkflowNodeKindInfo, WorkflowSpec } from "@/shared/lib/types";
import { draftReducer, newWorkflowSpec, normalizeSpec, sameSpec } from "@/features/workflows/lib/builder/draft";
import { flowToSpec, layoutSpec, specToFlow } from "@/features/workflows/lib/builder/flow";
import { canConnect, findCycle } from "@/features/workflows/lib/builder/graph";
import { newEdgeId, newNodeId, nodeIdProblem } from "@/features/workflows/lib/builder/ids";
import { configProblems, defaultConfig, fieldsFromSchema } from "@/features/workflows/lib/builder/schemaForm";
import { renameNodeReferences, templatePaths } from "@/features/workflows/lib/builder/templates";
import { checkSpec, placeServerIssues } from "@/features/workflows/lib/builder/validate";
import { formatLoose, parseLoose, parseTyped } from "@/features/workflows/lib/builder/values";
import { paletteGroups } from "@/features/workflows/lib/builder/palette";
import { CLEAN_MIN_GAP, LAYOUT_GAP } from "@/features/workflows/lib/layout";
import { NODE_CARD, nodeCardHeight, nodeBranches } from "@/features/workflows/lib/nodeCard";

/**
 * The workflow builder's pure half (plan 38, step 3), against the engine's
 * real catalogue (`fixtures/workflow-catalog.json`, dumped from
 * `NODE_KINDS[*].catalog_entry()`).
 *
 * Pinned: spec ↔ React Flow round-trips (positions, branch handles, back
 * edges); the client mirror of the validator (one trigger, branch rules, one
 * edge per branch, loops, reachability, cycles only through `continue`);
 * the instant connect check; every step-1 kind's schema becomes the right
 * widgets and a valid starting config; router cases are branches/handles and
 * follow renames; templates offer upstream outputs only.
 */

const catalog = catalogJson as unknown as WorkflowNodeKindInfo[];
const kind = (name: string) => catalog.find((entry) => entry.kind === name) as WorkflowNodeKindInfo;

/** The docs' worked example: manual → fetch → condition → approval | loop (back to fetch) → end. */
const example = (): WorkflowSpec => ({
  version: 1,
  name: "Poll a job",
  description: "",
  inputs: [{ name: "job_url", type: "string", required: true, default: null, description: "" }],
  state: [{ name: "attempts", type: "number", reducer: "overwrite", default: 0, persist: false }],
  nodes: [
    { id: "start", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
    { id: "poll", kind: "fetch", label: "Poll", config: { url: "{{input.job_url}}" }, position: { x: 352, y: 0 } },
    {
      id: "done",
      kind: "condition",
      label: null,
      config: { rules: [{ path: "nodes.poll.output.status", op: "eq", value: 200 }] },
      position: { x: 704, y: 0 },
    },
    { id: "retry", kind: "loop", label: null, config: { max_iterations: 3 }, position: { x: 1056, y: 160 } },
    { id: "ok", kind: "approval", label: null, config: { message: "Ship it?" }, position: { x: 1056, y: 0 } },
    { id: "finish", kind: "end", label: null, config: {}, position: { x: 1408, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "poll", branch: null },
    { id: "e2", source: "poll", target: "done", branch: null },
    { id: "e3", source: "done", target: "ok", branch: "true" },
    { id: "e4", source: "done", target: "retry", branch: "false" },
    { id: "e5", source: "retry", target: "poll", branch: "continue" },
    { id: "e6", source: "retry", target: "finish", branch: "done" },
    { id: "e7", source: "ok", target: "finish", branch: "approved" },
  ],
});

const messages = (spec: WorkflowSpec) => checkSpec(spec, catalog).map((issue) => issue.message);
const errors = (spec: WorkflowSpec) =>
  checkSpec(spec, catalog).filter((issue) => issue.severity === "error");

describe("spec ↔ flow", () => {
  it("round-trips positions and edges, branches through the source handles", () => {
    const spec = example();
    const flow = specToFlow(spec, { catalog });
    expect(flow.nodes.map((node) => [node.id, node.position])).toEqual(
      spec.nodes.map((node) => [node.id, node.position]),
    );
    expect(flow.edges.find((edge) => edge.id === "e3")?.sourceHandle).toBe("true");
    expect(flow.edges.find((edge) => edge.id === "e1")?.sourceHandle ?? null).toBeNull();
    expect(flowToSpec(spec, flow.nodes, flow.edges)).toEqual(spec);
  });

  it("draws in edit mode: issue counts, selection, a delete on every step (the trigger too), loop edges as arcs", () => {
    const flow = specToFlow(example(), {
      catalog,
      issueCounts: new Map([["poll", 2]]),
      errorNodes: new Set(["poll"]),
      selection: { nodes: ["poll"], edges: ["e2"] },
      onDeleteNode: () => {},
      onDeleteEdge: () => {},
    });
    const poll = flow.nodes.find((node) => node.id === "poll")!;
    expect(poll.data).toMatchObject({ mode: "edit", issueCount: 2, hasErrors: true, selected: true });
    expect(poll.selected).toBe(true);
    const start = flow.nodes.find((node) => node.id === "start")!;
    expect(start.data.isTrigger).toBe(true);
    expect(start.data.onDelete).toBeTypeOf("function");
    expect(start.deletable).toBe(true);
    const back = flow.edges.find((edge) => edge.id === "e5")!;
    expect(back.data).toMatchObject({ mode: "edit", branch: "continue", back: true });
    expect(typeof back.data?.floorY).toBe("number");
    expect(flow.edges.find((edge) => edge.id === "e2")?.selected).toBe(true);
  });

  it("moves a flow edit back into the spec", () => {
    const spec = example();
    const flow = specToFlow(spec, { catalog });
    const moved = flow.nodes.map((node) => (node.id === "poll" ? { ...node, position: { x: 400, y: 48 } } : node));
    const next = flowToSpec(spec, moved, flow.edges.filter((edge) => edge.id !== "e7"));
    expect(next.nodes.find((node) => node.id === "poll")?.position).toEqual({ x: 400, y: 48 });
    expect(next.edges.map((edge) => edge.id)).not.toContain("e7");
  });

  it("tidies with room to breathe: no overlaps, columns and rows clearly apart", () => {
    expect(LAYOUT_GAP.x).toBeGreaterThanOrEqual(120);
    expect(LAYOUT_GAP.y).toBeGreaterThanOrEqual(56);
    const spec = example();
    const positions = layoutSpec(spec, catalog);
    const boxes = spec.nodes.map((node) => ({
      id: node.id,
      ...positions[node.id],
      width: NODE_CARD.width,
      height: nodeCardHeight(nodeBranches(node, kind(node.kind), spec.edges).length),
    }));
    // No two cards overlap, or come closer than the clean minimum on both axes.
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        const apartX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
        const apartY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
        expect(Math.max(apartX, apartY), `${a.id} vs ${b.id}`).toBeGreaterThanOrEqual(CLEAN_MIN_GAP.y);
        // Cards in one column keep the row gap (less at most half a snap step).
        if (a.x === b.x) expect(apartY, `${a.id} above ${b.id}`).toBeGreaterThanOrEqual(LAYOUT_GAP.y - 8);
      }
    }
    // Columns: every distinct x is a full card width plus the column gap from the next.
    const columns = [...new Set(boxes.map((box) => box.x))].sort((a, b) => a - b);
    expect(columns.length).toBeGreaterThan(3);
    for (let index = 1; index < columns.length; index += 1) {
      expect(columns[index] - columns[index - 1]).toBeGreaterThanOrEqual(NODE_CARD.width + 120);
    }
    // Every forward edge has at least the clean minimum between its handles.
    for (const edge of spec.edges.filter((entry) => entry.id !== "e5")) {
      const from = positions[edge.source].x + NODE_CARD.width;
      expect(positions[edge.target].x - from, edge.id).toBeGreaterThanOrEqual(CLEAN_MIN_GAP.x);
    }
  });

  it("groups the palette in order and filters it by a search", () => {
    const groups = paletteGroups(catalog);
    expect(groups[0].id).toBe("trigger");
    expect(groups.flatMap((group) => group.items).length).toBe(catalog.length);
    const http = paletteGroups(catalog, "http");
    expect(http.flatMap((group) => group.items.map((item) => item.kind))).toContain("fetch");
    expect(paletteGroups(catalog, "zzz-nothing")).toEqual([]);
  });

  it("tidies left to right on the snap grid", () => {
    const spec = example();
    const positions = layoutSpec(spec, catalog);
    expect(Object.keys(positions).sort()).toEqual(spec.nodes.map((node) => node.id).sort());
    expect(positions.poll.x).toBeGreaterThan(positions.start.x);
    expect(positions.done.x).toBeGreaterThan(positions.poll.x);
    for (const point of Object.values(positions)) {
      expect(point.x % 16).toBe(0);
      expect(Math.abs(point.y % 16)).toBe(0);
    }
  });
});

describe("client validation", () => {
  it("accepts the worked example", () => {
    expect(errors(example())).toEqual([]);
  });

  it("wants exactly one trigger", () => {
    const none = example();
    none.nodes = none.nodes.filter((node) => node.id !== "start");
    none.edges = none.edges.filter((edge) => edge.source !== "start");
    expect(messages(none)).toContain("Add a trigger: it is where a run starts.");

    const two = example();
    two.nodes.push({ id: "again", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 300 } });
    expect(messages(two)).toContain("A workflow has exactly one trigger.");
  });

  it("checks branch edges: needed, known, one per branch", () => {
    const missing = example();
    missing.edges = missing.edges.map((edge) => (edge.id === "e3" ? { ...edge, branch: null } : edge));
    expect(errors(missing).some((issue) => issue.nodeId === "done" && /need a branch/.test(issue.message))).toBe(true);

    const unknown = example();
    unknown.edges = unknown.edges.map((edge) => (edge.id === "e3" ? { ...edge, branch: "maybe" } : edge));
    expect(messages(unknown)).toContain("Branch 'maybe' no longer exists.");

    const twice = example();
    twice.edges.push({ id: "e8", source: "done", target: "finish", branch: "true" });
    expect(messages(twice)).toContain("Branch 'true' leads to two steps.");

    const plain = example();
    plain.edges = plain.edges.map((edge) => (edge.id === "e2" ? { ...edge, branch: "true" } : edge));
    expect(messages(plain)).toContain("'poll' does not branch.");
  });

  it("finds a cycle that skips the loop's continue, and a loop without one", () => {
    const cyclic = example();
    cyclic.edges.push({ id: "e8", source: "ok", target: "poll", branch: "rejected" });
    expect(findCycle(cyclic)).toEqual(["done", "ok", "poll", "done"]);
    expect(errors(cyclic).some((issue) => /^Cycle done → ok → poll → done/.test(issue.message))).toBe(true);

    const noContinue = example();
    noContinue.edges = noContinue.edges.filter((edge) => edge.id !== "e5");
    expect(messages(noContinue)).toContain("A loop needs a 'continue' connection back into its body.");
    expect(findCycle(example())).toBeNull();
  });

  it("flags unreachable steps, edges into the trigger and out of an end", () => {
    const spec = example();
    spec.nodes.push({ id: "orphan", kind: "end", label: null, config: {}, position: { x: 0, y: 400 } });
    spec.edges.push({ id: "e9", source: "finish", target: "start", branch: null });
    const found = errors(spec);
    expect(found.some((issue) => issue.nodeId === "orphan" && /Not reachable/.test(issue.message))).toBe(true);
    expect(found.some((issue) => issue.nodeId === "start" && issue.message === "Nothing may lead into the trigger.")).toBe(true);
    expect(found.some((issue) => issue.nodeId === "finish" && issue.message === "An end step has no way out.")).toBe(true);
  });

  it("checks config against the kind's schema, names, and template references", () => {
    const spec = example();
    spec.nodes = spec.nodes.map((node) =>
      node.id === "poll"
        ? { ...node, config: { url: "{{input.missing}}", timeout_seconds: 99 } }
        : node.id === "retry"
          ? { ...node, config: { max_iterations: 50, assign: { nope: "{{output.iteration}}" } } }
          : node,
    );
    spec.state.push({ name: "list", type: "string", reducer: "append", default: null, persist: false });
    const found = errors(spec);
    const on = (nodeId: string | null, field: string) => found.filter((i) => i.nodeId === nodeId && i.field === field);
    expect(on("poll", "config.timeout_seconds")[0]?.message).toBe("Timeout seconds is at most 30.");
    expect(on("poll", "config.url")[0]?.message).toMatch(/undeclared input 'missing'/);
    expect(on("retry", "config.max_iterations")[0]?.message).toBe("Max iterations is at most 20.");
    expect(on("retry", "config.assign")[0]?.message).toBe("'nope' is not a variable. Add it in Settings › Variables.");
    expect(on(null, "state[1].reducer")[0]?.message).toBe("Append needs an array field.");
  });

  it("places the server's index-based issues on nodes and fields", () => {
    const spec = example();
    const placed = placeServerIssues(
      [
        { nodeId: "poll", path: "nodes[1].config.url", message: "Bad URL." },
        { nodeId: null, path: "edges[2].branch", message: "Branch issue." },
        { nodeId: null, path: "inputs[0].default", message: "Wrong type." },
      ],
      spec,
    );
    expect(placed.map((issue) => [issue.nodeId, issue.field])).toEqual([
      ["poll", "config.url"],
      ["done", "edges"],
      [null, "inputs[0].default"],
    ]);
  });
});

describe("connect check", () => {
  const base = (): WorkflowSpec => {
    const spec = example();
    spec.edges = spec.edges.filter((edge) => edge.id !== "e5");
    return spec;
  };

  it("refuses self, into the trigger, out of an end, wrong branches and a second edge on a branch", () => {
    const spec = base();
    expect(canConnect(spec, catalog, { source: "poll", target: "poll", branch: null }).ok).toBe(false);
    expect(canConnect(spec, catalog, { source: "poll", target: "start", branch: null })).toEqual({
      ok: false,
      reason: "Nothing may lead into the trigger.",
    });
    expect(canConnect(spec, catalog, { source: "finish", target: "ok", branch: null }).ok).toBe(false);
    expect(canConnect(spec, catalog, { source: "done", target: "finish", branch: null }).ok).toBe(false);
    expect(canConnect(spec, catalog, { source: "done", target: "finish", branch: "true" }).ok).toBe(false);
    // A second plain connection starts parallel paths; the same one twice does not.
    expect(canConnect(spec, catalog, { source: "poll", target: "finish", branch: null })).toEqual({ ok: true });
    const existing = spec.edges.find((edge) => edge.source === "poll" && !edge.branch);
    expect(existing).toBeDefined();
    expect(canConnect(spec, catalog, { source: "poll", target: existing!.target, branch: null })).toEqual({
      ok: false,
      reason: "These steps are already connected.",
    });
  });

  it("allows a back-edge only through a loop's continue", () => {
    const spec = base();
    expect(canConnect(spec, catalog, { source: "retry", target: "poll", branch: "continue" })).toEqual({ ok: true });
    const noExit = base();
    noExit.edges = noExit.edges.filter((edge) => edge.id !== "e7");
    const verdict = canConnect(noExit, catalog, { source: "ok", target: "poll", branch: "approved" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/cycle/i);
  });
});

describe("schema → form, per step-1 kind", () => {
  const widgets = (name: string) =>
    Object.fromEntries(fieldsFromSchema(kind(name).configSchema).map((field) => [field.key, field.widget]));

  it("reads every kind's fields with the right widgets (assign last)", () => {
    expect(widgets("trigger.manual")).toEqual({ assign: "assign" });
    expect(widgets("tool")).toEqual({ tool: "object", args: "map", timeout_seconds: "number", assign: "assign" });
    expect(widgets("fetch")).toEqual({
      method: "enum",
      url: "text",
      headers: "map",
      query: "map",
      body: "json",
      timeout_seconds: "number",
      response_type: "enum",
      assign: "assign",
    });
    expect(widgets("condition")).toEqual({ mode: "enum", rules: "rules", assign: "assign" });
    expect(widgets("router")).toEqual({ cases: "cases", assign: "assign" });
    expect(widgets("loop")).toEqual({ max_iterations: "number", mode: "enum", while: "rules", assign: "assign" });
    expect(widgets("approval")).toEqual({ message: "textarea", payload: "json", assign: "assign" });
    expect(widgets("end")).toEqual({ outputs: "map", assign: "assign" });
  });

  it("keeps the details the controls need", () => {
    const fetchFields = fieldsFromSchema(kind("fetch").configSchema);
    const url = fetchFields.find((field) => field.key === "url")!;
    expect(url).toMatchObject({ required: true, maxLength: 2048, templated: true });
    expect(fetchFields.find((field) => field.key === "headers")?.valueKind).toBe("string");
    expect(fetchFields.find((field) => field.key === "query")?.valueKind).toBe("scalar");
    const timeout = fetchFields.find((field) => field.key === "timeout_seconds")!;
    expect(timeout).toMatchObject({ default: 15, maximum: 30, exclusiveMinimum: 0 });
    const tool = fieldsFromSchema(kind("tool").configSchema).find((field) => field.key === "tool")!;
    expect(tool.fields?.map((field) => [field.key, field.widget])).toEqual([
      ["source", "enum"],
      ["name", "text"],
    ]);
    const loop = fieldsFromSchema(kind("loop").configSchema).find((field) => field.key === "max_iterations")!;
    expect(loop).toMatchObject({ integer: true, minimum: 1, maximum: 20, default: 5 });
  });

  it("starts each kind with a config that only lacks what the user must type", () => {
    expect(defaultConfig(kind("condition").configSchema)).toEqual({ rules: [{ path: "", op: "eq", value: null }] });
    expect(defaultConfig(kind("router").configSchema)).toEqual({
      cases: [{ name: "case_1", mode: "all", rules: [{ path: "", op: "eq", value: null }] }],
    });
    expect(defaultConfig(kind("fetch").configSchema)).toEqual({ url: "" });
    expect(defaultConfig(kind("approval").configSchema)).toEqual({ message: "" });
    expect(defaultConfig(kind("tool").configSchema)).toEqual({ tool: { source: "native", name: "" } });
    expect(defaultConfig(kind("loop").configSchema)).toEqual({});
    expect(defaultConfig(kind("end").configSchema)).toEqual({});
    const fields = fieldsFromSchema(kind("fetch").configSchema);
    expect(configProblems(fields, { url: "" })).toEqual([{ field: "config.url", message: "URL is required." }]);
    expect(configProblems(fields, { url: "https://example.com" })).toEqual([]);
  });
});

describe("router cases → branches and handles", () => {
  const routed = (): WorkflowSpec => {
    const spec: WorkflowSpec = {
      ...newWorkflowSpec(),
      name: "Route",
      nodes: [{ id: "trigger", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } }],
    };
    spec.nodes.push(
      {
        id: "route",
        kind: "router",
        label: null,
        config: {
          cases: [
            { name: "high", mode: "all", rules: [{ path: "input.n", op: "gt", value: 10 }] },
            { name: "low", mode: "all", rules: [{ path: "input.n", op: "lt", value: 0 }] },
          ],
        },
        position: { x: 352, y: 0 },
      },
      { id: "end", kind: "end", label: null, config: {}, position: { x: 704, y: 0 } },
    );
    spec.inputs.push({ name: "n", type: "number", required: true, default: null, description: "" });
    spec.edges.push(
      { id: "e1", source: "trigger", target: "route", branch: null },
      { id: "e2", source: "route", target: "end", branch: "high" },
    );
    return spec;
  };

  it("gives one handle per case, then default", () => {
    const node = specToFlow(routed(), { catalog }).nodes.find((entry) => entry.id === "route")!;
    expect(node.data.branches).toEqual(["high", "low", "default"]);
    expect(canConnect(routed(), catalog, { source: "route", target: "end", branch: "low" }).ok).toBe(true);
    expect(canConnect(routed(), catalog, { source: "route", target: "end", branch: "medium" }).ok).toBe(false);
  });

  it("keeps a case's edge through a rename and drops it with the case", () => {
    const spec = routed();
    const cases = (spec.nodes[1].config.cases as Array<Record<string, unknown>>).map((c) =>
      c.name === "high" ? { ...c, name: "big" } : c,
    );
    const renamed = draftReducer(spec, {
      type: "update-node",
      id: "route",
      patch: { config: { cases } },
      renameBranches: [["high", "big"]],
    });
    expect(renamed.edges.find((edge) => edge.id === "e2")?.branch).toBe("big");
    expect(errors(renamed)).toEqual([]);

    const dropped = draftReducer(renamed, {
      type: "update-node",
      id: "route",
      patch: { config: { cases: cases.filter((c) => c.name !== "big") } },
      dropBranches: ["big"],
    });
    expect(dropped.edges.some((edge) => edge.id === "e2")).toBe(false);
  });

  it("flags reserved and repeated case names", () => {
    const spec = routed();
    spec.nodes[1].config = {
      cases: [
        { name: "default", mode: "all", rules: [{ path: "input.n", op: "exists", value: null }] },
        { name: "low", mode: "all", rules: [{ path: "input.n", op: "exists", value: null }] },
        { name: "low", mode: "all", rules: [{ path: "input.n", op: "exists", value: null }] },
      ],
    };
    const found = messages(spec);
    expect(found).toContain("'default' is the fallback branch's name.");
    expect(found).toContain("Case name 'low' is used twice.");
  });
});

describe("draft, ids, templates and values", () => {
  it("starts a new workflow empty: no name, no steps, and the checks ask for both", () => {
    const spec = newWorkflowSpec();
    expect(spec.name).toBe("");
    expect(spec.nodes).toEqual([]);
    expect(errors(spec).map((issue) => issue.message)).toEqual(["Give the workflow a name.", "Add a trigger: it is where a run starts."]);
    const started: WorkflowSpec = {
      ...spec,
      name: "x",
      nodes: [{ id: "trigger", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } }],
    };
    expect(errors(started)).toEqual([]);
  });

  it("flags a second trigger instead of refusing it", () => {
    const two: WorkflowSpec = {
      ...newWorkflowSpec(),
      name: "x",
      nodes: [
        { id: "trigger", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
        { id: "trigger_2", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 160 } },
      ],
    };
    expect(errors(two).map((issue) => issue.message)).toContain("A workflow has exactly one trigger.");
  });

  it("renames a node: edges and references follow", () => {
    const next = draftReducer(example(), { type: "rename-node", from: "poll", to: "check" });
    expect(next.edges.filter((edge) => edge.source === "check" || edge.target === "check")).toHaveLength(3);
    const done = next.nodes.find((node) => node.id === "done")!;
    expect(done.config).toEqual({ rules: [{ path: "nodes.check.output.status", op: "eq", value: 200 }] });
    expect(renameNodeReferences("{{nodes.poll.output}} {{nodes.pollster.output}}", "poll", "x")).toBe(
      "{{nodes.x.output}} {{nodes.pollster.output}}",
    );
    // A taken id is refused.
    expect(draftReducer(example(), { type: "rename-node", from: "poll", to: "done" })).toEqual(example());
  });

  it("removes a node with its edges", () => {
    const next = draftReducer(example(), { type: "remove", nodeIds: ["retry"], edgeIds: ["e1"] });
    expect(next.nodes.map((node) => node.id)).not.toContain("retry");
    expect(next.edges.map((edge) => edge.id)).toEqual(["e2", "e3", "e7"]);
  });

  it("makes free ids and checks them", () => {
    const taken = new Set(["fetch", "fetch_2", "e1"]);
    expect(newNodeId("fetch", taken)).toBe("fetch_3");
    expect(newNodeId("trigger.manual", taken)).toBe("trigger");
    expect(newEdgeId(new Set(["e1", "e2"]))).toBe("e3");
    expect(nodeIdProblem("9lives", new Set())).toMatch(/Start with a letter/);
    expect(nodeIdProblem("state", new Set())).toBe("'state' is reserved.");
    expect(nodeIdProblem("poll", new Set(["poll"]))).toMatch(/already called/);
    expect(nodeIdProblem("poll_2", new Set(["poll"]))).toBeNull();
  });

  it("offers inputs, state and upstream outputs only", () => {
    const paths = templatePaths(example(), "done").map((entry) => entry.path);
    expect(paths).toContain("input.job_url");
    expect(paths).toContain("state.attempts");
    expect(paths).toContain("nodes.poll.output.status");
    // The trigger's fields are the run's inputs (offered as `input.*`): only its whole output is listed.
    expect(paths).toContain("nodes.start.output");
    expect(paths).not.toContain("nodes.start.output.job_url");
    expect(paths).not.toContain("nodes.finish.output");
    expect(templatePaths(example(), "poll", { inAssign: true }).map((e) => e.path)).toContain("output.body");
  });

  it("reads loose values and typed defaults", () => {
    expect(parseLoose("200")).toBe(200);
    expect(parseLoose("true")).toBe(true);
    expect(parseLoose("{{state.x}}")).toBe("{{state.x}}");
    expect(parseLoose('{"a": 1}')).toEqual({ a: 1 });
    expect(parseLoose("")).toBeNull();
    expect(formatLoose("200")).toBe('"200"');
    expect(parseLoose(formatLoose("200"))).toBe("200");
    expect(parseTyped("number", "abc")).toEqual({ ok: false, message: "Write valid JSON for a number." });
    expect(parseTyped("array", "[1]")).toEqual({ ok: true, value: [1] });
  });

  it("compares specs as sent (trimmed, labels normalised)", () => {
    const spec = example();
    const touched = { ...spec, name: ` ${spec.name} `, nodes: spec.nodes.map((n) => ({ ...n, label: n.label ?? "" })) };
    expect(sameSpec(spec, touched)).toBe(true);
    expect(normalizeSpec(touched).name).toBe("Poll a job");
  });
});

describe("parallel paths", () => {
  const parallel = (): WorkflowSpec => ({
    ...newWorkflowSpec(),
    name: "parallel",
    nodes: [
      { id: "start", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
      { id: "a", kind: "set", label: "Path A", config: { values: {} }, position: { x: 1, y: 0 } },
      { id: "b", kind: "set", label: "Path B", config: { values: {} }, position: { x: 1, y: 1 } },
      { id: "all", kind: "join", label: "Wait for all", config: {}, position: { x: 2, y: 0 } },
      { id: "next", kind: "set", label: null, config: { values: {} }, position: { x: 3, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "a", branch: null },
      { id: "e2", source: "start", target: "b", branch: null },
      { id: "e3", source: "a", target: "all", branch: null },
      { id: "e4", source: "b", target: "all", branch: null },
      { id: "e5", source: "all", target: "next", branch: null },
    ],
  });

  it("does not flag a step that starts parallel paths", () => {
    const issues = checkSpec(parallel(), catalog).filter((issue) => issue.field === "edges");
    expect(issues).toEqual([]);
  });

  it("offers each path's result of a Wait for all, named after the path's last step", () => {
    const paths = templatePaths(parallel(), "next").filter((entry) => entry.nodeId === "all");
    expect(paths.map((entry) => [entry.path, entry.label])).toEqual([
      ["nodes.all.output.a", "Path A"],
      ["nodes.all.output.b", "Path B"],
      ["nodes.all.output", "Whole result"],
    ]);
  });
});
