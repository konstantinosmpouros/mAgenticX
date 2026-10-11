import type { AttachmentOut } from "../../types/attachments";
import type { CommandRef } from "../../types/commands";
import type { MessageCompaction, MessageOut } from "../../types/messages";
import { toDate, toOptionalNumber, toOptionalString } from "./base";

// A manual compaction on an answer (plan 34), or null for anything that is not
// one. Field-whitelisted like the rest of this module.
export const transformCompaction = (value: unknown): MessageCompaction | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.trigger !== "manual") return null;
  return {
    trigger: "manual",
    tokensBefore: toOptionalNumber(record.tokensBefore) ?? 0,
    tokensAfter: toOptionalNumber(record.tokensAfter) ?? 0,
    freed: toOptionalNumber(record.freed) ?? 0,
    window: toOptionalNumber(record.window),
    summarizedMessages: toOptionalNumber(record.summarizedMessages) ?? 0,
    keptMessages: toOptionalNumber(record.keptMessages) ?? 0,
    summary: typeof record.summary === "string" ? record.summary : "",
    model: toOptionalString(record.model),
    inputTokens: toOptionalNumber(record.inputTokens) ?? 0,
    cachedInputTokens: toOptionalNumber(record.cachedInputTokens) ?? 0,
    outputTokens: toOptionalNumber(record.outputTokens) ?? 0,
    latencyMs: toOptionalNumber(record.latencyMs) ?? 0,
    compactedAt: toDate(record.compactedAt),
    undoneAt: record.undoneAt ? toDate(record.undoneAt) : null,
  };
};

// Transform attachment object from backend to frontend type.
// The explicit return type is load-bearing, not decoration: this mapper is
// field-whitelisted, so without it TypeScript infers `origin: any` and the
// `"upload" | "generated"` union goes unchecked at the one boundary where a
// typo'd literal would silently mis-classify every generated artifact.
export const transformAttachment = (attachment: Record<string, any>): AttachmentOut => ({
  id: attachment?.id,
  name: attachment?.name ?? attachment?.file_name ?? "",
  mime: attachment?.mime ?? attachment?.mime_type ?? "",
  size: attachment?.size ?? attachment?.size_bytes ?? undefined,
  timestamp: toDate(attachment?.timestamp ?? attachment?.created_at),
  blobId: attachment?.blobId ?? attachment?.blob_id ?? undefined,
  data: attachment?.data ?? undefined,
  // Provenance + agent-supplied metadata: without these a generated deliverable
  // reads as a plain upload, so it double-renders (top stack + inline card) and
  // the inline artifact card can never reconcile to its blob (stuck "Preparing").
  origin: attachment?.origin ?? "upload",
  title: attachment?.title ?? undefined,
  summary: attachment?.summary ?? undefined,
  presented: attachment?.presented === true,
});

// The slash command a user message ran (plan 35): only a well-formed name, or
// nothing — this field becomes a chip, so junk must never render.
const transformCommand = (raw: unknown): CommandRef | null => {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw as Record<string, unknown>).name;
  return typeof name === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ? { name } : null;
};

// Transform message object from backend to frontend type
export const transformMessage = (message: Record<string, any>): MessageOut => ({
  id: message.id,
  parentMessageId: message.parentMessageId ?? message.parent_message_id ?? undefined,
  content: message.content ?? "",
  sender: message.sender,
  liked: message.liked ?? undefined,
  agentId: message.agentId ?? message.agent_id ?? null,
  agentName: message.agentName ?? message.agent_name ?? null,
  created_at: toDate(message.created_at),
  updated_at: toDate(message.updated_at),
  attachments: (message.attachments || []).map(transformAttachment),
  thinking: message.thinking ?? undefined,
  thinkingTime: message.thinkingTime ?? undefined,
  inputTokens: message.inputTokens ?? message.input_tokens ?? undefined,
  outputTokens: message.outputTokens ?? message.output_tokens ?? undefined,
  cachedInputTokens: toOptionalNumber(message.cachedInputTokens ?? message.cached_input_tokens),
  reasoningTokens: toOptionalNumber(message.reasoningTokens ?? message.reasoning_tokens),
  modelLatencyMs: toOptionalNumber(message.modelLatencyMs ?? message.model_latency_ms),
  contextTokens: toOptionalNumber(message.contextTokens ?? message.context_tokens),
  contextWindow: toOptionalNumber(message.contextWindow ?? message.context_window),
  compactionPercent: toOptionalNumber(message.compactionPercent ?? message.compaction_percent),
  modelName: toOptionalString(message.modelName ?? message.model_name),
  error: message.error ?? undefined,
  errorMessage: message.errorMessage ?? undefined,
  streamingStatus: message.streamingStatus ?? message.streaming_status ?? null,
  rawEvents: message.rawEvents ?? message.raw_events ?? [],
  compaction: transformCompaction(message.compaction),
  command: transformCommand(message.command),
});
