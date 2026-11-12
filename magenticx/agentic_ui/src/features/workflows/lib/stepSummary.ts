import { HTTP_STATUS_TEXT } from "./consts";
import { formatNumber } from "./valueView";

/**
 * What a step's Output tab leads with, per node kind (see docs/flows/workflows.md
 * § Node kinds for each kind's output shape): the few facts that matter, and
 * which part of the output the tree below still shows — never what the summary
 * already said. Pure helpers — the components are
 * `workflow_view_parts/StepSummary.tsx` and `StepOutput.tsx`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A record's field, else an empty record (an output is untyped on the wire). */
export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const asText = (value: unknown): string => (typeof value === "string" ? value : "");

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** How an HTTP status reads: its class's tone and the usual reason phrase. */
export function httpStatus(status: number | null, ok: unknown) {
  const code = status ?? 0;
  const tone: "success" | "info" | "warning" | "error" | "muted" =
    code >= 500 ? "error" : code >= 400 ? "warning" : code >= 300 ? "info" : code >= 200 ? "success" : "muted";
  const text = HTTP_STATUS_TEXT[code] ?? (ok === true ? "OK" : ok === false ? "Error" : "");
  return { code, tone, text };
}

/** A URL as host and the rest (path, query), for a header that truncates the right part. */
export function splitUrl(raw: string) {
  try {
    const url = new URL(raw);
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
    return { host: url.host, rest: decodeURIComponent(rest) };
  } catch {
    return { host: raw, rest: "" };
  }
}

/** `application/json; charset=utf-8` → "JSON", `text/html` → "HTML". */
export function shortContentType(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (!base) return "";
  if (base.endsWith("json") || base.endsWith("+json")) return "JSON";
  const sub = base.split("/")[1] ?? base;
  if (["html", "xml", "csv", "plain", "javascript"].includes(sub)) return sub === "plain" ? "Text" : sub.toUpperCase();
  return base;
}

/** The size a payload takes as JSON text (its bytes), e.g. "12.4 KB". */
export function payloadSize(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `openai:gpt-4o-mini` → provider "openai", name "gpt-4o-mini". */
export function splitModel(model: string) {
  const at = model.indexOf(":");
  return at > 0 ? { provider: model.slice(0, at), name: model.slice(at + 1) } : { provider: "", name: model };
}

/** A stream's non-empty line count, for a folded stdout / stderr. */
export const lineCount = (text: string): number => (text ? text.replace(/\n$/, "").split("\n").length : 0);

/** Kinds whose output the summary fully says: no tree below it, only the raw payload. */
const SUMMARY_ONLY = new Set(["condition", "router", "loop", "set", "wait", "approval"]);

/** An llm turn's keys the tree leaves out once its reply is rendered above (the Saved tab shows the turn). */
const REPLY_KEYS = new Set(["text", "messages", "model"]);

/** A record without the keys of a rendered reply; anything else as it is. */
export function withoutReply(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !REPLY_KEYS.has(key)));
}

/**
 * The part of a step's output the tree shows under the summary, and its
 * heading. `value` undefined: the summary says it all (the raw JSON stays one
 * click away).
 */
export function outputTree(kind: string, output: unknown): { title: string; value: unknown } {
  const record = asRecord(output);
  if (SUMMARY_ONLY.has(kind)) return { title: "Output", value: undefined };
  switch (kind) {
    case "fetch":
      return { title: "Response body", value: record.body };
    case "llm":
      // Text mode: the reply is rendered above. JSON mode: its answer object.
      return "data" in record ? { title: "Answer", value: record.data } : { title: "Answer", value: undefined };
    case "code":
    case "tool":
      return { title: "Result", value: record.result };
    case "trigger.manual":
      return { title: "Run inputs", value: output };
    case "trigger.schedule":
      return { title: "Run inputs", value: record.inputs };
    case "end":
      return { title: "Result", value: output };
    default:
      return { title: "Output", value: output };
  }
}

/** A small value opens a level deeper (an llm answer's reasons); a large one shows its top level only. */
const SMALL_TREE_BYTES = 1500;
export function treeOpenDepth(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "").length <= SMALL_TREE_BYTES ? 2 : 1;
  } catch {
    return 1;
  }
}
