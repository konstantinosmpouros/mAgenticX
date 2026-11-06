import type {
  WorkflowDraftAction,
  WorkflowNodeDef,
  WorkflowNodeKindInfo,
  WorkflowSpec,
} from "@/shared/lib/types";
import { newNodeId } from "./ids";
import { SCHEDULE_TRIGGER_KIND, defaultScheduleConfig } from "./schedule";
import { defaultConfig } from "./schemaForm";
import { dropStepIds, renameStepIds } from "./stepData";
import { renameNodeReferences } from "./templates";

/**
 * The builder's draft is the spec itself (`WorkflowSpec`), changed only by
 * `draftReducer` — pure, so every edit (and its undo) is a unit-tested value
 * change. Removing a node takes its edges (and the step ids other configs
 * hold for it); renaming one moves its edges, the templates and rule paths
 * that read it, and the `context.steps` / `thread` ids that name it; a router case renamed keeps its
 * edge, and a branch that is gone loses its edge.
 */

/** The grid the canvas snaps to. */
export const SNAP_GRID: [number, number] = [16, 16];

/**
 * A new workflow: an empty canvas and no name. Both are the builder's checks
 * to ask for (a name, exactly one trigger), never placed for the user: the
 * first step is the trigger they pick from the palette.
 */
export function newWorkflowSpec(): WorkflowSpec {
  return { version: 1, name: "", description: "", inputs: [], nodes: [], edges: [] };
}

/**
 * A new node of `kind` at `position`: a free id from the kind, its required
 * config started — a schedule trigger's as a daily repeat, since its schema
 * alone can't say which one spec field to start.
 */
export function createNode(
  spec: WorkflowSpec,
  kind: string,
  info: WorkflowNodeKindInfo | null,
  position: { x: number; y: number },
): WorkflowNodeDef {
  const taken = new Set(spec.nodes.map((node) => node.id));
  return {
    id: newNodeId(kind, taken),
    kind,
    label: null,
    config:
      kind === SCHEDULE_TRIGGER_KIND ? defaultScheduleConfig() : info ? defaultConfig(info.configSchema) : {},
    position: snap(position),
  };
}

const snapValue = (value: number, step: number) => Math.round(value / step) * step;

/** A position on the snap grid. */
export const snap = (position: { x: number; y: number }) => ({
  x: snapValue(position.x, SNAP_GRID[0]),
  y: snapValue(position.y, SNAP_GRID[1]),
});

export function draftReducer(spec: WorkflowSpec, action: WorkflowDraftAction): WorkflowSpec {
  switch (action.type) {
    case "set-name":
      return { ...spec, name: action.value };
    case "set-description":
      return { ...spec, description: action.value };
    case "set-inputs":
      return { ...spec, inputs: action.inputs };
    case "add-node":
      if (spec.nodes.some((node) => node.id === action.node.id)) return spec;
      return { ...spec, nodes: [...spec.nodes, action.node] };
    case "update-node": {
      if (!spec.nodes.some((node) => node.id === action.id)) return spec;
      const nodes = spec.nodes.map((node) =>
        node.id === action.id
          ? {
              ...node,
              ...("label" in action.patch ? { label: action.patch.label ?? null } : {}),
              ...(action.patch.config ? { config: action.patch.config } : {}),
            }
          : node,
      );
      const renames = new Map(action.renameBranches ?? []);
      const dropped = new Set(action.dropBranches ?? []);
      let edges = spec.edges;
      if (renames.size || dropped.size) {
        edges = spec.edges
          .filter((edge) => !(edge.source === action.id && edge.branch && dropped.has(edge.branch)))
          .map((edge) =>
            edge.source === action.id && edge.branch && renames.has(edge.branch)
              ? { ...edge, branch: renames.get(edge.branch) ?? edge.branch }
              : edge,
          );
      }
      return { ...spec, nodes, edges };
    }
    case "rename-node": {
      const { from, to } = action;
      if (from === to || !spec.nodes.some((node) => node.id === from)) return spec;
      if (spec.nodes.some((node) => node.id === to)) return spec;
      return {
        ...spec,
        nodes: spec.nodes.map((node) => ({
          ...node,
          id: node.id === from ? to : node.id,
          // Templates and rule paths, then the ids held as plain values (`context.steps`, `thread`).
          config: renameStepIds(renameNodeReferences(node.config, from, to) as Record<string, unknown>, from, to),
        })),
        edges: spec.edges.map((edge) => ({
          ...edge,
          source: edge.source === from ? to : edge.source,
          target: edge.target === from ? to : edge.target,
        })),
      };
    }
    case "move-nodes": {
      let moved = false;
      const nodes = spec.nodes.map((node) => {
        const position = action.positions[node.id];
        if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;
        moved = true;
        return { ...node, position: { x: position.x, y: position.y } };
      });
      return moved ? { ...spec, nodes } : spec;
    }
    case "remove": {
      const nodeIds = new Set(action.nodeIds);
      const edgeIds = new Set(action.edgeIds);
      if (!nodeIds.size && !edgeIds.size) return spec;
      return {
        ...spec,
        // What is left forgets the removed steps: no context picks them, no conversation is theirs.
        nodes: spec.nodes
          .filter((node) => !nodeIds.has(node.id))
          .map((node) => {
            const config = dropStepIds(node.config, nodeIds);
            return config === node.config ? node : { ...node, config };
          }),
        edges: spec.edges.filter(
          (edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target),
        ),
      };
    }
    case "add-edge":
      if (spec.edges.some((edge) => edge.id === action.edge.id)) return spec;
      return { ...spec, edges: [...spec.edges, action.edge] };
    case "replace":
      return action.spec;
    default:
      return spec;
  }
}

/**
 * The spec as it is sent: names and labels trimmed, an empty label dropped to
 * null, and `description` always a string — what the engine stores, so the
 * builder's "unsaved" compares like with like. Only the spec's own keys are
 * sent: a draft from before variables became implicit loses its declared
 * `state` and every node's `assign` (the engine refuses both).
 */
export function normalizeSpec(spec: WorkflowSpec): WorkflowSpec {
  return {
    version: 1,
    name: spec.name.trim(),
    description: (spec.description ?? "").trim(),
    inputs: spec.inputs.map((input) => ({ ...input, name: input.name.trim() })),
    nodes: spec.nodes.map((node) => ({
      ...node,
      label: node.label?.trim() ? node.label.trim() : null,
      config: withoutAssign(node.config),
    })),
    edges: spec.edges.map((edge) => ({ ...edge, branch: edge.branch || null })),
  };
}

/** A node config without the retired `assign` (the same object when it has none). */
function withoutAssign(config: Record<string, unknown>): Record<string, unknown> {
  if (!("assign" in config)) return config;
  const { assign: _assign, ...rest } = config;
  return rest;
}

/** Whether two specs say the same thing (key order aside). */
export function sameSpec(a: WorkflowSpec, b: WorkflowSpec): boolean {
  return stableStringify(normalizeSpec(a)) === stableStringify(normalizeSpec(b));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
