import type {
  WorkflowBuilderIssue,
  WorkflowFormField,
  WorkflowNodeKindInfo,
  WorkflowSpec,
  WorkflowValidationIssue,
} from "@/shared/lib/types";
import {
  END_KIND,
  LLM_KIND,
  LOOP_CONTINUE,
  LOOP_KIND,
  findCycle,
  isTriggerKind,
  kindInfoOf,
  reachableFrom,
} from "./graph";
import { nodeBranches } from "@/features/workflows/lib/nodeCard";
import { FIELD_NAME_PATTERN, NODE_ID_PATTERN, RESERVED_NAMES } from "./ids";
import { SCHEDULE_TRIGGER_KIND, scheduleConfigProblems } from "./schedule";
import { configProblems, fieldsFromSchema } from "./schemaForm";
import { matchesType } from "./values";

/**
 * The builder's own checks, run on every change: a mirror of the engine's
 * validator (`docs/flows/workflows.md` § Phase 4) for everything it can see
 * without the server — the name, one trigger, ids, each node's config against
 * its kind's schema (the schedule trigger's against the engine's own rules),
 * the edges and branches, loops, reachability, cycles, inputs and state, and
 * template paths that name nothing. The server's validate (debounced, and on
 * save) has the last word; its issues are mapped onto the same nodes and
 * fields by `placeServerIssues`.
 */

export const MAX_NODES = 50;
export const MAX_EDGES = 200;
export const MAX_FIELDS = 32;

const VALUE_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

/** Form fields per kind, read once per catalogue entry. */
const fieldCache = new WeakMap<WorkflowNodeKindInfo, WorkflowFormField[]>();
export function kindFields(info: WorkflowNodeKindInfo): WorkflowFormField[] {
  let fields = fieldCache.get(info);
  if (!fields) {
    fields = fieldsFromSchema(info.configSchema);
    fieldCache.set(info, fields);
  }
  return fields;
}

const TEMPLATE_REF = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Every `{{…}}` path in a config's string values, and every rule `path`, each
 * with the top-level config field that holds it (`config.url`): an issue about
 * a reference sits under the field being typed in, never in a box above the
 * form (which pushed the field down and back on every keystroke that made or
 * mended a bad reference).
 */
function referencedPaths(config: Record<string, unknown>): Array<{ path: string; field: string }> {
  const found: Array<{ path: string; field: string }> = [];
  const walk = (value: unknown, key: string | null, field: string) => {
    if (typeof value === "string") {
      if (key === "path") found.push({ path: value.trim(), field });
      for (const match of value.matchAll(TEMPLATE_REF)) found.push({ path: match[1], field });
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => walk(item, null, field));
    else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, field);
    }
  };
  // `assign` values may read the node's own `output`; everything else may not.
  for (const [key, value] of Object.entries(config)) walk(value, key, `config.${key}`);
  return found.filter((entry) => Boolean(entry.path));
}

export function checkSpec(
  spec: WorkflowSpec,
  catalog: readonly WorkflowNodeKindInfo[],
): WorkflowBuilderIssue[] {
  const issues: WorkflowBuilderIssue[] = [];
  const add = (nodeId: string | null, field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({
      id: `client:${nodeId ?? "$"}:${field}:${message}`,
      nodeId,
      field,
      message,
      severity,
      source: "client",
    });
  const catalogKnown = catalog.length > 0;

  // ---- the workflow ----
  if (!spec.name.trim()) add(null, "name", "Give the workflow a name.");
  else if (spec.name.trim().length > 120) add(null, "name", "The name is at most 120 characters.");
  if ((spec.description ?? "").length > 2000) add(null, "description", "The description is at most 2000 characters.");
  if (spec.nodes.length > MAX_NODES) add(null, "nodes", `A workflow has at most ${MAX_NODES} steps.`);
  if (spec.edges.length > MAX_EDGES) add(null, "edges", `A workflow has at most ${MAX_EDGES} connections.`);
  if (spec.inputs.length > MAX_FIELDS) add(null, "inputs", `At most ${MAX_FIELDS} inputs.`);
  if (spec.state.length > MAX_FIELDS) add(null, "state", `At most ${MAX_FIELDS} state fields.`);

  const inputNames = new Set<string>();
  spec.inputs.forEach((input, index) => {
    const name = input.name.trim();
    const at = `inputs[${index}]`;
    if (!name) add(null, `${at}.name`, "An input needs a name.");
    else if (!FIELD_NAME_PATTERN.test(name)) add(null, `${at}.name`, `'${name}': letters, digits and _ only, not starting with a digit.`);
    else if (RESERVED_NAMES.has(name)) add(null, `${at}.name`, `'${name}' is reserved.`);
    else if (inputNames.has(name)) add(null, `${at}.name`, `Input '${name}' is declared twice.`);
    inputNames.add(name);
    if (!VALUE_TYPES.has(input.type)) add(null, `${at}.type`, "Pick a type.");
    if (input.default !== undefined && input.default !== null && !matchesType(input.type, input.default)) {
      add(null, `${at}.default`, `The default must be of type ${input.type}.`);
    }
  });

  const stateNames = new Set<string>();
  spec.state.forEach((field, index) => {
    const name = field.name.trim();
    const at = `state[${index}]`;
    if (!name) add(null, `${at}.name`, "A state field needs a name.");
    else if (!FIELD_NAME_PATTERN.test(name)) add(null, `${at}.name`, `'${name}': letters, digits and _ only, not starting with a digit.`);
    else if (RESERVED_NAMES.has(name)) add(null, `${at}.name`, `'${name}' is reserved.`);
    else if (stateNames.has(name)) add(null, `${at}.name`, `State field '${name}' is declared twice.`);
    stateNames.add(name);
    if (field.reducer === "append" && field.type !== "array") add(null, `${at}.reducer`, "Append needs an array field.");
    if (field.reducer === "merge" && field.type !== "object") add(null, `${at}.reducer`, "Merge needs an object field.");
    if (field.default !== undefined && field.default !== null && !matchesType(field.type, field.default)) {
      add(null, `${at}.default`, `The default must be of type ${field.type}.`);
    }
  });

  // ---- nodes ----
  const ids = new Set<string>();
  const triggers: string[] = [];
  for (const node of spec.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) add(node.id, "id", "Start the id with a letter; then letters, digits, _ or -.");
    else if (ids.has(node.id)) add(node.id, "id", `Id '${node.id}' is used by another step.`);
    else if (RESERVED_NAMES.has(node.id) || stateNames.has(node.id)) {
      add(node.id, "id", `Id '${node.id}' clashes with a state name.`);
    }
    ids.add(node.id);
    if ((node.label ?? "").length > 120) add(node.id, "label", "The label is at most 120 characters.");
    const info = kindInfoOf(catalog, node.kind);
    if (!info) {
      if (catalogKnown) add(node.id, "kind", `Unknown step kind '${node.kind}'.`);
    } else {
      // A kind the server can't run now (e.g. `code` with no sandbox): the
      // run would fail at this step, so say so up front, with the reason.
      if (info.available === false) {
        add(node.id, "kind", info.unavailableReason ?? `${info.label} steps can't run on this server.`);
      }
      // The schedule trigger's config is checked as the engine checks it (its
      // schema alone can't say "exactly the kind's one spec field" or read
      // the static inputs against the declared ones); its `assign` as any.
      const problems =
        node.kind === SCHEDULE_TRIGGER_KIND
          ? [
              ...scheduleConfigProblems(node.config, spec.inputs),
              ...configProblems(kindFields(info).filter((field) => field.key === "assign"), node.config),
            ]
          : configProblems(kindFields(info), node.config);
      for (const problem of problems) add(node.id, problem.field, problem.message);
      // Every state-write map — `assign`, and a field the schema marks as one
      // (`"x-widget": "assign"`, the set step's `values`) — writes declared
      // state fields only.
      const writeKeys = new Set(["assign", ...kindFields(info).filter((f) => f.widget === "assign").map((f) => f.key)]);
      for (const key of writeKeys) {
        const writes = node.config[key];
        if (!writes || typeof writes !== "object" || Array.isArray(writes)) continue;
        for (const name of Object.keys(writes)) {
          if (!stateNames.has(name)) add(node.id, `config.${key}`, `'${name}' is not a declared state field.`);
        }
      }
      // The llm step's JSON mode needs the shape it asks the model for.
      if (node.kind === LLM_KIND && node.config.output === "json") {
        const schema = node.config.json_schema;
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
          add(node.id, "config.json_schema", "Give the JSON output a schema.");
        }
      }
    }
    if (isTriggerKind(catalog, node.kind)) triggers.push(node.id);

    // A schedule trigger is not templated: a `{{` in its inputs is plain text;
    // nor is a code field (`"x-widget": "code"`): its braces are the program's.
    const templated = node.kind !== SCHEDULE_TRIGGER_KIND;
    const untemplated = new Set(
      info ? kindFields(info).filter((f) => f.widget === "code").map((f) => `config.${f.key}`) : [],
    );
    const references = templated ? referencedPaths(node.config).filter((ref) => !untemplated.has(ref.field)) : [];
    for (const { path, field } of references) {
      const [root, name] = path.split(".");
      if (root === "input" && name && !inputNames.has(name)) {
        add(node.id, field, `'${path}' reads an undeclared input '${name}'.`);
      } else if (root === "state" && name && !stateNames.has(name)) {
        add(node.id, field, `'${path}' reads an undeclared state field '${name}'.`);
      } else if (root === "nodes" && name && !spec.nodes.some((other) => other.id === name)) {
        add(node.id, field, `'${path}' reads an unknown step '${name}'.`);
      }
    }
  }
  if (triggers.length !== 1) {
    add(
      null,
      "nodes",
      triggers.length ? "A workflow has exactly one trigger." : "Add a trigger: it is where a run starts.",
    );
  }

  // ---- edges ----
  const used = new Set<string>();
  spec.edges.forEach((edge, index) => {
    const from = spec.nodes.find((node) => node.id === edge.source);
    const to = spec.nodes.find((node) => node.id === edge.target);
    if (!from || !to) {
      add(from ? from.id : null, "edges", `Connection ${index + 1} joins a step that doesn't exist.`);
      return;
    }
    if (isTriggerKind(catalog, to.kind)) add(to.id, "edges", "Nothing may lead into the trigger.");
    if (from.kind === END_KIND) add(from.id, "edges", "An end step has no way out.");
    const info = kindInfoOf(catalog, from.kind);
    const branches = nodeBranches(from, info);
    const branch = edge.branch ?? null;
    if (info && branches.length && !branch) {
      add(from.id, "edges", `Its connections need a branch: ${branches.join(", ")}.`);
    } else if (info && !branches.length && branch) {
      add(from.id, "edges", `'${from.id}' does not branch.`);
    } else if (info && branch && !branches.includes(branch)) {
      add(from.id, "edges", `Branch '${branch}' no longer exists.`);
    }
    const key = `${edge.source}\u0000${branch ?? ""}`;
    if (used.has(key)) {
      add(from.id, "edges", branch ? `Branch '${branch}' leads to two steps.` : "It leads to two steps; a run follows one path.");
    }
    used.add(key);
  });

  for (const node of spec.nodes) {
    if (node.kind !== LOOP_KIND) continue;
    if (!spec.edges.some((edge) => edge.source === node.id && edge.branch === LOOP_CONTINUE)) {
      add(node.id, "edges", "A loop needs a 'continue' connection back into its body.");
    }
  }

  if (triggers.length === 1) {
    const reachable = reachableFrom(triggers[0], spec.edges);
    for (const node of spec.nodes) {
      if (!reachable.has(node.id)) add(node.id, "edges", "Not reachable from the trigger: connect something into it.");
    }
  }

  const cycle = findCycle(spec);
  if (cycle) {
    add(cycle[0], "edges", `Cycle ${cycle.join(" → ")} doesn't go through a loop's 'continue'.`);
  }

  if (spec.nodes.length > 1 && !spec.nodes.some((node) => node.kind === END_KIND)) {
    add(null, "nodes", "Add an End step: it says what the run returns.", "warning");
  }
  return issues;
}

/**
 * The server's issues (index-based paths, `nodes[2].config.url`) placed like
 * the builder's own: on the node they name, with the field relative to it.
 * Paths are resolved against the spec they were checked on.
 */
export function placeServerIssues(
  errors: readonly WorkflowValidationIssue[],
  checked: WorkflowSpec,
): WorkflowBuilderIssue[] {
  return errors.map((error, index) => {
    let nodeId = error.nodeId;
    let field = error.path || "$";
    const nodeMatch = /^nodes\[(\d+)\](?:\.(.*))?$/.exec(field);
    if (nodeMatch) {
      nodeId = nodeId ?? checked.nodes[Number(nodeMatch[1])]?.id ?? null;
      field = nodeMatch[2] ?? "id";
    } else if (/^edges\[\d+\]/.test(field)) {
      if (!nodeId) {
        const edge = checked.edges[Number(/^edges\[(\d+)\]/.exec(field)?.[1])];
        nodeId = edge?.source ?? null;
      }
      field = "edges";
    } else if (nodeId && field === "nodes") {
      field = "edges";
    }
    return {
      id: `server:${index}:${nodeId ?? "$"}:${field}:${error.message}`,
      nodeId,
      field,
      message: error.message,
      severity: "error" as const,
      source: "server" as const,
    };
  });
}

/** Client and server issues together, a server issue dropped when the client already says the same. */
export function mergeIssues(
  client: readonly WorkflowBuilderIssue[],
  server: readonly WorkflowBuilderIssue[],
): WorkflowBuilderIssue[] {
  const seen = new Set(client.map((issue) => `${issue.nodeId}:${issue.field}`));
  return [...client, ...server.filter((issue) => !seen.has(`${issue.nodeId}:${issue.field}`))];
}

/** Error count per node, for the cards' badges. */
export function issueCountByNode(issues: readonly WorkflowBuilderIssue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
  }
  return counts;
}

/** Whether an issue sits on `field` or inside it (`config.cases` holds `config.cases[0].name`). */
export const issueIsOn = (issue: WorkflowBuilderIssue, field: string): boolean =>
  issue.field === field || issue.field.startsWith(`${field}.`) || issue.field.startsWith(`${field}[`);
