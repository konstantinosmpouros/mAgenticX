import type {
  WorkflowEdgeDef,
  WorkflowInputDef,
  WorkflowNodeDef,
  WorkflowSpec,
  WorkflowStateFieldDef,
  WorkflowVersionSummary,
} from "@/shared/lib/types";
import type { GraphVersion } from "@/shared/lib/versionHistory";
import { humanizeKind, nodeLabel } from "@/features/workflows/lib/kinds";

/**
 * A workflow's History panel, as data: how each kept version came to be, its
 * one-line summary, the version graph's view of it, and what one version
 * changed compared with another — computed here, on the client, by diffing
 * the two specs (the server keeps whole snapshots, not change lists).
 *
 * The diff speaks the builder's language: the workflow's name and
 * description; steps added, removed, renamed (a new name or a new id for the
 * same step) and changed (which settings, before → after); connections added
 * and removed (named by their steps, a renamed step's connections followed
 * through the rename); inputs and variables added, removed and changed; and
 * steps only moved on the canvas.
 */

/** One item of a list change, keyed for comparison and labelled for display. */
export type WorkflowChangeItem = { key: string; label: string; detail?: string };

export type WorkflowFieldChange = { label: string; before: string; after: string };

/** A step whose settings changed: which ones, before → after (shortened). */
export type WorkflowStepChange = {
  id: string;
  label: string;
  kind: string;
  settings: { key: string; before: string; after: string }[];
};

/** The same step under a new name or a new id. */
export type WorkflowStepRename = { id: string; from: string; to: string };

/** An input or variable whose definition changed, before → after. */
export type WorkflowChangedItem = { key: string; label: string; before: string; after: string };

export type WorkflowListDiff = {
  added: WorkflowChangeItem[];
  removed: WorkflowChangeItem[];
  changed: WorkflowChangedItem[];
};

export type WorkflowComparison = {
  fields: WorkflowFieldChange[];
  steps: {
    added: WorkflowChangeItem[];
    removed: WorkflowChangeItem[];
    renamed: WorkflowStepRename[];
    changed: WorkflowStepChange[];
    /** Steps whose only change is where they sit on the canvas. */
    moved: WorkflowChangeItem[];
  };
  connections: { added: WorkflowChangeItem[]; removed: WorkflowChangeItem[] };
  inputs: WorkflowListDiff;
  variables: WorkflowListDiff;
};

/** How long a setting's value may print before it is cut. */
const VALUE_PREVIEW = 80;

/** JSON with sorted keys: two values are equal when their texts are. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** A setting's value as one short line ("" for none). */
export function previewValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : stableJson(value);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > VALUE_PREVIEW ? `${line.slice(0, VALUE_PREVIEW - 1)}…` : line;
}

/** "Fetch" for `fetch`, "Manual trigger" for `trigger.manual`. */
const kindName = (kind: string) => humanizeKind(kind);

const stepItem = (node: WorkflowNodeDef): WorkflowChangeItem => ({
  key: node.id,
  label: nodeLabel(node, node.id),
  detail: kindName(node.kind),
});

/**
 * Pair the steps that left with the steps that came that are the same step
 * under a new id (the builder's rename): the same kind and the same settings.
 * Each step pairs at most once, first come first served.
 */
function pairRenamedIds(removed: WorkflowNodeDef[], added: WorkflowNodeDef[]): Map<string, string> {
  const renames = new Map<string, string>();
  const taken = new Set<string>();
  for (const old of removed) {
    const match = added.find(
      (candidate) =>
        !taken.has(candidate.id) && candidate.kind === old.kind && same(candidate.config, old.config),
    );
    if (match) {
      renames.set(old.id, match.id);
      taken.add(match.id);
    }
  }
  return renames;
}

function settingChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((key) => !same(before[key], after[key]))
    .map((key) => ({ key, before: previewValue(before[key]), after: previewValue(after[key]) }));
}

const edgeKey = (edge: Pick<WorkflowEdgeDef, "source" | "target" | "branch">) =>
  `${edge.source}->${edge.target}#${edge.branch ?? ""}`;

function connectionItem(
  edge: WorkflowEdgeDef,
  names: (id: string) => string,
  key: string,
): WorkflowChangeItem {
  return {
    key,
    label: `${names(edge.source)} → ${names(edge.target)}`,
    ...(edge.branch ? { detail: edge.branch } : {}),
  };
}

/** What an input's or variable's definition says, as one readable line. */
const describeInput = (input: WorkflowInputDef): string =>
  [
    input.type,
    input.required ? "required" : null,
    input.default !== undefined && input.default !== "" ? `default ${previewValue(input.default)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

const describeVariable = (field: WorkflowStateFieldDef): string =>
  [
    field.type,
    field.reducer !== "overwrite" ? field.reducer : null,
    field.default !== undefined && field.default !== "" ? `starts at ${previewValue(field.default)}` : null,
    field.persist ? "kept between runs" : null,
  ]
    .filter(Boolean)
    .join(", ");

function namedListDiff<T extends { name: string }>(
  before: T[],
  after: T[],
  describe: (item: T) => string,
): WorkflowListDiff {
  const was = new Map(before.map((item) => [item.name, item]));
  const now = new Map(after.map((item) => [item.name, item]));
  const item = (value: T): WorkflowChangeItem => ({ key: value.name, label: value.name, detail: describe(value) });
  return {
    added: after.filter((value) => !was.has(value.name)).map(item),
    removed: before.filter((value) => !now.has(value.name)).map(item),
    changed: after
      .filter((value) => was.has(value.name) && !same(was.get(value.name), value))
      .map((value) => ({
        key: value.name,
        label: value.name,
        before: describe(was.get(value.name) as T),
        after: describe(value),
      })),
  };
}

/** What `after` changed relative to `before` (an older version, or any other). */
export function compareWorkflowSpecs(before: WorkflowSpec, after: WorkflowSpec): WorkflowComparison {
  const fields: WorkflowFieldChange[] = (
    [
      ["Name", before.name.trim(), after.name.trim()],
      ["Description", (before.description ?? "").trim(), (after.description ?? "").trim()],
    ] as const
  )
    .filter(([, b, a]) => b !== a)
    .map(([label, b, a]) => ({ label, before: b, after: a }));

  // ---- steps ----
  const wasNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const nowNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const gone = before.nodes.filter((node) => !nowNodes.has(node.id));
  const came = after.nodes.filter((node) => !wasNodes.has(node.id));
  const idRenames = pairRenamedIds(gone, came);
  const renamedTo = new Set(idRenames.values());

  const renamed: WorkflowStepRename[] = [];
  const changed: WorkflowStepChange[] = [];
  const moved: WorkflowChangeItem[] = [];

  for (const [oldId, newId] of idRenames) {
    const old = wasNodes.get(oldId) as WorkflowNodeDef;
    const now = nowNodes.get(newId) as WorkflowNodeDef;
    renamed.push({ id: newId, from: nodeLabel(old, oldId), to: nodeLabel(now, newId) });
  }
  for (const now of after.nodes) {
    const old = wasNodes.get(now.id);
    if (!old) continue;
    const fromLabel = nodeLabel(old, old.id);
    const toLabel = nodeLabel(now, now.id);
    if (fromLabel !== toLabel) renamed.push({ id: now.id, from: fromLabel, to: toLabel });
    const settings = settingChanges(old.config, now.config);
    if (old.kind !== now.kind) {
      settings.unshift({ key: "kind", before: kindName(old.kind), after: kindName(now.kind) });
    }
    if (settings.length) changed.push({ id: now.id, label: toLabel, kind: kindName(now.kind), settings });
    else if (fromLabel === toLabel && !same(old.position, now.position)) moved.push(stepItem(now));
  }

  const steps = {
    added: came.filter((node) => !renamedTo.has(node.id)).map(stepItem),
    removed: gone.filter((node) => !idRenames.has(node.id)).map(stepItem),
    renamed,
    changed,
    moved,
  };

  // ---- connections (a renamed step's connections are followed, not churned) ----
  const throughRename = (id: string) => idRenames.get(id) ?? id;
  const oldName = (id: string) => nodeLabel(wasNodes.get(id), id);
  const newName = (id: string) => nodeLabel(nowNodes.get(id), id);
  const wasEdges = new Map(
    before.edges.map((edge) => [
      edgeKey({ ...edge, source: throughRename(edge.source), target: throughRename(edge.target) }),
      edge,
    ]),
  );
  const nowEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  const connections = {
    added: [...nowEdges]
      .filter(([key]) => !wasEdges.has(key))
      .map(([key, edge]) => connectionItem(edge, newName, key)),
    removed: [...wasEdges]
      .filter(([key]) => !nowEdges.has(key))
      .map(([key, edge]) => connectionItem(edge, oldName, key)),
  };

  return {
    fields,
    steps,
    connections,
    inputs: namedListDiff(before.inputs, after.inputs, describeInput),
    variables: namedListDiff(before.state, after.state, describeVariable),
  };
}

const listEmpty = (diff: { added: unknown[]; removed: unknown[]; changed?: unknown[] }) =>
  !diff.added.length && !diff.removed.length && !(diff.changed?.length ?? 0);

/** Nothing at all differs, not even where a step sits. */
export const isEmptyWorkflowComparison = (c: WorkflowComparison): boolean =>
  !c.fields.length &&
  listEmpty(c.steps) &&
  !c.steps.renamed.length &&
  !c.steps.moved.length &&
  listEmpty(c.connections) &&
  listEmpty(c.inputs) &&
  listEmpty(c.variables);

/** Only steps moved on the canvas: the workflow itself runs the same. */
export const isLayoutOnlyComparison = (c: WorkflowComparison): boolean =>
  c.steps.moved.length > 0 && isEmptyWorkflowComparison({ ...c, steps: { ...c.steps, moved: [] } });

// ---------------------------------------------------------------------------
// The version rows
// ---------------------------------------------------------------------------

/** How a version came to be, as a sentence fragment ("Restored from version 3"). */
export const workflowVersionKindLabel = (version: WorkflowVersionSummary): string => {
  if (version.restoredFrom !== null) return `Restored from version ${version.restoredFrom}`;
  return version.versionNo === 1 ? "Created" : "Saved";
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const signed = (delta: number, one: string) =>
  delta === 0 ? null : `${delta > 0 ? "+" : "−"}${plural(Math.abs(delta), one)}`;

/**
 * A version's one-line summary: its step and connection counts and, against
 * the version listed below it, how those counts moved and whether it was
 * renamed — the full "what changed" waits until the row is opened.
 */
export function workflowVersionSummary(
  version: WorkflowVersionSummary,
  older: WorkflowVersionSummary | null,
): string {
  const counts = `${plural(version.nodeCount, "step")}, ${plural(version.edgeCount, "connection")}`;
  if (!older) return counts;
  const deltas = [
    signed(version.nodeCount - older.nodeCount, "step"),
    signed(version.edgeCount - older.edgeCount, "connection"),
  ].filter(Boolean);
  const renamedTo = version.name.trim() !== older.name.trim() && version.name.trim() ? `renamed “${version.name.trim()}”` : null;
  const notes = [...deltas, renamedTo].filter(Boolean);
  return notes.length ? `${counts} (${notes.join(", ")})` : counts;
}

/**
 * The version graph's view of a workflow's history: it only ever appends
 * (a restore is a new version on top), so each version sits on the one
 * before it — one straight lane.
 */
export const toGraphVersions = (versions: WorkflowVersionSummary[]): GraphVersion[] =>
  versions.map((version) => ({
    versionNo: version.versionNo,
    basedOn: version.versionNo > 1 ? version.versionNo - 1 : null,
    kind: version.versionNo === 1 ? "created" : "saved",
  }));
