import type { AttachmentOut } from "../../types/attachments";
import type { MessageOut } from "../../types/messages";
import { toDate } from "./base";

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
});

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
  error: message.error ?? undefined,
  errorMessage: message.errorMessage ?? undefined,
  streamingStatus: message.streamingStatus ?? message.streaming_status ?? null,
  rawEvents: message.rawEvents ?? message.raw_events ?? [],
});
