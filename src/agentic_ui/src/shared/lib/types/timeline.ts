// ------------------------------------------------------
// Run timeline — derived client-side from the raw AG-UI event log.
// The same reducer (lib/timeline.ts) folds live WS frames incrementally and
// replays persisted message.rawEvents on hydration, so live and hydrated
// views cannot drift. Never persisted anywhere.
// ------------------------------------------------------
// `PlanSnapshot` comes from shared/lib/schemas (the zod-only leaf), NOT from
// features/inference/agui — shared/ must not import from features/. The schema
// lives there so this type stays derived from the wire contract; agui re-exports
// it so the AG-UI consumers still have one import site.
import type { PlanSnapshot } from "../schemas";

export type ToolExecutionState =
  "input-streaming" | "input-available" | "output-available" | "output-error";

export type TimelineThought = {
  kind: "thought";
  id: string;
  text: string;
};

// One action's resolved outcome inside a batched HITL interrupt. Index-aligned
// to the interrupt's action_requests order.
export type TimelineHitlActionOutcome = {
  status: "approved" | "rejected";
  reason?: string | null;
};

// Parsed, human-readable view of a LangChain HITL interrupt payload, produced
// by parseHitlInterrupt in runtime/hitl.ts. `raw` always carries the full
// payload; the other fields are best-effort because interrupt shapes vary.
export type ParsedHitlAction = {
  toolName?: string;
  description?: string;
  argsText?: string;
};

export type ParsedHitlRequest = ParsedHitlAction & {
  // Every action_request in the (possibly batched) interrupt, in order. The
  // top-level toolName/description/argsText mirror actions[0] for callers that
  // only need the first (back-compat). requestCount === actions.length.
  actions: ParsedHitlAction[];
  requestCount: number;
  raw: string;
};

export type TimelineHitlApproval = {
  kind: "hitl";
  id: string;
  threadId: string;
  content: unknown;
  status: "pending" | "approved" | "rejected";
  reason?: string | null;
  subagentId?: string;
  // Which action_request this binding represents, when the interrupt gated
  // multiple tool calls in one turn (per-tool approval chips). Undefined for
  // a single-action interrupt.
  actionIndex?: number;
  // Per-action resolved outcomes (set on BRIDGE_HITL_RESOLVED for a batch);
  // index-aligned to action_requests. Drives per-tool chip status.
  decisions?: TimelineHitlActionOutcome[];
};

export type TimelineToolExecution = {
  kind: "tool";
  id: string;
  name: string;
  argsText: string;
  result?: string;
  resultTruncated?: boolean;
  state: ToolExecutionState;
  approval?: TimelineHitlApproval;
  startedAt?: number;
  endedAt?: number;
};

export type ThinkingBlockItem = TimelineThought | TimelineToolExecution | TimelineHitlApproval;

export type ThinkingBlock = {
  kind: "thinking";
  id: string;
  items: ThinkingBlockItem[];
  startedAt?: number;
  endedAt?: number;
};

export type ContentBlock = {
  kind: "content";
  id: string;
  text: string;
};

export type SubagentBlock = {
  kind: "subagent";
  id: string;
  taskId: string;
  type?: string;
  label?: string;
  description?: string;
  prompt?: string;
  namespace?: string;
  /**
   * True once the sub-agent has actually been spawned — i.e. we have received at
   * least one SUBAGENT_EVENT for it.
   *
   * A block is created by TASK_SUBAGENT, which the agents service emits when the
   * orchestrator *calls* the `task` tool — before the HITL gate. If that call is
   * rejected the sub-agent never runs and no SUBAGENT_EVENT ever arrives, so the
   * block stays unspawned. The panel lists spawned blocks only: an unspawned one
   * is a refused tool call, not a sub-agent.
   */
  spawned?: boolean;
  blocks: (ThinkingBlock | ContentBlock)[];
};

// A deliverable the agent designated via present_artifact, folded into the
// timeline at the log position the PRESENT_ARTIFACT event fired — so it renders
// inline between the thinking/content blocks around it. Carries display
// metadata only; the downloadable bytes live on the message's matching
// generated attachment (reconciled by filename), persisted at run finalize.
export type ArtifactBlock = {
  kind: "artifact";
  id: string;
  artifactId: string;
  path: string;
  filename: string;
  title?: string;
  summary?: string;
  mime?: string;
};

// A chart the agent drew via render_chart, folded into the timeline at the log
// position the RENDER_CHART event fired — same interleaving discipline as an
// artifact card, so "text -> chart -> text" renders in the order the agent
// produced it. Unlike an artifact this block IS the chart: there are no bytes
// behind it, so it needs no attachment and survives reload purely by being
// replayed from the run's raw_events.
//
// Colors are deliberately absent. ChartCard assigns them from the theme
// palette (--chart-1..5) by series index, so the same chart is readable in
// light and dark mode and no agent can pin a failing contrast.
export type ChartType =
  "bar" | "line" | "area" | "pie" | "radar" | "radial" | "scatter" | "composed";

export type ChartSeries = {
  key: string;
  label: string;
  // Composed charts only: how this series draws itself, and which y-axis it is
  // measured against. Absent on every other type, where chartType decides.
  type?: "bar" | "line" | "area";
  axis?: "left" | "right";
};

export type ChartBlock = {
  kind: "chart";
  id: string;
  chartId: string;
  chartType: ChartType;
  title: string;
  subtitle?: string;
  // A category label for every type except "scatter", where it names a numeric
  // field — the one place the two data shapes differ.
  xKey: string;
  series: ChartSeries[];
  // Each row holds xKey plus one numeric field per series key. A null measure
  // is a genuine gap (the agent had no value), never a zero.
  data: Record<string, string | number | null>[];
  // Presentation modifiers, already reconciled against chartType by the agents
  // service — an inapplicable flag arrives false, so the renderer can trust it.
  stacked?: boolean;
  horizontal?: boolean;
  showValues?: boolean;
};

export type TimelineBlock =
  ThinkingBlock | ContentBlock | SubagentBlock | ArtifactBlock | ChartBlock;

export type TimelineTerminalStatus = "completed" | "cancelled" | "failed";

// Internal reducer bookkeeping. Carried on the timeline so the fold can
// resume incrementally across WS frames; rendering code must not read it.
// Approved HITL tools re-execute under a fresh toolCallId on resume; this
// marks the stalled item the next matching TOOL_CALL_START must merge into.
export type PendingToolRetool = { block: number; item: number; name: string };

export type TimelineFoldIndexes = {
  openThinkingIndex: number | null;
  openContentIndex: number | null;
  subagentIndexByKey: Record<string, number>;
  taskIdRemap: Record<string, string>;
  namespaceToKey: Record<string, string>;
  toolPaths: Record<string, { block: number; item: number }>;
  pendingRetool: PendingToolRetool | null;
  blockCounter: number;
  itemCounter: number;
  subFolds: Record<string, SubagentFoldIndexes>;
};

export type SubagentFoldIndexes = {
  openThinkingIndex: number | null;
  openContentIndex: number | null;
  toolPaths: Record<string, { block: number; item: number }>;
  pendingRetool: PendingToolRetool | null;
};

export type RunTimeline = {
  blocks: TimelineBlock[];
  plan: PlanSnapshot | null;
  interrupts: TimelineHitlApproval[];
  subagentCount: number;
  terminal: boolean;
  terminalStatus?: TimelineTerminalStatus;
  lastSeq: number;
  fold: TimelineFoldIndexes;
};

/**
 * View model for one sub-agent panel, produced by `subagentBlockToItem` in the
 * timeline reducer and rendered by `SubagentContainer`.
 *
 * In `shared` because it sits on the boundary between the two: it was declared
 * on the chat component, which made `features/inference` (the run engine) import
 * a presentational module from `features/chat` — the sharpest of the layering
 * inversions, since it pointed from the engine at the UI.
 */
export type SubagentInterrupt = {
  threadId: string;
  content: unknown;
};

export type SubagentTool = {
  id: string;
  name: string;
  status?: "running" | "completed" | "error";
  args?: string;
  result?: string;
};

export type SubagentItem = {
  id: string;
  label?: string;
  type?: string;
  description?: string;
  namespace?: string;
  prompt?: string;
  text?: string;
  tools?: SubagentTool[];
  interrupts?: SubagentInterrupt[];
};
