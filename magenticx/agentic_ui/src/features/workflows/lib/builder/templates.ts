import type { WorkflowSpec, WorkflowTemplatePath } from "@/shared/lib/types";
import { upstreamOf } from "./graph";

/**
 * What a templated field may read — the template helper's list. The engine's
 * roots only (`docs/flows/workflows.md` § Templating): `input.<name>`,
 * `state.<name>`, `nodes.<id>.output[.<path>]`, and `output[.<path>]` inside
 * `assign` (the node's own result). Node outputs are offered for the nodes
 * that come before this one, with the fields each kind is known to return.
 */

/** The fields a kind's output is known to have (`docs/flows/workflows.md`, node catalogue). */
const OUTPUT_FIELDS: Record<string, string[]> = {
  tool: ["result"],
  fetch: ["status", "ok", "url", "contentType", "body"],
  condition: ["result"],
  router: ["case"],
  loop: ["iteration", "continue"],
  approval: ["decision", "comment"],
  // `text` in text mode, `data` in JSON mode.
  llm: ["text", "data", "model"],
  wait: ["waitedSeconds"],
  code: ["result", "stdout", "stderr", "exitCode", "durationMs"],
};

/** A node's known output paths, below `<prefix>` (`nodes.poll.output` or `output`). */
function outputPaths(
  spec: WorkflowSpec,
  kind: string,
  prefix: string,
): string[] {
  if (kind.startsWith("trigger.")) {
    // A trigger's output is the run's inputs.
    return [prefix, ...spec.inputs.filter((i) => i.name).map((i) => `${prefix}.${i.name}`)];
  }
  return [prefix, ...(OUTPUT_FIELDS[kind] ?? []).map((field) => `${prefix}.${field}`)];
}

/**
 * The paths a field of `nodeId` may use. `inAssign`: the field is an
 * `assign` value, which may also read the node's own `output`.
 */
export function templatePaths(
  spec: WorkflowSpec,
  nodeId: string | null,
  options: { inAssign?: boolean } = {},
): WorkflowTemplatePath[] {
  const paths: WorkflowTemplatePath[] = [];
  for (const input of spec.inputs) {
    if (input.name) paths.push({ path: `input.${input.name}`, group: "input", hint: input.type });
  }
  for (const field of spec.state) {
    if (field.name) paths.push({ path: `state.${field.name}`, group: "state", hint: field.type });
  }
  if (nodeId) {
    const before = upstreamOf(nodeId, spec.edges);
    for (const node of spec.nodes) {
      if (!before.has(node.id)) continue;
      for (const path of outputPaths(spec, node.kind, `nodes.${node.id}.output`)) {
        paths.push({ path, group: "node", hint: node.label?.trim() || node.id });
      }
    }
    if (options.inAssign) {
      const self = spec.nodes.find((node) => node.id === nodeId);
      if (self) {
        for (const path of outputPaths(spec, self.kind, "output")) {
          paths.push({ path, group: "output", hint: "this step's result" });
        }
      }
    }
  }
  return paths;
}

/** `path` as a placeholder: `{{nodes.poll.output.status}}`. */
export const placeholder = (path: string): string => `{{${path}}}`;

/**
 * Rewrite every reference to node `from` in a config (string values, deep) to
 * `to`: `{{nodes.from.output.x}}` in templates and `nodes.from.output.x` in
 * rule paths. Keys, numbers and booleans are left alone, as the engine only
 * templates string values.
 */
export function renameNodeReferences(value: unknown, from: string, to: string): unknown {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])nodes\\.${from.replace(/[-]/g, "\\-")}(?=$|[.}\\s])`, "g");
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(pattern, `$1nodes.${to}`);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    }
    return item;
  };
  return walk(value);
}
