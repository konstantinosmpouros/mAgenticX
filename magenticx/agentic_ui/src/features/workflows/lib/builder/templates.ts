import type {
  WorkflowNodeDef,
  WorkflowSpec,
  WorkflowTemplatePath,
  WorkflowTemplateRefLabel,
  WorkflowTemplateSegment,
  WorkflowTemplateSource,
} from "@/shared/lib/types";
import { JOIN_KIND, LLM_KIND, loopBodyNodes, upstreamDistances } from "./graph";
import { variableNames } from "./variables";

/**
 * What a templated field may read, and how a template reads to a person.
 * Templates stay the storage format — the engine's roots only
 * (`docs/flows/workflows.md` § Templating): `input.<name>`, `state.<name>`,
 * `nodes.<id>.output[.<path>]` (its latest execution) and
 * `nodes.<id>.outputs[.<n>[.<path>]]` (every execution's output, oldest
 * first — what a step that runs in a loop offers as `Every run` and
 * `Run 1`, `Run 2`, …). Each offered path carries a friendly name
 * (`Fetch page › Body`, `Fetch page › Run 2`) so the builder never has to
 * show the raw path to someone who is not a developer.
 */

type OutputField = { key: string; label: string; hint: string; more?: boolean };

/** The fields a kind's output is known to have (`docs/flows/workflows.md`, node catalogue). */
const OUTPUT_FIELDS: Record<string, OutputField[]> = {
  tool: [{ key: "result", label: "Result", hint: "any" }],
  fetch: [
    { key: "body", label: "Body", hint: "text / object" },
    { key: "status", label: "Status code", hint: "number" },
    { key: "ok", label: "Succeeded", hint: "yes / no" },
    { key: "url", label: "URL", hint: "text" },
    { key: "contentType", label: "Content type", hint: "text" },
  ],
  condition: [{ key: "result", label: "Result", hint: "yes / no" }],
  router: [{ key: "case", label: "Chosen case", hint: "text" }],
  loop: [
    { key: "iteration", label: "Iteration", hint: "number" },
    { key: "continue", label: "Continues", hint: "yes / no" },
  ],
  approval: [
    { key: "decision", label: "Decision", hint: "text" },
    { key: "comment", label: "Comment", hint: "text" },
  ],
  wait: [{ key: "waitedSeconds", label: "Seconds waited", hint: "number" }],
  code: [
    { key: "result", label: "Result", hint: "any" },
    { key: "stdout", label: "Printed output", hint: "text" },
    { key: "stderr", label: "Errors", hint: "text" },
    { key: "exitCode", label: "Exit code", hint: "number" },
    { key: "durationMs", label: "Duration (ms)", hint: "number" },
  ],
};

const SOURCE_INPUT = "Run input";
const SOURCE_STATE = "Variable";

/** A looped step's sub-headings in the picker: its latest execution, then its runs one by one. */
const SECTION_LAST = "Last run";
const SECTION_RUNS = "Runs";

/** How many single runs (`Run 1`…) a looped step offers up front; search reaches any other (`run 7`). */
const OFFERED_RUNS = 5;

/** The friendly name of `nodes.<id>.outputs.<index>` (0-based): `Run <index + 1>`. */
const runLabel = (index: number): string => `Run ${index + 1}`;

/** One run of a looped step, as a picker entry (`nodes.fetch.outputs.1` → `Run 2`). */
function runEntry(every: WorkflowTemplatePath, index: number): WorkflowTemplatePath {
  return { ...every, path: `${every.path}.${index}`, label: runLabel(index), hint: "object", section: SECTION_RUNS };
}

/** A JSON schema's top-level properties; the schema may be stored as text. */
function schemaProperties(schema: unknown): Array<{ name: string; title?: string; type?: string }> {
  let value = schema;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const properties = (value as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>).map(([name, prop]) => {
    const spec = prop && typeof prop === "object" ? (prop as { title?: unknown; type?: unknown }) : {};
    return {
      name,
      title: typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : undefined,
      type: typeof spec.type === "string" ? spec.type : undefined,
    };
  });
}

/**
 * An llm step's output: its final answer first (`text`, or `data` in JSON
 * mode, then each top-level property of its JSON schema). The model and the
 * conversation (`messages`) stay reachable, under "More" — the answer is what
 * a step hands on.
 */
function llmFields(node: WorkflowNodeDef): OutputField[] {
  const json = node.config.output === "json";
  const answer: OutputField = json
    ? { key: "data", label: "Answer", hint: "object" }
    : { key: "text", label: "Answer", hint: "text" };
  const props = json
    ? schemaProperties(node.config.json_schema).map((prop) => ({
        key: `data.${prop.name}`,
        label: prop.title ?? prop.name,
        hint: prop.type ?? "any",
      }))
    : [];
  return [
    answer,
    ...props,
    { key: "model", label: "Model", hint: "text", more: true },
    { key: "messages", label: "Conversation", hint: "list", more: true },
  ];
}

/**
 * A "Wait for all" step's output: one entry per parallel path, keyed by the
 * path's last step (`{a_set: …, b_set: …}`), named after that step.
 */
function joinFields(node: WorkflowNodeDef, spec: WorkflowSpec): OutputField[] {
  return spec.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const source = spec.nodes.find((other) => other.id === edge.source);
      return { key: edge.source, label: source?.label?.trim() || edge.source, hint: "any" };
    });
}

/** A node's known output paths below `prefix` (`nodes.poll.output`), the whole result last. */
function outputEntries(
  node: WorkflowNodeDef,
  prefix: string,
  base: Pick<WorkflowTemplatePath, "group" | "source" | "nodeId" | "kind">,
  spec: WorkflowSpec,
): WorkflowTemplatePath[] {
  const trigger = node.kind.startsWith("trigger.");
  // A trigger's output is the run's inputs, which `input.<name>` already offers:
  // only its whole result is listed (so `nodes.start.output.x` still reads by name).
  const fields: OutputField[] = trigger
    ? []
    : node.kind === LLM_KIND
      ? llmFields(node)
      : node.kind === JOIN_KIND
        ? joinFields(node, spec)
        : (OUTPUT_FIELDS[node.kind] ?? []);
  const entries: WorkflowTemplatePath[] = fields.map((field) => ({
    ...base,
    path: `${prefix}.${field.key}`,
    label: field.label,
    hint: field.hint,
    ...(field.more ? { more: true } : {}),
  }));
  entries.push({
    ...base,
    path: prefix,
    label: "Whole result",
    hint: "object",
    // Offered up front only when nothing finer is known about the kind.
    ...(fields.length || trigger ? { more: true } : {}),
  });
  return entries;
}

/**
 * The paths a field of `nodeId` may use, each with its friendly name: the
 * steps before it nearest first, the run's inputs and every variable of the
 * workflow (a variable is readable anywhere: before its Set step runs it
 * holds `null`, or the value kept from the previous run). A step that runs
 * in a loop (`loopBodyNodes`) is offered run by run: its fields as the
 * `Last run`, then `Every run` (`nodes.<id>.outputs`) and `Run 1`…`Run 5`
 * (`nodes.<id>.outputs.<n>`) — for the steps in its loop and the steps
 * after it alike.
 */
export function templatePaths(spec: WorkflowSpec, nodeId: string | null): WorkflowTemplatePath[] {
  const paths: WorkflowTemplatePath[] = [];
  if (nodeId) {
    const distances = upstreamDistances(nodeId, spec.edges);
    const looped = loopBodyNodes(spec);
    const order = new Map(spec.nodes.map((node, index) => [node.id, index]));
    const before = spec.nodes
      .filter((node) => distances.has(node.id))
      .sort(
        (a, b) =>
          (distances.get(a.id) ?? 0) - (distances.get(b.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
    for (const node of before) {
      const base = { group: "node" as const, source: node.label?.trim() || node.id, nodeId: node.id, kind: node.kind };
      const entries = outputEntries(node, `nodes.${node.id}.output`, base, spec);
      if (!looped.has(node.id)) {
        paths.push(...entries);
        continue;
      }
      const every: WorkflowTemplatePath = {
        ...base,
        path: `nodes.${node.id}.outputs`,
        label: "Every run",
        hint: "list",
        section: SECTION_RUNS,
      };
      paths.push(
        ...entries.map((entry) => (entry.more ? entry : { ...entry, section: SECTION_LAST })),
        every,
        ...Array.from({ length: OFFERED_RUNS }, (_, index) => runEntry(every, index)),
      );
    }
  }
  for (const input of spec.inputs) {
    if (input.name) {
      paths.push({ path: `input.${input.name}`, group: "input", hint: input.type, source: SOURCE_INPUT, label: input.name });
    }
  }
  for (const name of variableNames(spec)) {
    paths.push({ path: `state.${name}`, group: "state", hint: "any", source: SOURCE_STATE, label: name });
  }
  return paths;
}

/** A search for one run: `run 7`, `Run 12`. */
const RUN_QUERY = /^\s*run\s*(\d{1,4})\s*$/i;

/**
 * The single runs a search asks for beyond the ones offered up front:
 * `run 7` adds `Run 7` (`nodes.<id>.outputs.6`) under every looped step of
 * `paths` that does not list it yet.
 */
export function runSearchEntries(paths: readonly WorkflowTemplatePath[], query: string): WorkflowTemplatePath[] {
  const match = RUN_QUERY.exec(query);
  const run = match ? Number(match[1]) : 0;
  if (run < 1) return [];
  const listed = new Set(paths.map((entry) => entry.path));
  return paths
    .filter((entry) => entry.group === "node" && entry.path.endsWith(".outputs"))
    .map((every) => runEntry(every, run - 1))
    .filter((entry) => !listed.has(entry.path));
}

const GROUP_TITLES: Record<WorkflowTemplatePath["group"], string> = {
  node: "",
  input: "Run inputs",
  state: "Variables",
};

/** `paths` by source, in the order offered: each earlier step, run inputs, variables. */
export function groupTemplatePaths(paths: readonly WorkflowTemplatePath[]): WorkflowTemplateSource[] {
  const sources = new Map<string, WorkflowTemplateSource>();
  for (const entry of paths) {
    const key = entry.group === "node" ? `node:${entry.nodeId ?? entry.source}` : entry.group;
    let source = sources.get(key);
    if (!source) {
      source = {
        key,
        group: entry.group,
        title: entry.group === "node" ? entry.source : GROUP_TITLES[entry.group],
        nodeId: entry.nodeId,
        kind: entry.kind,
        entries: [],
      };
      sources.set(key, source);
    }
    source.entries.push(entry);
  }
  return [...sources.values()];
}

/** Whether `entry` matches a search over its name, its run (`Last run`), its source and its path. */
export function templatePathMatches(entry: WorkflowTemplatePath, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.label, entry.section ?? "", entry.source, entry.path].some((text) => text.toLowerCase().includes(needle));
}

/** A `{{path}}` placeholder, whitespace inside the braces allowed (the engine trims it). */
const TEMPLATE_REF = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** A template as runs of text and `{{path}}` placeholders; joining every run's text gives it back exactly. */
export function parseTemplate(value: string): WorkflowTemplateSegment[] {
  const segments: WorkflowTemplateSegment[] = [];
  let at = 0;
  for (const match of value.matchAll(TEMPLATE_REF)) {
    const start = match.index ?? 0;
    if (start > at) segments.push({ type: "text", text: value.slice(at, start) });
    segments.push({ type: "ref", path: match[1], raw: match[0] });
    at = start + match[0].length;
  }
  if (at < value.length) segments.push({ type: "text", text: value.slice(at) });
  return segments;
}

/** The output root (`nodes.x.output`): a path below it reads by its tail alone. */
const isOutputRoot = (path: string): boolean => path.endsWith(".output");

/**
 * How a placeholder's path reads in a field, given what the field may read:
 * the offered entry it is (`Fetch page › Body`, `Fetch page › Run 2`) or lies
 * below (`Fetch page › Body › items`, `Fetch page › Run 2 › body`; a run
 * past the offered ones reads `Fetch page › Run 7`, never `Every run › …`).
 * A path whose root or source the field cannot read is invalid.
 */
export function describeTemplateRef(path: string, paths: readonly WorkflowTemplatePath[]): WorkflowTemplateRefLabel {
  const target = path.trim();
  let best: WorkflowTemplatePath | null = null;
  for (const entry of paths) {
    if (target === entry.path || target.startsWith(`${entry.path}.`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  if (!target || !best) return { source: "", label: target || path, valid: false };
  if (target === best.path) return { source: best.source, label: best.label, valid: true };
  const tail = target.slice(best.path.length + 1).split(".");
  if (best.path.endsWith(".outputs") && /^\d+$/.test(tail[0])) {
    // One run of a looped step: the run is named in place of `Every run`.
    return { source: best.source, label: [runLabel(Number(tail[0])), ...tail.slice(1)].join(" › "), valid: true };
  }
  const label = isOutputRoot(best.path) ? tail.join(" › ") : [best.label, ...tail].join(" › ");
  return { source: best.source, label, valid: true };
}

/** `path` as a placeholder: `{{nodes.poll.output.status}}`. */
export const placeholder = (path: string): string => `{{${path}}}`;

/**
 * Rewrite every reference to node `from` in a config (string values, deep) to
 * `to`: `{{nodes.from.output.x}}` and `{{nodes.from.outputs}}` in templates
 * and `nodes.from.output.x` in rule paths. Keys, numbers and booleans are left
 * alone, as the engine only templates string values.
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
