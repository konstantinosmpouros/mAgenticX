import { CustomEventSchema, EventSchemas } from "@ag-ui/core";
import { z } from "zod";

export * from "@ag-ui/core";

export const HITL_INTERRUPT_EVENT_TYPE = "HITL_INTERRUPT" as const;
export const PLAN_SNAPSHOT_EVENT_TYPE = "PLAN_SNAPSHOT" as const;
export const TASK_SUBAGENT_EVENT_TYPE = "TASK_SUBAGENT" as const;
export const SUBAGENT_EVENT_TYPE = "SUBAGENT_EVENT" as const;
export const BEFORE_AGENT_EVENT_TYPE = "BEFORE_AGENT_EVENT" as const;

export const PLAN_SNAPSHOT_EVENT_NAMES = [
  PLAN_SNAPSHOT_EVENT_TYPE,
  "plan_snapshot",
] as const;

// Nullable fields below use .nullish(), never .optional(): the agents-service
// emitter serializes payloads with Pydantic model_dump(), which writes unset
// Optionals as explicit nulls — .optional() rejects null and would silently
// drop the whole event at safeParse.
const MetadataSchema = z.record(z.string(), z.any());

export type AGUIEvent = z.infer<typeof EventSchemas>;

// ------------------------------------------------------
// HITL Interrupt Types
// ------------------------------------------------------
export const HITLInterruptPayloadSchema = z.object({
  thread_id: z.string(),
  interrupt: z.any(),
  metadata: MetadataSchema.nullish(),
});
export type HITLInterruptEvent = z.infer<typeof HITLInterruptPayloadSchema>;

export const HITLInterruptCustomEventSchema = CustomEventSchema.extend({
  name: z.literal(HITL_INTERRUPT_EVENT_TYPE),
  value: HITLInterruptPayloadSchema,
});


// ------------------------------------------------------
// Plan Snapshot Types
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

export const PlanSnapshotCustomEventSchema = CustomEventSchema.extend({
  name: z.enum(PLAN_SNAPSHOT_EVENT_NAMES),
  value: PlanSnapshotSchema,
});


// ------------------------------------------------------
// SubAgent Types
// ------------------------------------------------------
export const TaskSubAgentPayloadSchema = z.object({
  task_id: z.string(),
  subagent_type: z.string(),
  description: z.string(),
});
export type TaskSubAgentEvent = z.infer<typeof TaskSubAgentPayloadSchema>;

export const SubAgentPayloadSchema = z.object({
  task_id: z.string(),
  namespace: z.array(z.string()),
  event: z.record(z.string(), z.any()),
});
export type SubAgentEvent = z.infer<typeof SubAgentPayloadSchema>;

export const TaskSubAgentCustomEventSchema = CustomEventSchema.extend({
  name: z.literal(TASK_SUBAGENT_EVENT_TYPE),
  value: TaskSubAgentPayloadSchema,
});

export const SubAgentCustomEventSchema = CustomEventSchema.extend({
  name: z.literal(SUBAGENT_EVENT_TYPE),
  value: SubAgentPayloadSchema,
});


// ------------------------------------------------------
// Before Agent Types
// ------------------------------------------------------
export const BeforeAgentPayloadSchema = z.object({
  message: z.string(),
  metadata: MetadataSchema.nullish(),
});
export type BeforeAgentEvent = z.infer<typeof BeforeAgentPayloadSchema>;

export const BeforeAgentCustomEventSchema = CustomEventSchema.extend({
  name: z.literal(BEFORE_AGENT_EVENT_TYPE),
  value: BeforeAgentPayloadSchema,
});



// ------------------------------------------------------
// Union of all custom events for AGUI
// ------------------------------------------------------
export const CustomAguiEventSchema = z.union([
  PlanSnapshotCustomEventSchema,
  HITLInterruptCustomEventSchema,
  TaskSubAgentCustomEventSchema,
  SubAgentCustomEventSchema,
  BeforeAgentCustomEventSchema,
]);

export type PlanSnapshotCustomEvent = z.infer<typeof PlanSnapshotCustomEventSchema>;
export type HITLInterruptCustomEvent = z.infer<typeof HITLInterruptCustomEventSchema>;
export type TaskSubAgentCustomEvent = z.infer<typeof TaskSubAgentCustomEventSchema>;
export type SubAgentCustomEvent = z.infer<typeof SubAgentCustomEventSchema>;
export type BeforeAgentCustomEvent = z.infer<typeof BeforeAgentCustomEventSchema>;
export type CustomAguiEvent = z.infer<typeof CustomAguiEventSchema>;
