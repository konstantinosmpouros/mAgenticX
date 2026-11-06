import type {
  WorkflowToolArg,
  WorkflowToolArgType,
  WorkflowToolGroup,
  WorkflowToolInfo,
  WorkflowToolRef,
} from "@/shared/lib/types";
import { TOOL_GROUP_BUILTIN, TOOL_GROUP_MCP } from "./consts";
import { humanize, resolveRef } from "./schemaForm";

/**
 * The tool step's picker and arguments, read from the tool list
 * (`GET /v1/workflows/tools`): which tool a config names, the tool's
 * arguments from its input JSON Schema (an MCP server's own, so every key is
 * read defensively), the picker's groups and search, how a typed argument is
 * stored (a plain number literal for a number argument as a number, anything
 * else — a `{{placeholder}}` included — as text), and the checks a config's
 * arguments get once the tool is known. Pure: no React.
 */

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const ARG_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "object", "array"]);

/** A plain number literal (`3`, `-0.5`, `1e3`): a number argument stores it as a number. */
const NUMBER_LITERAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** The tool a config names (`config.tool`), or null when none is picked. */
export function asToolRef(value: unknown): WorkflowToolRef | null {
  if (!isRecord(value)) return null;
  const name = str(value.name).trim();
  if (!name) return null;
  return { source: value.source === "mcp" ? "mcp" : "native", name };
}

/** The listed tool a config names (same source and name), or null. */
export function findTool(tools: readonly WorkflowToolInfo[], ref: WorkflowToolRef | null): WorkflowToolInfo | null {
  if (!ref) return null;
  return tools.find((tool) => tool.source === ref.source && tool.name === ref.name) ?? null;
}

/** The picker's group label for a tool: "Built-in" for a native one, else its server. */
export const toolGroupLabel = (tool: Pick<WorkflowToolInfo, "source" | "server">): string =>
  tool.source === "native" ? TOOL_GROUP_BUILTIN : tool.server || TOOL_GROUP_MCP;

/** Whether a tool matches a search: every word in its name, server or description. */
export function toolMatches(tool: WorkflowToolInfo, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = `${tool.name} ${toolGroupLabel(tool)} ${tool.description}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The tools matching `query`, grouped: "Built-in" first, then each server in the list's order. */
export function groupTools(tools: readonly WorkflowToolInfo[], query = ""): WorkflowToolGroup[] {
  const groups = new Map<string, WorkflowToolGroup>();
  for (const tool of tools) {
    if (!toolMatches(tool, query)) continue;
    const label = toolGroupLabel(tool);
    const key = `${tool.source}:${label}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label, tools: [] };
      groups.set(key, group);
    }
    group.tools.push(tool);
  }
  const all = [...groups.values()];
  return [...all.filter((group) => group.key.startsWith("native:")), ...all.filter((group) => !group.key.startsWith("native:"))];
}

/** The one non-null branch of an `anyOf` / `oneOf` (an optional value), or null. */
function singleBranch(schema: Schema, root: Schema): Schema | null {
  const branches = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (!branches) return null;
  const real = branches.map((branch) => resolveRef(branch, root)).filter((branch) => branch.type !== "null");
  return real.length === 1 ? real[0] : null;
}

/** What an argument's schema holds, as the control that edits it. */
function argType(schema: Schema, root: Schema, depth = 0): WorkflowToolArgType {
  const type = schema.type;
  if (typeof type === "string" && ARG_TYPES.has(type)) return type as WorkflowToolArgType;
  if (Array.isArray(type)) {
    const real = type.filter((entry): entry is string => typeof entry === "string" && entry !== "null");
    return real.length === 1 && ARG_TYPES.has(real[0]) ? (real[0] as WorkflowToolArgType) : "unknown";
  }
  const branch = depth < 4 ? singleBranch(schema, root) : null;
  if (branch) return argType(branch, root, depth + 1);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const kinds = new Set(schema.enum.map((option) => typeof option));
    if (kinds.size === 1 && kinds.has("string")) return "string";
    if (kinds.size === 1 && kinds.has("number")) return "number";
    if (kinds.size === 1 && kinds.has("boolean")) return "boolean";
  }
  if (isRecord(schema.properties)) return "object";
  if ("items" in schema) return "array";
  return "unknown";
}

/** The schema's fixed choices (on it, or on its one non-null branch), plain values only. */
function argOptions(schema: Schema, root: Schema): Array<string | number | boolean> | null {
  const source = Array.isArray(schema.enum) ? schema : singleBranch(schema, root);
  const values = source && Array.isArray(source.enum) ? source.enum : [];
  const options = values.filter(
    (option): option is string | number | boolean =>
      typeof option === "string" || typeof option === "number" || typeof option === "boolean",
  );
  return options.length ? options : null;
}

/** `maxResults` / `max_results` → "Max results"; the schema's own title when it has one. */
const argLabel = (name: string, title: string): string =>
  humanize(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"), title);

/** A tool's arguments, in its schema's order, from its input JSON Schema. */
export function toolArgs(inputSchema: Schema): WorkflowToolArg[] {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.filter((key) => typeof key === "string") : []);
  return Object.entries(properties).map(([name, raw]) => {
    const schema = resolveRef(raw, inputSchema);
    const hasDefault = "default" in schema && schema.default !== null;
    return {
      name,
      label: argLabel(name, str(schema.title)),
      description: str(schema.description).trim(),
      type: argType(schema, inputSchema),
      required: required.has(name),
      options: argOptions(schema, inputSchema),
      hasDefault,
      ...(hasDefault ? { default: schema.default } : {}),
    };
  });
}

/** A config's arguments as a map (anything else read as none). */
export const asArgs = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** The arguments kept when another tool is picked: only the names the new tool takes. */
export function pruneArgs(args: unknown, tool: WorkflowToolInfo): Record<string, unknown> {
  const names = new Set(toolArgs(tool.inputSchema).map((arg) => arg.name));
  return Object.fromEntries(Object.entries(asArgs(args)).filter(([name]) => names.has(name)));
}

/** Whether a value holds a `{{placeholder}}` (so it is read at run time, whatever the argument's type). */
export const isTemplated = (value: unknown): value is string => typeof value === "string" && value.includes("{{");

/** A value as the text its field shows. */
export function argText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Typed text as stored: a number argument's plain number literal as a number, anything else as the text. */
export function argFromText(type: WorkflowToolArgType, text: string): unknown {
  if ((type === "number" || type === "integer") && NUMBER_LITERAL.test(text.trim())) return Number(text.trim());
  return text;
}

export type ToolArgProblem = { field: string; message: string };

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && !value.trim());

/**
 * A tool step's arguments against the picked tool's schema, each addressed
 * as `<where>.<name>`: a required one missing or empty, a number argument
 * holding text that is no number (a placeholder is fine), an added optional
 * one of a non-text type left empty.
 */
export function toolArgProblems(tool: WorkflowToolInfo, args: unknown, where = "config.args"): ToolArgProblem[] {
  const values = asArgs(args);
  const problems: ToolArgProblem[] = [];
  for (const arg of toolArgs(tool.inputSchema)) {
    const field = `${where}.${arg.name}`;
    const present = arg.name in values;
    const value = values[arg.name];
    if (isBlank(value)) {
      if (arg.required) problems.push({ field, message: `'${arg.name}' is required.` });
      else if (present && arg.type !== "string" && arg.type !== "unknown") {
        problems.push({ field, message: `'${arg.name}' needs a value, or remove it.` });
      }
      continue;
    }
    if ((arg.type === "number" || arg.type === "integer") && typeof value === "string" && !isTemplated(value)) {
      problems.push({ field, message: `'${arg.name}' must be a number.` });
    } else if (arg.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
      problems.push({ field, message: `'${arg.name}' must be a whole number.` });
    }
  }
  return problems;
}

/** A tool step's card subtitle: the picked tool's name. */
export const toolNodeSubtitle = (config: Record<string, unknown>): string | null => asToolRef(config.tool)?.name ?? null;
