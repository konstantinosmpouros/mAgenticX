/**
 * Wire contracts for the custom AG-UI events the agents service emits.
 *
 * Scope note: this module describes event *payloads* only (the `*PayloadSchema`
 * values). It deliberately does NOT wrap them in `CustomEventSchema.extend({...})`
 * envelopes or a discriminated union over all of them. Such a union existed and
 * was never executed — the timeline reducer validates payloads individually at
 * the point it handles each event — which made it a second, silent description
 * of the event vocabulary that could drift from the reducer without any test or
 * type error catching it. One description, in one place: `applyEvent` in
 * `timeline.ts` decides which events exist; this file says what their payloads
 * look like. Add the payload schema here and the branch there, nothing else.
 */
import { z } from "zod";

export * from "@ag-ui/core";

export const HITL_INTERRUPT_EVENT_TYPE = "HITL_INTERRUPT" as const;
export const PLAN_SNAPSHOT_EVENT_TYPE = "PLAN_SNAPSHOT" as const;
export const TASK_SUBAGENT_EVENT_TYPE = "TASK_SUBAGENT" as const;
export const SUBAGENT_EVENT_TYPE = "SUBAGENT_EVENT" as const;
export const BEFORE_AGENT_EVENT_TYPE = "BEFORE_AGENT_EVENT" as const;
export const TOKEN_USAGE_EVENT_TYPE = "TOKEN_USAGE" as const;
export const PRESENT_ARTIFACT_EVENT_TYPE = "PRESENT_ARTIFACT" as const;
export const RENDER_CHART_EVENT_TYPE = "RENDER_CHART" as const;

export const PLAN_SNAPSHOT_EVENT_NAMES = [PLAN_SNAPSHOT_EVENT_TYPE, "plan_snapshot"] as const;

// Nullable fields below use .nullish(), never .optional(): the agents-service
// emitter serializes payloads with Pydantic model_dump(), which writes unset
// Optionals as explicit nulls — .optional() rejects null and would silently
// drop the whole event at safeParse.
const MetadataSchema = z.record(z.string(), z.any());

// ------------------------------------------------------
// HITL Interrupt
// ------------------------------------------------------
export const HITLInterruptPayloadSchema = z.object({
  thread_id: z.string(),
  interrupt: z.any(),
  metadata: MetadataSchema.nullish(),
});

// ------------------------------------------------------
// Plan Snapshot
// ------------------------------------------------------
// Declared in shared/lib/schemas.ts (a zod-only leaf) so shared/lib/types can
// name PlanSnapshot without importing from features/. Re-exported here so the
// AG-UI consumers keep one import site for event payloads.
export {
  PlanItemStatusSchema,
  PlanItemSchema,
  PlanSnapshotSchema,
  type PlanItemStatus,
  type PlanItem,
  type PlanSnapshot,
} from "@/shared/lib/schemas";

// ------------------------------------------------------
// SubAgent
// ------------------------------------------------------
export const TaskSubAgentPayloadSchema = z.object({
  task_id: z.string(),
  subagent_type: z.string(),
  description: z.string(),
});

export const SubAgentPayloadSchema = z.object({
  task_id: z.string(),
  namespace: z.array(z.string()),
  event: z.record(z.string(), z.any()),
});

// ------------------------------------------------------
// Before Agent
// ------------------------------------------------------
export const BeforeAgentPayloadSchema = z.object({
  message: z.string(),
  metadata: MetadataSchema.nullish(),
});

// ------------------------------------------------------
// Token Usage (collect-only — per-AI-message token counts)
// ------------------------------------------------------
export const TokenUsagePayloadSchema = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  total_tokens: z.number().nullish(),
  input_token_details: MetadataSchema.nullish(),
  output_token_details: MetadataSchema.nullish(),
  message_id: z.string().nullish(),
});

// ------------------------------------------------------
// Present Artifact (agent-designated deliverable)
// ------------------------------------------------------
export const PresentArtifactPayloadSchema = z.object({
  artifact_id: z.string(),
  path: z.string(),
  filename: z.string(),
  title: z.string(),
  summary: z.string().nullish(),
  mime: z.string().nullish(),
  status: z.string().nullish(),
});

// ------------------------------------------------------
// Render Chart (agent-drawn inline chart)
// ------------------------------------------------------
// The agents service normalizes the payload before emitting — rows are already
// bounded, numerically coerced, and projected to xKey + the series keys — so
// this contract validates the shape rather than re-parsing the data. A row
// value is number | null (a null is a real gap) or a string (the category).
export const ChartSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  // Composed charts only; absent elsewhere, hence nullish rather than required.
  type: z.enum(["bar", "line", "area"]).nullish(),
  axis: z.enum(["left", "right"]).nullish(),
});

export const RenderChartPayloadSchema = z.object({
  chart_id: z.string(),
  type: z.enum(["bar", "line", "area", "pie", "radar", "radial", "scatter", "composed"]),
  title: z.string(),
  subtitle: z.string().nullish(),
  x_key: z.string(),
  series: z.array(ChartSeriesSchema).min(1),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).min(1),
  // Reconciled against `type` agents-side before emission, so an inapplicable
  // flag is already false here. Nullish so an older event still parses.
  stacked: z.boolean().nullish(),
  horizontal: z.boolean().nullish(),
  show_values: z.boolean().nullish(),
});
