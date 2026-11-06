import type {
  WorkflowFormField,
  WorkflowMapValueKind,
  WorkflowMatchMode,
  WorkflowRouterCase,
  WorkflowRule,
  WorkflowRuleOp,
} from "@/shared/lib/types";
import { CONTEXT_COUNT_MAX, CONTEXT_COUNT_MIN, CONTEXT_MODES, CONTEXT_STEPS_MAX } from "./consts";
import { asContext } from "./stepData";

/**
 * A node kind's config JSON Schema (Pydantic's `model_json_schema()`, from
 * `GET /v1/workflows/catalog`) read as a form: one field per property, each
 * with the widget that edits it. The shapes the catalogue uses get their own
 * editors — rule lists (`rules`, `while`), router `cases`, string / scalar
 * maps (`headers`, `query`, `args`, `outputs`), a `$ref` object (`tool`) as
 * nested fields — and anything else (`body`, `payload`, a shape we don't
 * know) falls back to a JSON editor. A property's `"x-widget"` hint (`code`,
 * `json`, `assign` — a Set step's variable → template map —, `keep` — an End
 * step's variables for the next run —, `context`, `thread`; on the property
 * or inside an optional's `anyOf` branch) picks its editor outright.
 * Pure: no React.
 */

type Schema = Record<string, unknown>;

export const RULE_OPS: ReadonlyArray<{ op: WorkflowRuleOp; label: string; unary: boolean }> = [
  { op: "eq", label: "equals", unary: false },
  { op: "ne", label: "does not equal", unary: false },
  { op: "gt", label: ">", unary: false },
  { op: "gte", label: "≥", unary: false },
  { op: "lt", label: "<", unary: false },
  { op: "lte", label: "≤", unary: false },
  { op: "contains", label: "contains", unary: false },
  { op: "exists", label: "exists", unary: true },
  { op: "empty", label: "is empty", unary: true },
];

export const isUnaryOp = (op: string): boolean =>
  RULE_OPS.some((entry) => entry.op === op && entry.unary);

/** A rule path: a bare dotted path (no braces), as the engine's `Rule.path`. */
export const RULE_PATH_PATTERN = /^[A-Za-z0-9_.-]{1,512}$/;

const isRecord = (value: unknown): value is Schema =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Follow a local `$ref` (`#/$defs/Rule`) against the root schema; anything else as is. */
export function resolveRef(schema: unknown, root: Schema): Schema {
  if (!isRecord(schema)) return {};
  const ref = str(schema.$ref);
  if (!ref.startsWith("#/")) return schema;
  let target: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    target = isRecord(target) ? target[part] : undefined;
  }
  // `$ref` alongside siblings (description, default): the siblings win.
  const { $ref: _ignored, ...rest } = schema;
  return isRecord(target) ? { ...target, ...rest } : rest;
}

/** `timeout_seconds` → "Timeout seconds"; the schema's own title when it has one. */
export function humanize(key: string, title?: string): string {
  const base = title && title.trim() ? title.trim() : key.replace(/[_-]+/g, " ");
  const lower = base.toLowerCase();
  const words = lower.charAt(0).toUpperCase() + lower.slice(1);
  return words.replace(/\burl\b/i, "URL").replace(/\bid\b/i, "ID");
}

/** The ref name of an array's items, if they are a `$ref` (`Rule`, `RouterCase`). */
const itemRefName = (schema: Schema): string => {
  const items = schema.items;
  if (!isRecord(items)) return "";
  const ref = str(items.$ref);
  return ref.split("/").pop() ?? "";
};

const looksLikeRule = (schema: Schema): boolean => {
  const props = isRecord(schema.properties) ? schema.properties : {};
  return "path" in props && "op" in props;
};

const looksLikeCase = (schema: Schema, root: Schema): boolean => {
  const props = isRecord(schema.properties) ? schema.properties : {};
  if (!("name" in props) || !("rules" in props)) return false;
  return looksLikeRule(resolveRef(isRecord(props.rules) ? props.rules.items : null, root));
};

const mentionsTemplates = (description: string): boolean => /template/i.test(description);

function mapValueKind(additional: unknown): WorkflowMapValueKind {
  if (!isRecord(additional)) return "any";
  if (additional.type === "string") return "string";
  const options = Array.isArray(additional.anyOf) ? additional.anyOf : [];
  if (
    options.length &&
    options.every(
      (option) =>
        isRecord(option) && ["string", "number", "integer", "boolean"].includes(str(option.type)),
    )
  ) {
    return "scalar";
  }
  return "any";
}

/** The `"x-widget"` hints a catalogue schema may carry on a property. */
const X_WIDGETS = new Set(["code", "json", "assign", "keep", "context", "thread"]);

/**
 * An optional property (`x: T | None`) as Pydantic writes it — `anyOf: [T,
 * {type: null}]` — read as `T`, the outer keys (title, description, default,
 * an `x-widget`) winning; any other `anyOf` is left as is (the JSON editor).
 */
function unwrapOptional(schema: Schema, root: Schema): Schema {
  if (!Array.isArray(schema.anyOf)) return schema;
  const branches = schema.anyOf.map((branch) => resolveRef(branch, root));
  const real = branches.filter((branch) => branch.type !== "null");
  if (real.length !== 1 || real.length === branches.length) return schema;
  const { anyOf: _anyOf, ...outer } = schema;
  return { ...real[0], ...outer };
}

/** The property's `"x-widget"` hint, on the property itself or on one of its `anyOf` branches. */
function xWidget(schema: Schema, root: Schema): string {
  const own = str(schema["x-widget"]);
  if (own) return own;
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  for (const branch of branches) {
    const hint = str(resolveRef(branch, root)["x-widget"]);
    if (hint) return hint;
  }
  return "";
}

/** One property's field. */
function fieldFor(key: string, raw: unknown, root: Schema, required: boolean): WorkflowFormField {
  const resolved = resolveRef(raw, root);
  const hint = xWidget(resolved, root);
  const schema = unwrapOptional(resolved, root);
  const description = str(schema.description);
  const type = str(schema.type);
  const base: WorkflowFormField = {
    key,
    label: humanize(key, str(schema.title)),
    description,
    required,
    widget: "json",
    hasDefault: "default" in schema,
    templated: mentionsTemplates(description),
    ...("default" in schema ? { default: schema.default } : {}),
  };

  // The schema's own widget hint wins over guessing from the shape.
  if (X_WIDGETS.has(hint)) {
    if (hint === "code") {
      // Code is never templated: a `{{` in it is the program's own text.
      return {
        ...base,
        widget: "code",
        templated: false,
        minLength: num(schema.minLength),
        maxLength: num(schema.maxLength),
      };
    }
    if (hint === "json") {
      return {
        ...base,
        widget: "json",
        templated: false,
        strictJson: true,
        jsonType: type || undefined,
        // The llm step's reply shape: a JSON Schema, so the structured-output builder applies.
        ...(key === "json_schema" ? { jsonSchema: true } : {}),
      };
    }
    if (hint === "context") {
      // Step ids, never templates.
      return { ...base, widget: "context", templated: false };
    }
    if (hint === "thread") {
      return {
        ...base,
        widget: "thread",
        templated: false,
        maxLength: num(schema.maxLength),
        pattern: str(schema.pattern) || undefined,
      };
    }
    if (hint === "keep") {
      // Variable names, never templates.
      return { ...base, widget: "keep", templated: false, maxItems: num(schema.maxItems) };
    }
    return {
      ...base,
      widget: "assign",
      templated: true,
      maxProperties: num(schema.maxProperties),
      minProperties: num(schema.minProperties),
    };
  }
  if (type === "array") {
    const items = resolveRef(schema.items, root);
    const sized = { minItems: num(schema.minItems), maxItems: num(schema.maxItems) };
    if (itemRefName(schema) === "Rule" || looksLikeRule(items)) {
      return { ...base, ...sized, widget: "rules" };
    }
    if (itemRefName(schema) === "RouterCase" || looksLikeCase(items, root)) {
      return { ...base, ...sized, widget: "cases" };
    }
    return { ...base, ...sized, widget: "json", jsonType: "array" };
  }
  if (Array.isArray(schema.enum) && schema.enum.every((option) => typeof option === "string")) {
    return { ...base, widget: "enum", options: schema.enum as string[] };
  }
  if (type === "string") {
    const maxLength = num(schema.maxLength);
    const long = (maxLength !== undefined && maxLength > 512 && !/url/i.test(key)) || key === "message";
    return {
      ...base,
      widget: long ? "textarea" : "text",
      minLength: num(schema.minLength),
      maxLength,
      pattern: str(schema.pattern) || undefined,
    };
  }
  if (type === "number" || type === "integer") {
    return {
      ...base,
      widget: "number",
      integer: type === "integer",
      minimum: num(schema.minimum),
      maximum: num(schema.maximum),
      exclusiveMinimum: num(schema.exclusiveMinimum),
      exclusiveMaximum: num(schema.exclusiveMaximum),
    };
  }
  if (type === "boolean") return { ...base, widget: "boolean" };
  if (type === "object") {
    if (isRecord(schema.properties) && Object.keys(schema.properties).length) {
      return { ...base, widget: "object", fields: fieldsFromSchema(schema, root) };
    }
    return {
      ...base,
      widget: "map",
      valueKind: mapValueKind(schema.additionalProperties),
      maxProperties: num(schema.maxProperties),
      // A map of strings, or "templates allowed": its values may be placeholders.
      templated: base.templated || schema.additionalProperties === true,
    };
  }
  if (type) return { ...base, jsonType: type };
  return base;
}

/** A config schema's fields, in the schema's own order. */
export function fieldsFromSchema(schema: Schema, root: Schema = schema): WorkflowFormField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([key, raw]) => fieldFor(key, raw, root, required.has(key)));
}

export const MATCH_MODES: ReadonlyArray<{ value: WorkflowMatchMode; label: string }> = [
  { value: "all", label: "All rules hold" },
  { value: "any", label: "Any rule holds" },
];

/** Rules as stored (anything malformed read as an empty rule, so it can be fixed). */
export const asRules = (value: unknown): WorkflowRule[] =>
  (Array.isArray(value) ? value : []).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      path: str(record.path),
      op: (RULE_OPS.some((entry) => entry.op === record.op) ? record.op : "eq") as WorkflowRuleOp,
      value: "value" in record ? record.value : null,
    };
  });

/** Router cases as stored. */
export const asCases = (value: unknown): WorkflowRouterCase[] =>
  (Array.isArray(value) ? value : []).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      name: str(record.name),
      mode: record.mode === "any" ? "any" : "all",
      rules: asRules(record.rules),
    };
  });

/** An empty rule, ready to fill in. */
export const emptyRule = (): WorkflowRule => ({ path: "", op: "eq", value: null });

/** A router case with one empty rule. */
export const emptyCase = (name: string): WorkflowRouterCase => ({ name, mode: "all", rules: [emptyRule()] });

/** The value a required field starts with on a new node (none for an optional one: the engine's default applies). */
function initialValue(field: WorkflowFormField): unknown {
  // A copy: the schema's default object must never be shared by two nodes.
  if (field.widget === "context") return asContext(field.default);
  if (field.widget === "keep") return [];
  if (field.hasDefault && field.default !== null) return field.default;
  switch (field.widget) {
    case "thread":
      return "";
    case "rules":
      return Array.from({ length: Math.max(1, field.minItems ?? 1) }, emptyRule);
    case "cases":
      return [emptyCase("case_1")];
    case "object": {
      const value: Record<string, unknown> = {};
      for (const sub of field.fields ?? []) {
        const initial = initialValue(sub);
        if (initial !== undefined) value[sub.key] = initial;
      }
      return value;
    }
    case "enum":
      return field.options?.[0] ?? "";
    case "map":
    case "assign":
      return {};
    case "boolean":
      return false;
    case "text":
    case "textarea":
    case "code":
      return "";
    default:
      return undefined;
  }
}

/**
 * Optional fields a new node still starts with, so the inspector shows the
 * choice made for it: what earlier steps it is sent, and (llm) its
 * conversation — `thread` and the `memory` shown beside it.
 */
const seeded = (field: WorkflowFormField, fields: readonly WorkflowFormField[]): boolean =>
  field.widget === "context" ||
  field.widget === "thread" ||
  (field.key === "memory" && field.widget === "enum" && fields.some((other) => other.widget === "thread"));

/** A new node's config: its required fields started (and a `$ref` object's required parts). */
export function defaultConfig(schema: Schema): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const fields = fieldsFromSchema(schema);
  for (const field of fields) {
    if (!field.required && !seeded(field, fields)) continue;
    const value = initialValue(field);
    if (value !== undefined) config[field.key] = value;
  }
  return config;
}

// ---------- Checking a config against its fields ----------

export type ConfigProblem = { field: string; message: string };

const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

function ruleProblems(rules: unknown, where: string): ConfigProblem[] {
  if (!Array.isArray(rules)) return [];
  const problems: ConfigProblem[] = [];
  rules.forEach((rule, index) => {
    const at = `${where}[${index}]`;
    const record = isRecord(rule) ? rule : {};
    const path = str(record.path);
    if (!path) problems.push({ field: `${at}.path`, message: "A rule needs a path to test." });
    else if (path.includes("{")) {
      problems.push({ field: `${at}.path`, message: "Write the path without braces, e.g. nodes.fetch.output.status." });
    } else if (!RULE_PATH_PATTERN.test(path)) {
      problems.push({ field: `${at}.path`, message: "A path is dotted names: letters, digits, _ . -" });
    }
    if (!RULE_OPS.some((entry) => entry.op === record.op)) {
      problems.push({ field: `${at}.op`, message: "Pick an operator." });
    }
  });
  return problems;
}

function fieldProblems(field: WorkflowFormField, value: unknown, where: string): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const label = field.label;
  if (isEmptyValue(value)) {
    if (field.required && !(field.widget === "rules" && (field.minItems ?? 0) === 0)) {
      problems.push({ field: where, message: `${label} is required.` });
    }
    return problems;
  }
  switch (field.widget) {
    case "text":
    case "textarea":
    case "code":
    case "thread": {
      if (typeof value !== "string") {
        problems.push({ field: where, message: `${label} must be text.` });
        break;
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        problems.push({ field: where, message: `${label} is required.` });
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        problems.push({ field: where, message: `${label} is at most ${field.maxLength} characters.` });
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) {
        problems.push({ field: where, message: `${label} has characters it can't contain.` });
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push({ field: where, message: `${label} must be a number.` });
        break;
      }
      if (field.integer && !Number.isInteger(value)) {
        problems.push({ field: where, message: `${label} must be a whole number.` });
      }
      if (field.minimum !== undefined && value < field.minimum) {
        problems.push({ field: where, message: `${label} is at least ${field.minimum}.` });
      }
      if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
        problems.push({ field: where, message: `${label} must be more than ${field.exclusiveMinimum}.` });
      }
      if (field.maximum !== undefined && value > field.maximum) {
        problems.push({ field: where, message: `${label} is at most ${field.maximum}.` });
      }
      if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
        problems.push({ field: where, message: `${label} must be less than ${field.exclusiveMaximum}.` });
      }
      break;
    }
    case "enum":
      if (!field.options?.includes(String(value))) {
        problems.push({ field: where, message: `Pick one of: ${field.options?.join(", ")}.` });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") problems.push({ field: where, message: `${label} must be on or off.` });
      break;
    case "rules": {
      const list = Array.isArray(value) ? value : [];
      if (field.minItems !== undefined && list.length < field.minItems) {
        problems.push({ field: where, message: `Add at least ${field.minItems} rule${field.minItems === 1 ? "" : "s"}.` });
      }
      if (field.maxItems !== undefined && list.length > field.maxItems) {
        problems.push({ field: where, message: `At most ${field.maxItems} rules.` });
      }
      problems.push(...ruleProblems(list, where));
      break;
    }
    case "cases": {
      const list = Array.isArray(value) ? value : [];
      if (field.maxItems !== undefined && list.length > field.maxItems) {
        problems.push({ field: where, message: `At most ${field.maxItems} cases.` });
      }
      const seen = new Set<string>();
      list.forEach((item, index) => {
        const record = isRecord(item) ? item : {};
        const name = str(record.name);
        const at = `${where}[${index}]`;
        if (!name) problems.push({ field: `${at}.name`, message: "A case needs a name." });
        else if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
          problems.push({ field: `${at}.name`, message: "Lower-case letters, digits and _ ; a letter first." });
        } else if (name === "default") {
          problems.push({ field: `${at}.name`, message: "'default' is the fallback branch's name." });
        } else if (seen.has(name)) {
          problems.push({ field: `${at}.name`, message: `Case name '${name}' is used twice.` });
        }
        seen.add(name);
        const rules = Array.isArray(record.rules) ? record.rules : [];
        if (!rules.length) problems.push({ field: `${at}.rules`, message: "A case needs at least one rule." });
        problems.push(...ruleProblems(rules, `${at}.rules`));
      });
      break;
    }
    case "map":
    case "assign": {
      if (!isRecord(value)) {
        problems.push({ field: where, message: `${label} must be a set of name → value pairs.` });
        break;
      }
      const count = Object.keys(value).length;
      if (field.minProperties !== undefined && count < field.minProperties) {
        problems.push({
          field: where,
          message: `Add at least ${field.minProperties} ${field.minProperties === 1 ? "entry" : "entries"}.`,
        });
      }
      if (field.maxProperties !== undefined && count > field.maxProperties) {
        problems.push({ field: where, message: `At most ${field.maxProperties} entries.` });
      }
      if (field.valueKind === "string" && Object.values(value).some((entry) => typeof entry !== "string")) {
        problems.push({ field: where, message: `Every ${label.toLowerCase()} value is text.` });
      }
      break;
    }
    case "keep": {
      // Which names may be kept (and twice) is the spec's check (`checkSpec`); here, the shape.
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
        problems.push({ field: where, message: `${label} must be a list of variable names.` });
      } else if (field.maxItems !== undefined && value.length > field.maxItems) {
        problems.push({ field: where, message: `Keep at most ${field.maxItems} variables.` });
      }
      break;
    }
    case "context": {
      if (!isRecord(value)) {
        problems.push({ field: where, message: `${label} must be a choice of steps.` });
        break;
      }
      if (value.mode !== undefined && !CONTEXT_MODES.some((mode) => mode.value === value.mode)) {
        problems.push({ field: where, message: "Pick what to send from earlier steps." });
      }
      const count = value.count;
      if (
        count !== undefined &&
        (typeof count !== "number" || !Number.isInteger(count) || count < CONTEXT_COUNT_MIN || count > CONTEXT_COUNT_MAX)
      ) {
        problems.push({ field: where, message: `Send between ${CONTEXT_COUNT_MIN} and ${CONTEXT_COUNT_MAX} steps.` });
      }
      const steps = value.steps;
      if (steps !== undefined && (!Array.isArray(steps) || steps.some((step) => typeof step !== "string"))) {
        problems.push({ field: where, message: "The picked steps must be step ids." });
      } else if (Array.isArray(steps) && steps.length > CONTEXT_STEPS_MAX) {
        problems.push({ field: where, message: `Pick at most ${CONTEXT_STEPS_MAX} steps.` });
      }
      break;
    }
    case "object": {
      const record = isRecord(value) ? value : {};
      for (const sub of field.fields ?? []) {
        problems.push(...fieldProblems(sub, record[sub.key], `${where}.${sub.key}`));
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/** Every problem with a node's config, each addressed as `config.<key>[…]`. */
export function configProblems(
  fields: WorkflowFormField[],
  config: Record<string, unknown>,
): ConfigProblem[] {
  return fields.flatMap((field) => fieldProblems(field, config[field.key], `config.${field.key}`));
}
