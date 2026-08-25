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
export const PlanItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.object({
  content: z.string(),
  status: PlanItemStatusSchema,
  metadata: MetadataSchema.nullish(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanSnapshotSchema = z.object({
  items: z.array(PlanItemSchema),
  updated_at: z.number().nullish(),
  metadata: MetadataSchema.nullish(),
});
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

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
