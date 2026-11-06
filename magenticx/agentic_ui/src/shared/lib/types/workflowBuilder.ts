// ------------------------------------------------------
// Workflow builder (plan 38, step 3) — the validate route's wire shape and
// the visual builder's view model: its issues, the form a node kind's config
// JSON Schema becomes, the structured rules / router cases, the template
// paths the helper offers, and the draft's actions.
// ------------------------------------------------------

import type { ScheduleKind } from "./tasks";
import type {
  WorkflowEdgeDef,
  WorkflowInputDef,
  WorkflowNodeDef,
  WorkflowSpec,
} from "./workflows";

// ---------- Validate (wire) ----------

/** One problem with a spec; `nodeId` is null for a workflow-level issue. `path` is index-based (`nodes[2].config.url`). */
export type WorkflowValidationIssue = { nodeId: string | null; path: string; message: string };

/** `POST /v1/workflows/validate` (and the `errors` of a 422 on create/update). */
export type WorkflowValidation = { ok: boolean; errors: WorkflowValidationIssue[] };

// ---------- Issues (view model) ----------

/**
 * One issue as the builder shows it: on a node (the card's count, the
 * inspector's field) or on the workflow itself (`nodeId` null: the settings).
 * `field` is relative to its owner: `config.url`, `config.cases[0].name`,
 * `id`, `edges` on a node; `name`, `inputs[1].name` on the workflow.
 */
export type WorkflowBuilderIssue = {
  id: string;
  nodeId: string | null;
  field: string;
  message: string;
  severity: "error" | "warning";
  source: "client" | "server";
};

/** Whether a new edge may be drawn; `reason` says why not. */
export type WorkflowConnectCheck = { ok: true } | { ok: false; reason: string };

// ---------- Schema-generated forms ----------

export type WorkflowFormWidget =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "rules"
  | "cases"
  /** A `set` step's `values`: variable name → template (`"x-widget": "assign"`). */
  | "assign"
  /** An end step's `keep`: the variables carried to the next run (`"x-widget": "keep"`). */
  | "keep"
  | "map"
  | "object"
  | "json"
  /** Source code (`"x-widget": "code"`): a monospace editor, never templated. */
  | "code"
  /** Which earlier steps' outputs the step receives (`"x-widget": "context"`). */
  | "context"
  /** The llm conversation this step talks in (`"x-widget": "thread"`), shown with `memory`. */
  | "thread"
  /** A tool step's tool (`"x-widget": "tool"`): picked from `GET /v1/workflows/tools`. */
  | "tool"
  /** A tool step's arguments (`"x-widget": "tool_args"`): fields from the picked tool's input schema. */
  | "tool_args";

/** What a map's values may be: templated text, a scalar (string/number/bool), or any JSON. */
export type WorkflowMapValueKind = "string" | "scalar" | "any";

/** One control of a node's inspector form, read from its kind's config JSON Schema. */
export type WorkflowFormField = {
  key: string;
  label: string;
  description: string;
  required: boolean;
  widget: WorkflowFormWidget;
  /** The schema's default, when it has one (`hasDefault`). */
  default?: unknown;
  hasDefault: boolean;
  /** The field accepts `{{…}}` placeholders (the helper is offered). */
  templated: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  /** `enum` choices. */
  options?: string[];
  minItems?: number;
  maxItems?: number;
  maxProperties?: number;
  minProperties?: number;
  valueKind?: WorkflowMapValueKind;
  /** `json`: the JSON type the value must have (`array`, `object`); absent = any value, text included. */
  jsonType?: string;
  /**
   * `json`: the schema asked for a JSON editor (`"x-widget": "json"`), so the
   * value is JSON even with no `jsonType` — never the loose text/JSON field.
   */
  strictJson?: boolean;
  /** `object`: its own fields. */
  fields?: WorkflowFormField[];
  /**
   * `json`: the value is itself a JSON Schema (the llm step's `json_schema`),
   * so the form offers the structured-output builder on top of the JSON editor.
   */
  jsonSchema?: boolean;
};

// ---------- Data from earlier steps, conversations, structured output ----------

/**
 * Which earlier steps' outputs a step is sent (`config.context.mode`):
 * the one that ran just before, the last N that ran, picked steps, or none.
 */
export type WorkflowContextMode = "previous" | "last" | "steps" | "none";

/** An llm / code step's `config.context`, read leniently (the engine's field names). */
export type WorkflowContextConfig = { mode: WorkflowContextMode; count: number; steps: string[] };

/** An llm step's `config.memory`: keep its earlier turns, or start each run fresh. */
export type WorkflowMemoryMode = "continue" | "fresh";

/** A step the context widget or the conversation's "Share with" may name. */
export type WorkflowStepOption = { id: string; label: string; kind: string };

/** A property type the structured-output builder offers. */
export type WorkflowSchemaFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

/** One row of the structured-output builder: a top-level property of the reply. */
export type WorkflowSchemaField = {
  name: string;
  type: WorkflowSchemaFieldType;
  description: string;
  required: boolean;
};

export type WorkflowRuleOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "exists"
  | "empty";

/** A structured rule `(path, op, value)` of `condition`, `router` cases and `loop.while`. */
export type WorkflowRule = { path: string; op: WorkflowRuleOp; value: unknown };

export type WorkflowMatchMode = "all" | "any";

/** One named case of a `router`: its name is a branch (and a handle on the canvas). */
export type WorkflowRouterCase = { name: string; mode: WorkflowMatchMode; rules: WorkflowRule[] };

/** What an edit to a router's cases did to its branches: a case renamed, or removed. */
export type WorkflowCasesChange = { rename?: [string, string]; drop?: string };

/** A path the template helper offers, e.g. `nodes.poll.output.status`. */
export type WorkflowTemplatePath = {
  path: string;
  group: "input" | "state" | "node";
  /** Short note: the value's type (`text`, `number`, `list`…). */
  hint: string;
  /** Where the value comes from, as people read it: the step's label (or id), `Run input`, `Variable`. */
  source: string;
  /** The value's friendly name within its source: `Answer`, `Body`, `Every run`, `Run 2`, `topic`. */
  label: string;
  /**
   * A step that runs in a loop: which of its runs the entry reads — `Last run`
   * (`nodes.<id>.output…`) or `Runs` (`nodes.<id>.outputs[.<n>]`); the
   * picker shows it as a sub-heading under the step.
   */
  section?: string;
  /** `node` entries: the step's id and kind (its icon). */
  nodeId?: string;
  kind?: string;
  /** Reachable but not offered by default (an llm step's conversation, a whole result): listed under "More". */
  more?: boolean;
};

/** The template paths of one source (a step, the run's inputs, the variables), in the order they are offered. */
export type WorkflowTemplateSource = {
  key: string;
  group: WorkflowTemplatePath["group"];
  title: string;
  nodeId?: string;
  kind?: string;
  entries: WorkflowTemplatePath[];
};

/** A run of a template string: plain text, or one `{{path}}` placeholder (`raw` is its exact text). */
export type WorkflowTemplateSegment =
  | { type: "text"; text: string }
  | { type: "ref"; path: string; raw: string };

/** How a placeholder reads in a field: `Fetch page › Body`, or invalid (shown as its raw path). */
export type WorkflowTemplateRefLabel = { source: string; label: string; valid: boolean };

// ---------- Draft ----------

export type WorkflowNodePatch = {
  label?: string | null;
  config?: Record<string, unknown>;
};

export type WorkflowDraftAction =
  | { type: "set-name"; value: string }
  | { type: "set-description"; value: string }
  | { type: "set-inputs"; inputs: WorkflowInputDef[] }
  | { type: "add-node"; node: WorkflowNodeDef }
  | {
      type: "update-node";
      id: string;
      patch: WorkflowNodePatch;
      /** A router case renamed: its edge keeps following it. */
      renameBranches?: Array<[string, string]>;
      /** Branches that no longer exist: their edges go. */
      dropBranches?: string[];
    }
  | { type: "rename-node"; from: string; to: string }
  | { type: "move-nodes"; positions: Record<string, { x: number; y: number }> }
  | { type: "remove"; nodeIds: string[]; edgeIds: string[] }
  | { type: "add-edge"; edge: WorkflowEdgeDef }
  | { type: "replace"; spec: WorkflowSpec };

// ---------- The schedule trigger (`trigger.schedule`) ----------

/** `schedule_spec`: exactly the kind's one field (`run_at` ISO, `interval_seconds`, `cron_expr`). */
export type WorkflowScheduleSpec = { run_at?: string; interval_seconds?: number; cron_expr?: string };

/**
 * A `trigger.schedule` node's config, read leniently from the spec (the
 * engine's field names). `timezone` is a cron expression's IANA zone (null:
 * UTC). A scheduled run has no inputs of its own: it uses each declared
 * input's default.
 */
export type WorkflowScheduleConfig = {
  schedule_kind: ScheduleKind;
  schedule_spec: WorkflowScheduleSpec;
  timezone: string | null;
  enabled: boolean;
};

/** What is picked on the canvas: nodes and edges (multi-select), or nothing (the workflow's settings). */
export type WorkflowBuilderSelection = { nodes: string[]; edges: string[] };

/** The builder page's props (`features/workflows`), from its route view. */
export type WorkflowBuilderPageProps = {
  /** The workflow being edited; null on `/workflows/new`. */
  workflowId: string | null;
  /** After a save: the sidebar's list is reloaded. */
  onSaved: () => void;
  /** After a create: open the new workflow's edit route. */
  onCreated: (workflowId: string) => void;
  /** Open the workflow's view (Run). */
  onOpenView: (workflowId: string) => void;
  /** The workflow was deleted. */
  onDeleted: () => void;
  /** Back / close the builder: to the workflow's view when there is one saved. */
  onExit: (workflowId: string | null) => void;
  /** Open with this panel showing (`?panel=history`: the view's History link). */
  initialPanel?: "history" | null;
};

// ---------- The canvas's right-click menu ----------

/** What a right-click on the builder's canvas landed on. */
export type WorkflowCanvasMenuTarget =
  | { type: "pane" }
  | { type: "node"; id: string; label: string }
  | { type: "edge"; id: string }
  | { type: "selection"; nodeIds: string[]; edgeIds: string[] };

/** The open right-click menu: where (px, in the canvas) and on what. */
export type WorkflowCanvasMenu = { x: number; y: number; target: WorkflowCanvasMenuTarget };

// ---------- Tool step: the tools a workflow may call ----------

/** Where a tool comes from: the agents' own (`native`) or the MCP gateway. */
export type WorkflowToolSource = "native" | "mcp";

/** A tool step's `config.tool`. */
export type WorkflowToolRef = { source: WorkflowToolSource; name: string };

/** One tool a tool step may call (`GET /v1/workflows/tools`). `inputSchema` is the tool's own JSON Schema, read defensively. */
export type WorkflowToolInfo = {
  source: WorkflowToolSource;
  name: string;
  /** The MCP server it comes from; null for a native tool. */
  server: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** `GET /v1/workflows/tools`: `mcpAvailable` false = the gateway could not be read (native tools are still listed). */
export type WorkflowToolCatalog = { mcpAvailable: boolean; tools: WorkflowToolInfo[] };

/** What an argument's control edits. */
export type WorkflowToolArgType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "unknown";

/** One argument of a tool, read from its input schema. */
export type WorkflowToolArg = {
  name: string;
  label: string;
  description: string;
  type: WorkflowToolArgType;
  required: boolean;
  /** Fixed choices (`enum`), when the schema lists them. */
  options: Array<string | number | boolean> | null;
  hasDefault: boolean;
  default?: unknown;
};

/** The tool picker's groups: "Built-in" first, then one per server. */
export type WorkflowToolGroup = { key: string; label: string; tools: WorkflowToolInfo[] };

/** The tool list as the builder holds it (`useWorkflowTools`): shared by the picker, the arguments and the checks. */
export type WorkflowToolsState = {
  data: WorkflowToolCatalog | null;
  isLoading: boolean;
  error: string | null;
  retry: () => void;
};
