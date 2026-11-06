import type { WorkflowSpec } from "@/shared/lib/types";
import { SET_KIND } from "./graph";

/**
 * A workflow's variables, as the engine sees them (`docs/flows/workflows.md`):
 * nothing is declared — a variable is any name a Set step writes
 * (a key of its `config.values`). Every step may read one as
 * `{{state.<name>}}`, even before the Set that writes it (it is `null`, or
 * the value an End step's `keep` carried over from the previous run).
 */

/** The keys of one Set step's `values` (none when the config holds something else). */
function setStepNames(config: Record<string, unknown>): string[] {
  const values = config.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  return Object.keys(values);
}

/**
 * Every variable name of `spec`, each once, in the order the Set steps write
 * them; `exceptNode` leaves one step out (its own suggestions are the others').
 */
export function variableNames(spec: Pick<WorkflowSpec, "nodes">, exceptNode?: string): string[] {
  const names = new Set<string>();
  for (const node of spec.nodes) {
    if (node.kind !== SET_KIND || node.id === exceptNode) continue;
    for (const name of setStepNames(node.config)) if (name.trim()) names.add(name);
  }
  return [...names];
}
