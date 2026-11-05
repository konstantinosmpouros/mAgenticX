import type { WorkflowInputDef, WorkflowInputDraft, WorkflowInputErrors } from "@/shared/lib/types";

/**
 * The Run dialog's form, generated from the spec's `inputs`: each field's
 * starting value (its default), and the draft → inputs conversion with its
 * checks — required fields filled, numbers numeric, objects and arrays valid
 * JSON of the right shape. An optional field left empty is left out, so the
 * engine applies its own default. Pure: the dialog only renders.
 */

/** A default as the text box shows it (objects as indented JSON). */
function draftValue(def: WorkflowInputDef): string | boolean {
  if (def.type === "boolean") return def.default === true;
  if (def.default === undefined || def.default === null) return "";
  if (def.type === "object" || def.type === "array") {
    try {
      return JSON.stringify(def.default, null, 2);
    } catch {
      return "";
    }
  }
  return String(def.default);
}

/**
 * Whether a run needs the Run dialog first: any required input. Without one
 * a run can start straight away with no inputs (the engine applies defaults) —
 * the Automations page's "Run now".
 */
export const needsRunInputs = (defs: WorkflowInputDef[]): boolean =>
  defs.some((def) => def.required === true);

export function initialInputDraft(defs: WorkflowInputDef[]): WorkflowInputDraft {
  return Object.fromEntries(defs.map((def) => [def.name, draftValue(def)]));
}

export type BuiltRunInputs = { inputs: Record<string, unknown>; errors: WorkflowInputErrors };

export function buildRunInputs(
  defs: WorkflowInputDef[],
  draft: WorkflowInputDraft,
): BuiltRunInputs {
  const inputs: Record<string, unknown> = {};
  const errors: WorkflowInputErrors = {};
  for (const def of defs) {
    const raw = draft[def.name];
    if (def.type === "boolean") {
      inputs[def.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (def.required) errors[def.name] = "Required.";
      continue;
    }
    if (def.type === "string") {
      inputs[def.name] = typeof raw === "string" ? raw : text;
      continue;
    }
    if (def.type === "number") {
      const value = Number(text);
      if (Number.isFinite(value)) inputs[def.name] = value;
      else errors[def.name] = "Enter a number.";
      continue;
    }
    // object / array: JSON of that shape.
    try {
      const value: unknown = JSON.parse(text);
      const isArray = Array.isArray(value);
      const isObject = typeof value === "object" && value !== null && !isArray;
      if (def.type === "array" ? isArray : isObject) inputs[def.name] = value;
      else errors[def.name] = def.type === "array" ? "Enter a JSON array." : "Enter a JSON object.";
    } catch {
      errors[def.name] = "Not valid JSON.";
    }
  }
  return { inputs, errors };
}
