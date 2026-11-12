/**
 * How the step inspector lays out a kind's settings: which field rides in
 * the header as a quiet pill (an HTTP step's method, an LLM step's model),
 * which ones are tucked under "More options" (what most steps never touch:
 * timeouts, headers, token caps), and which only make sense in some
 * configurations (a request body only for POST). Everything not named here
 * stays in the main form, so a kind added to the catalogue still shows all
 * its settings.
 */
import type { WorkflowFormField } from "@/shared/lib/types";

type KindLayout = {
  /** A short enum shown as a pill beside the kind's name. */
  header?: string;
  /** Fields folded under "More options". */
  more?: readonly string[];
  /** Fields shown only while the config asks for them (or already holds a value). */
  showWhen?: Readonly<Record<string, (config: Record<string, unknown>) => boolean>>;
};

const KIND_LAYOUTS: Readonly<Record<string, KindLayout>> = {
  fetch: {
    header: "method",
    more: ["headers", "query", "response_type", "timeout_seconds"],
    showWhen: { body: (config) => config.method === "POST" },
  },
  llm: { header: "model", more: ["max_output_tokens", "timeout_seconds"] },
  tool: { more: ["timeout_seconds"] },
  code: { more: ["timeout_seconds"] },
};

/** What a map's add action says, by field: "Add header" rather than "Add entry". */
const MAP_ADD_LABELS: Readonly<Record<string, string>> = {
  headers: "Add header",
  query: "Add parameter",
  inputs: "Add input",
  outputs: "Add output",
  args: "Add argument",
};

export const mapAddLabel = (key: string): string => MAP_ADD_LABELS[key] ?? "Add entry";

/**
 * A field's label as the form shows it: a duration's unit moves into the
 * control ("Timeout" with "sec" inside the box), so the label stays a noun.
 */
export const fieldLabel = (key: string, label: string): string =>
  key.endsWith("_seconds") ? label.replace(/\s*\(?seconds?\)?\s*$/i, "") || label : label;

/** The unit shown inside a number field, from its key. */
export const fieldUnit = (key: string): string | null => (key.endsWith("_seconds") ? "sec" : null);

/** Enums with at most this many choices are a segmented control, not a dropdown. */
export const SEGMENTED_MAX_OPTIONS = 3;

/** Display names for enum values the schema spells in lower case or as codes. */
const ENUM_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto",
  json: "JSON",
  text: "Text",
  continue: "Continue",
  fresh: "Fresh",
  all: "All",
  any: "Any",
};

/** How an enum value reads in a control: `json` → "JSON", a model id without its provider. */
export function enumLabel(value: string): string {
  if (ENUM_LABELS[value]) return ENUM_LABELS[value];
  const cut = value.indexOf(":");
  return cut > 0 ? value.slice(cut + 1) : value;
}

const hasValue = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) &&
  !(Array.isArray(value) && value.length === 0);

/** A field the user has set to something other than its default. */
export function isCustomised(field: WorkflowFormField, config: Record<string, unknown>): boolean {
  const value = config[field.key];
  if (!hasValue(value)) return false;
  return !(field.hasDefault && JSON.stringify(value) === JSON.stringify(field.default));
}

export type InspectorFields = {
  header: WorkflowFormField | null;
  main: WorkflowFormField[];
  more: WorkflowFormField[];
};

/**
 * A kind's fields, split for the inspector. A conditional field stays visible
 * while it holds a value, so switching POST back to GET never hides a body
 * the step still sends.
 */
export function splitInspectorFields(
  kind: string,
  fields: readonly WorkflowFormField[],
  config: Record<string, unknown>,
): InspectorFields {
  const layout = KIND_LAYOUTS[kind] ?? {};
  const more = new Set(layout.more ?? []);
  const result: InspectorFields = { header: null, main: [], more: [] };
  for (const field of fields) {
    if (field.key === layout.header && field.widget === "enum" && field.options?.length) {
      result.header = field;
      continue;
    }
    const when = layout.showWhen?.[field.key];
    if (when && !when(config) && !hasValue(config[field.key])) continue;
    (more.has(field.key) ? result.more : result.main).push(field);
  }
  return result;
}
