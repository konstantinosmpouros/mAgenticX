// ------------------------------------------------------
// Workflows (plan 38, step 2) — the wire shapes of the bridge's
// `/v1/workflows…` and `/v1/workflow-runs…` routes, plus the view model the
// workflow view renders: a run's AG-UI events folded into node *executions*
// (one per time a node ran, so loops show as `poll#1`, `poll#2`, …).
// ------------------------------------------------------

// ---------- Spec (as stored; the builder edits it in step 3) ----------

/** The value types a run input may have. */
export type WorkflowValueType = "string" | "number" | "boolean" | "object" | "array";

export type WorkflowInputDef = {
  name: string;
  type: WorkflowValueType;
  required?: boolean;
  default?: unknown;
  description?: string;
};

export type WorkflowNodeDef = {
  id: string;
  /** Catalogue kind, e.g. `trigger.manual`, `fetch`, `condition`, `loop`, `approval`. */
  kind: string;
  label?: string | null;
  config: Record<string, unknown>;
  position: { x: number; y: number };
};

export type WorkflowEdgeDef = {
  id: string;
  source: string;
  target: string;
  /** Branch name on the source (`true`/`false`, `continue`/`done`, `approved`/`rejected`, router cases). */
  branch?: string | null;
};

export type WorkflowSpec = {
  version: 1;
  name: string;
  description?: string;
  inputs: WorkflowInputDef[];
  /**
   * No declared state: the variables are the names `set` steps write
   * (`config.values` keys), read as `{{state.<name>}}`.
   */
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
};

// ---------- Catalogue ----------

export type WorkflowNodeKindInfo = {
  kind: string;
  label: string;
  group: string;
  description: string;
  branches: string[];
  dynamicBranches: boolean;
  isTrigger: boolean;
  configSchema: Record<string, unknown>;
  /**
   * False when the server cannot run this kind right now (e.g. `code` without a
   * sandbox runner): the palette shows it disabled and the checks flag it.
   * Defaults to true when an older catalogue omits it.
   */
  available: boolean;
  /** Why the kind is unavailable, for the tooltip, toast and check; null when available. */
  unavailableReason: string | null;
};

// ---------- Definitions ----------

export type Workflow = {
  id: string;
  name: string;
  description: string | null;
  /** Present on the single-workflow GET, absent in the list. */
  spec: WorkflowSpec | null;
  latestVersionNo: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * The schedule set by the workflow's `trigger.schedule` start node; absent or
   * null when it only runs by hand (and from a bridge that does not send it yet).
   */
  schedule?: WorkflowSchedule | null;
};

export type WorkflowScheduleStatus = "active" | "paused" | "finished";

/** A scheduled workflow's timing, as the Automations page's workflow card reads it. */
export type WorkflowSchedule = {
  status: WorkflowScheduleStatus;
  /** The start node's schedule kind (`cron`, `interval`, `one_off`). */
  kind: string;
  spec: Record<string, unknown>;
  timezone: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
};

// ---------- History (kept versions) ----------

/**
 * One kept version, as the builder's History panel lists it: no spec, a
 * summary read off it. `restoredFrom` names the version a restore copied — a
 * restore appends a version, it never rewrites one.
 */
export type WorkflowVersionSummary = {
  versionNo: number;
  createdAt: string | null;
  createdBy: string;
  restoredFrom: number | null;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
};

/** A page of versions, newest first; `nextBefore` asks for the older ones. */
export type WorkflowVersionPage = {
  items: WorkflowVersionSummary[];
  nextBefore: number | null;
};

/** One kept version with its whole spec (the diff, the preview, the restore). */
export type WorkflowVersionDetail = {
  versionNo: number;
  createdAt: string | null;
  createdBy: string;
  restoredFrom: number | null;
  spec: WorkflowSpec;
};

// ---------- Runs ----------

export type WorkflowRunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  versionNo: number | null;
  triggerKind: string;
  status: WorkflowRunStatus;
  error: string | null;
  eventCount: number;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunPage = { items: WorkflowRun[]; nextCursor: string | null };

/** One persisted AG-UI event. `payload` is the raw AG-UI event (incl. its `workflow` envelope). */
export type WorkflowRunEvent = {
  seq: number;
  type: string;
  nodeId: string | null;
  executionId: string | null;
  parentExecutionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WorkflowRunDetail = {
  run: WorkflowRun;
  inputs: Record<string, unknown>;
  events: WorkflowRunEvent[];
  hasMoreEvents: boolean;
};

/** Frames of `GET /v1/workflow-runs/{user}/{run}/events/stream`. */
export type WorkflowRunStreamFrame =
  | { type: "status"; run: WorkflowRun }
  | { type: "event"; event: WorkflowRunEvent };

export type WorkflowApprovalDecision = "approve" | "reject";

// ---------- View model (derived from events by the run reducer) ----------

export type WorkflowExecutionStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

/** A tool call made inside one execution (from TOOL_CALL_* events). */
export type WorkflowToolCall = {
  toolCallId: string;
  name: string;
  args: unknown;
  result: unknown;
  error: boolean;
};

/** The approval an execution is paused on (from the HITL_INTERRUPT event). */
export type WorkflowPendingApproval = {
  message: string;
  payload: unknown;
  allowedDecisions: WorkflowApprovalDecision[];
};

/** One run of one node. Ordered by `startSeq` it is the timeline. */
export type WorkflowExecution = {
  /** `<nodeId>#<n>`. */
  executionId: string;
  nodeId: string;
  /** 1-based count of this node's executions in the run. */
  iteration: number;
  parentExecutionId: string | null;
  status: WorkflowExecutionStatus;
  startSeq: number;
  endSeq: number | null;
  startedAt: string;
  durationMs: number | null;
  /** Resolved config the node ran with (`workflow.node_input`). */
  input: unknown;
  /** `workflow.node_output.output`. */
  output: unknown;
  /** Branch it took, if the node branches. */
  branch: string | null;
  error: { code: string; message: string } | null;
  /** JSON Patch ops from STATE_DELTA. */
  stateDelta: unknown[];
  toolCalls: WorkflowToolCall[];
  /** Streamed text from the node (TEXT_MESSAGE_*), joined. */
  text: string;
  approval: WorkflowPendingApproval | null;
  /** Every raw event of this execution, for the "raw events" tab. */
  events: WorkflowRunEvent[];
};

/** A run's events folded for rendering. */
export type WorkflowRunView = {
  executions: WorkflowExecution[];
  /** nodeId → its executions, in order (graph overlay: counts + last status). */
  byNode: Record<string, WorkflowExecution[]>;
  /** Last applied seq (for resuming the live stream with `after_seq`). */
  lastSeq: number;
  /** Final output from RUN_FINISHED.result.output, if any. */
  output: unknown;
  runError: { message: string; code: string | null } | null;
};

// ---------- Workflow view (UI-only shapes) ----------

/** Props of the workflow view that fills the chat body (`features/workflows`). */
export type WorkflowViewPageProps = {
  workflowId: string;
  /** The run shown; `null` shows the latest run. */
  runId: string | null;
  /** Open another run (the route's `/runs/:runId`). */
  onSelectRun: (runId: string) => void;
  /** Open the builder on this workflow (`/workflows/:id/edit`); no Edit button without it. */
  onEdit?: () => void;
  /** Open the builder with its History panel showing; no History button without it. */
  onHistory?: () => void;
};

/** The details panel's tabs. */
export type WorkflowDetailTab = "input" | "output" | "state" | "tools";

/**
 * One row of the execution timeline: an execution plus where it sits in the
 * git-graph-like lanes. `depth` is how many `parentExecutionId` hops lie above
 * it (a loop's body is one deeper than the loop); `rails` are the lane levels
 * that carry a vertical line through this row.
 */
export type WorkflowTimelineRow = {
  execution: WorkflowExecution;
  depth: number;
  rails: number[];
  label: string;
  kindLabel: string;
  /** How many times this execution's node ran in the run; "pass N" shows only above 1. */
  passes: number;
};

/** The Run dialog's form values: text for every field but a boolean's switch. */
export type WorkflowInputDraft = Record<string, string | boolean>;

/** The Run dialog's field errors, by input name. */
export type WorkflowInputErrors = Record<string, string>;

/** One JSON Patch op of an execution's STATE_DELTA, as the State tab lists it. */
export type WorkflowStatePatchOp = { op: string; path: string; value: unknown; hasValue: boolean };

/** One thing an execution saved to the run's state, as the State tab lists it. */
export type WorkflowStateWrite = {
  /** Its result, an llm conversation turn, or a variable. */
  kind: "output" | "conversation" | "field";
  /** Short verb: Saved, Added, Set. */
  action: string;
  /** Where it landed, as a template path (`nodes.fetch.output`, `state.count`). */
  path: string;
  /** One line on what it means; may be empty. */
  note: string;
  value: unknown;
  hasValue: boolean;
};

/** The execution the user picked in the workflow view, tied to the run it belongs to. */
export type WorkflowExecutionPick = { runId: string; executionId: string };

// ---------- Shared canvas node (view graph + builder use the same card) ----------

/** `data` of a React Flow node rendered by `WorkflowNodeCard`, in both the run view and the builder. */
export type WorkflowNodeCardData = {
  nodeId: string;
  kind: string;
  label: string;
  /** Catalogue entry (label, group, branches); null while the catalogue loads. */
  kindInfo: WorkflowNodeKindInfo | null;
  mode: "view" | "edit";
  /** Branch names this node can take → one source handle each (empty = one plain source handle). */
  branches: string[];
  /** Triggers have no target handle. */
  isTrigger: boolean;
  /** View mode: overlay from the run. */
  status?: WorkflowExecutionStatus | null;
  executionCount?: number;
  /** Edit mode: validation problems on this node. */
  issueCount?: number;
  /** The picked node (details panel / inspector): outlined. */
  selected?: boolean;
  /** View mode: the run touched other nodes but not this one yet — drawn a little faded. */
  dimmed?: boolean;
  /** View mode: the branch its last finished execution took — lit on its source handle. */
  takenBranch?: string | null;
  /** Edit mode: at least one issue is an error (red badge), not only warnings. */
  hasErrors?: boolean;
  /**
   * A compact line under the label — the schedule trigger's cadence and next
   * run ("Every day · next 08:00") or "Paused"; from the node's config in
   * edit mode, from the workflow's live schedule in the run view.
   */
  subtitle?: string | null;
  /** The subtitle reads as paused (muted, with a pause glyph). */
  subtitlePaused?: boolean;
  /** Edit mode: when set, a delete action comes up on hover, focus or selection. */
  onDelete?: (nodeId: string) => void;
};

/**
 * How an edge reads on the canvas. `taken` — its source last went this way;
 * `running` — taken, into a node that is running now (a flowing dash);
 * `failed` — taken, into a node that failed; `untaken` — its source finished
 * and went another way (muted). None set: plain, not reached yet.
 */
export type WorkflowEdgeTone = "idle" | "taken" | "running" | "failed" | "untaken";

/** `data` of a React Flow edge rendered by `WorkflowEdge`, in both the run view and the builder. */
export type WorkflowEdgeData = {
  mode: "view" | "edit";
  /** Branch name on the source (its label pill); null for a plain edge. */
  branch: string | null;
  /** View mode: overlay from the run (see `WorkflowEdgeTone`). */
  taken?: boolean;
  running?: boolean;
  failed?: boolean;
  untaken?: boolean;
  /**
   * The edge closes a loop (its target sits left of its source): drawn as an
   * arc under the cards instead of a curve through them. `floorY` is the
   * arc's lowest y in flow coordinates (`backEdgeFloor` in features/workflows/lib/layout).
   */
  back?: boolean;
  floorY?: number;
  /** Edit mode: delete this edge (else the edge is removed through React Flow's `deleteElements`). */
  onDelete?: (edgeId: string) => void;
};
