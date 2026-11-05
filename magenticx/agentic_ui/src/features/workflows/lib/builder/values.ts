/**
 * Values typed into the builder's text fields: a rule's value, a map entry,
 * a JSON body, a default. One rule everywhere — text that reads as JSON
 * (a number, true / false, null, an object, an array, a "quoted string") is
 * that value; anything else, `{{placeholders}}` included, is the text itself.
 * `formatLoose` is its inverse, so a value survives a round trip through the
 * field unchanged (a string that would read as a number is shown quoted).
 */

const looksJson = (text: string) =>
  /^(-?\d|true$|false$|null$|\{|\[|")/.test(text);

/** Text → value: JSON when it parses as JSON, else the text. Empty → null. */
export function parseLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (looksJson(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all (`{{state.x}}`, `3 apples`): the text itself.
    }
  }
  return text;
}

/** Value → text for `parseLoose`. */
export function formatLoose(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== value || (looksJson(trimmed) && parseLoose(value) !== value)) return JSON.stringify(value);
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A short note on what `parseLoose` made of the text, for the field's hint. */
export function describeLoose(value: unknown): string {
  if (value === null) return "empty";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return /\{\{/.test(value) ? "text with placeholders" : "text";
  return typeof value === "number" ? "a number" : typeof value === "boolean" ? "true/false" : typeof value;
}

/**
 * A default typed into a field of `type` (an input's, a state field's):
 * a string is taken as is; the other types must parse as JSON of that type.
 * Empty means "no default" (null).
 */
export function parseTyped(
  type: string,
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!text.trim()) return { ok: true, value: null };
  if (type === "string") return { ok: true, value: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: type === "boolean" ? "Write true or false." : `Write valid JSON for a ${type}.` };
  }
  const fits =
    (type === "number" && typeof value === "number") ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "array" && Array.isArray(value)) ||
    (type === "object" && Boolean(value) && typeof value === "object" && !Array.isArray(value));
  return fits ? { ok: true, value } : { ok: false, message: `That isn't a ${type}.` };
}

/** A typed default back to text. */
export function formatTyped(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "string" && typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Whether `value` is of the spec's value type (a boolean is not a number). */
export function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}
