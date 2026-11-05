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
  WorkflowStateFieldDef,
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
 * `id`, `edges` on a node; `name`, `inputs[1].name`, `state[0].reducer` on
 * the workflow.
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
  | "assign"
  | "map"
  | "object"
  | "json"
  /** Source code (`"x-widget": "code"`): a monospace editor, never templated. */
  | "code";

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
  group: "input" | "state" | "node" | "output";
  /** Short note: the field's type, or the node it comes from. */
  hint: string;
};

// ---------- Draft ----------

export type WorkflowNodePatch = {
  label?: string | null;
  config?: Record<string, unknown>;
};

export type WorkflowDraftAction =
  | { type: "set-name"; value: string }
  | { type: "set-description"; value: string }
  | { type: "set-inputs"; inputs: WorkflowInputDef[] }
  | { type: "set-state"; state: WorkflowStateFieldDef[] }
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
 * UTC); `inputs` are the literal run inputs of a scheduled fire.
 */
export type WorkflowScheduleConfig = {
  schedule_kind: ScheduleKind;
  schedule_spec: WorkflowScheduleSpec;
  timezone: string | null;
  inputs: Record<string, unknown>;
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
