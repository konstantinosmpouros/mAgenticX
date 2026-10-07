import type { InferenceRun } from "../../types/inference";
import { toDate, toOptionalNumber, toOptionalString } from "./base";

export const transformInferenceRun = (run: Record<string, any>): InferenceRun => ({
  id: run.id,
  userId: run.userId ?? run.user_id ?? "",
  conversationId: run.conversationId ?? run.conversation_id ?? "",
  assistantMessageId: run.assistantMessageId ?? run.assistant_message_id ?? "",
  parentMessageId: run.parentMessageId ?? run.parent_message_id ?? null,
  status: run.status ?? "running",
  scheduledTaskId: run.scheduledTaskId ?? run.scheduled_task_id ?? null,
  messagePath: Array.isArray(run.messagePath ?? run.message_path)
    ? (run.messagePath ?? run.message_path)
    : [],
  content: run.content ?? null,
  thinking: Array.isArray(run.thinking) ? run.thinking : null,
  rawEvents: Array.isArray(run.rawEvents ?? run.raw_events)
    ? (run.rawEvents ?? run.raw_events)
    : [],
  inputTokens: run.inputTokens ?? run.input_tokens ?? null,
  outputTokens: run.outputTokens ?? run.output_tokens ?? null,
  cachedInputTokens: toOptionalNumber(run.cachedInputTokens ?? run.cached_input_tokens),
  reasoningTokens: toOptionalNumber(run.reasoningTokens ?? run.reasoning_tokens),
  modelLatencyMs: toOptionalNumber(run.modelLatencyMs ?? run.model_latency_ms),
  contextTokens: toOptionalNumber(run.contextTokens ?? run.context_tokens),
  contextWindow: toOptionalNumber(run.contextWindow ?? run.context_window),
  compactionPercent: toOptionalNumber(run.compactionPercent ?? run.compaction_percent),
  modelName: toOptionalString(run.modelName ?? run.model_name),
  pendingInterrupts: typeof run.pendingInterrupts === "number" ? run.pendingInterrupts : undefined,
  errorMessage: run.errorMessage ?? run.error_message ?? null,
  startedAt: toDate(run.startedAt ?? run.started_at),
  completedAt:
    (run.completedAt ?? run.completed_at) ? toDate(run.completedAt ?? run.completed_at) : null,
  cancelRequestedAt:
    (run.cancelRequestedAt ?? run.cancel_requested_at)
      ? toDate(run.cancelRequestedAt ?? run.cancel_requested_at)
      : null,
  updatedAt: toDate(run.updatedAt ?? run.updated_at),
});
