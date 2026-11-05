import type {
  WorkflowContextConfig,
  WorkflowContextMode,
  WorkflowNodeDef,
  WorkflowSpec,
  WorkflowStepOption,
} from "@/shared/lib/types";
import { nodeLabel } from "@/features/workflows/lib/kinds";
import { CONTEXT_COUNT_MAX, CONTEXT_COUNT_MIN, CONTEXT_MODES, DEFAULT_CONTEXT } from "./consts";
import { LLM_KIND, upstreamOf } from "./graph";

/**
 * How data moves between steps without variables: an llm / code step's
 * `context` (which earlier steps' outputs it is sent at run time) and an llm
 * step's conversation (`memory`, `thread`). Pure: what the widgets offer,
 * the one-line preview of what a step will receive, and keeping the step ids
 * these fields hold in line when a step is renamed or deleted.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const MODES = new Set<string>(CONTEXT_MODES.map((mode) => mode.value));

/** A stored `context` read leniently; anything missing is the engine's default. */
export function asContext(value: unknown): WorkflowContextConfig {
  const record = isRecord(value) ? value : {};
  const mode = typeof record.mode === "string" && MODES.has(record.mode) ? (record.mode as WorkflowContextMode) : DEFAULT_CONTEXT.mode;
  const count =
    typeof record.count === "number" && Number.isFinite(record.count)
      ? Math.min(CONTEXT_COUNT_MAX, Math.max(CONTEXT_COUNT_MIN, Math.round(record.count)))
      : DEFAULT_CONTEXT.count;
  const steps = Array.isArray(record.steps) ? record.steps.filter((step): step is string => typeof step === "string") : [];
  return { mode, count, steps };
}

const optionOf = (node: WorkflowNodeDef): WorkflowStepOption => ({
  id: node.id,
  label: nodeLabel(node),
  kind: node.kind,
});

/** The steps whose output `nodeId` may be sent: everything with a path into it, in canvas order. */
export function contextStepOptions(spec: Pick<WorkflowSpec, "nodes" | "edges">, nodeId: string): WorkflowStepOption[] {
  const before = upstreamOf(nodeId, spec.edges);
  return spec.nodes.filter((node) => node.id !== nodeId && before.has(node.id)).map(optionOf);
}

/** The steps with a connection straight into `nodeId` (one of them ran just before it). */
export function previousSteps(spec: Pick<WorkflowSpec, "nodes" | "edges">, nodeId: string): WorkflowStepOption[] {
  const sources = new Set(spec.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  return spec.nodes.filter((node) => sources.has(node.id) && node.id !== nodeId).map(optionOf);
}

const labelOf = (spec: Pick<WorkflowSpec, "nodes"> | undefined, id: string): string =>
  nodeLabel(spec?.nodes.find((node) => node.id === id), id);

/**
 * What the step will be sent, in one line — worked out from the graph, so
 * "previous" with several ways in can only say "the step that ran just
 * before"; "last" depends on the run, so it says what it counts.
 */
export function contextPreview(
  spec: Pick<WorkflowSpec, "nodes" | "edges"> | undefined,
  nodeId: string,
  context: WorkflowContextConfig,
): string {
  switch (context.mode) {
    case "none":
      return "Sends nothing from earlier steps.";
    case "last":
      return context.count === 1
        ? "Sends: the last step that ran (in a loop, every run of it)."
        : `Sends: the last ${context.count} steps that ran (in a loop, every run of a step).`;
    case "steps":
      return context.steps.length
        ? `Sends: ${context.steps.map((id) => labelOf(spec, id)).join(", ")}.`
        : "Pick the steps to send.";
    default: {
      if (!spec) return "Sends: the step that ran just before.";
      const before = previousSteps(spec, nodeId);
      if (!before.length) return "Nothing leads into this step yet.";
      if (before.length === 1) return `Sends: ${before[0].label}.`;
      return `Sends: the step that ran just before (${before.map((step) => step.label).join(" or ")}).`;
    }
  }
}

/** The conversation an llm step talks in: its `thread`, else its own. */
export const conversationOf = (node: Pick<WorkflowNodeDef, "id" | "config">): string => {
  const thread = node.config.thread;
  return typeof thread === "string" && thread ? thread : node.id;
};

/** Every other llm step: whose conversation this one may share. */
export function threadOptions(spec: Pick<WorkflowSpec, "nodes">, nodeId: string): WorkflowStepOption[] {
  return spec.nodes.filter((node) => node.kind === LLM_KIND && node.id !== nodeId).map(optionOf);
}

/** The other llm steps that talk in the same conversation as `nodeId`. */
export function sharedWith(spec: Pick<WorkflowSpec, "nodes">, nodeId: string): WorkflowStepOption[] {
  const self = spec.nodes.find((node) => node.id === nodeId);
  if (!self) return [];
  const key = conversationOf(self);
  return spec.nodes
    .filter((node) => node.kind === LLM_KIND && node.id !== nodeId && conversationOf(node) === key)
    .map(optionOf);
}

/**
 * A config with the step ids it holds as plain values — `context.steps` and
 * `thread` — renamed `from` → `to` (templates are `renameNodeReferences`'s).
 */
export function renameStepIds(config: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  let next = config;
  if (isRecord(config.context) && Array.isArray(config.context.steps) && config.context.steps.includes(from)) {
    next = {
      ...next,
      context: { ...config.context, steps: config.context.steps.map((step) => (step === from ? to : step)) },
    };
  }
  if (config.thread === from) next = { ...next, thread: to };
  return next;
}

/** A config with deleted steps gone from `context.steps`, and a `thread` that named one back to its own. */
export function dropStepIds(config: Record<string, unknown>, removed: ReadonlySet<string>): Record<string, unknown> {
  let next = config;
  if (isRecord(config.context) && Array.isArray(config.context.steps) && config.context.steps.some((step) => removed.has(step))) {
    next = {
      ...next,
      context: { ...config.context, steps: config.context.steps.filter((step) => !removed.has(step)) },
    };
  }
  if (typeof config.thread === "string" && removed.has(config.thread)) next = { ...next, thread: "" };
  return next;
}
