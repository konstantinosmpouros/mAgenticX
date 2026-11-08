/**
 * How a run value (a step's input or output, a saved variable, the final
 * output) reads in the readable view: an object becomes labelled fields, a
 * long or formatted text is rendered as markdown, a list of plain values as
 * chips; anything deeper keeps the JSON tree. Pure helpers — the component is
 * `workflow_view_parts/ValueView.tsx`.
 */

export type ValueShape =
  | "empty"
  | "boolean"
  | "number"
  | "text"
  | "markdown"
  | "chips"
  | "list"
  | "records"
  | "object"
  | "tree";

/** A key as people read it: `days_since_push` → "Days since push", `openIssues` → "Open issues". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : key;
}

const MARKDOWN = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\|.+\|/;

/** Whether a text is better rendered than shown raw: markdown marks, or several lines. */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN.test(text) || text.split("\n").length > 2;
}

const isPlain = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Chips are for a short list of short plain values. */
const CHIP_MAX_ITEMS = 24;
const CHIP_MAX_CHARS = 48;
/** A bulleted list is for plain values too long for chips. */
const LIST_MAX_ITEMS = 50;
/** A table is for short cells; longer ones keep the tree. */
const RECORD_MAX_CHARS = 80;

/** The shape a value takes in the readable view. */
export function valueShape(value: unknown): ValueShape {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return looksLikeMarkdown(value) ? "markdown" : "text";
  if (Array.isArray(value)) {
    if (!value.length) return "empty";
    if (
      value.length <= CHIP_MAX_ITEMS &&
      value.every((item) => isPlain(item) && String(item).length <= CHIP_MAX_CHARS)
    ) {
      return "chips";
    }
    if (value.length <= LIST_MAX_ITEMS && value.every(isPlain)) return "list";
    if (
      value.length <= CHIP_MAX_ITEMS &&
      value.every(
        (item) =>
          isRecord(item) &&
          Object.values(item).every((cell) => isPlain(cell) && String(cell).length <= RECORD_MAX_CHARS),
      )
    ) {
      return "records";
    }
    return "tree";
  }
  if (isRecord(value)) return Object.keys(value).length ? "object" : "empty";
  return "text";
}

/** A number as people read it: thousands grouped, long decimals trimmed. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** The columns of a list of flat records: every key, in first-seen order. */
export function recordColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** How deep the readable view nests objects as fields before it hands over to the tree. */
export const READABLE_MAX_DEPTH = 2;

/** A summary line is cut to this many characters. */
const SUMMARY_MAX = 90;

const clip = (text: string): string => {
  const line = text.replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

const plainText = (value: unknown): string | null => {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && value.trim()) return value;
  return null;
};

/**
 * One line saying what a step produced, for the run feed's step cards: a text
 * answer's opening, a few short fields (`Score 93 · Status healthy`), a count
 * for a list. Empty when there is nothing worth a line.
 */
export function outputSummary(output: unknown, text?: string | null): string {
  if (text?.trim()) return clip(text);
  const direct = plainText(output);
  if (direct) return clip(direct);
  if (Array.isArray(output)) return output.length ? `${output.length} item${output.length === 1 ? "" : "s"}` : "";
  if (typeof output !== "object" || output === null) return "";
  const record = output as Record<string, unknown>;
  // A wrapper with one meaningful key (`result`, `data`, `body`, `text`): look inside it.
  for (const key of ["text", "data", "result", "body"]) {
    if (key in record && hasValue(record[key])) {
      const inner = outputSummary(record[key]);
      if (inner) return inner;
    }
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const shown = plainText(value);
    if (shown === null || shown.length > 40) continue;
    parts.push(`${humanizeKey(key)} ${shown}`);
    if (parts.length === 3) break;
  }
  return clip(parts.join(" · "));
}

const hasValue = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length);
