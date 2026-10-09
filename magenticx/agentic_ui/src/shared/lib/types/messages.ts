// ------------------------------------------------------
// Message Schemas
// ------------------------------------------------------
import type { AttachmentIn, AttachmentOut } from "./attachments";

// A manual compaction recorded on the answer it follows (plan 34). Token
// figures are estimates until the next model call reports the real prompt;
// `undoneAt` is set once it was taken back.
export type MessageCompaction = {
  trigger: "manual";
  tokensBefore: number;
  tokensAfter: number;
  freed: number;
  window?: number;
  summarizedMessages: number;
  keptMessages: number;
  summary: string;
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  latencyMs: number;
  compactedAt: Date;
  undoneAt: Date | null;
};

// What a compaction request did: `nothing_to_compact` when the conversation
// all fits in the part that is kept.
export type CompactionOutcome =
  | { status: "compacted"; message: MessageOut }
  | { status: "nothing_to_compact"; message: null };

// Backend message type from API response
export type MessageOut = {
  id: string;
  parentMessageId?: string | null;
  content?: string;
  sender: string;
  liked?: boolean;
  agentId?: string | null;
  agentName?: string | null;
  created_at: Date;
  updated_at: Date;
  attachments: AttachmentOut[];
  thinking?: string[];
  thinkingTime?: number;
  inputTokens?: number;
  outputTokens?: number;
  // The rest of the run's usage (plan: usage metrics). Summed over the run:
  // cached and reasoning tokens, time in the model. The main agent's context
  // on its last call: prompt size of the model's window, where it compacts.
  cachedInputTokens?: number;
  reasoningTokens?: number;
  modelLatencyMs?: number;
  contextTokens?: number;
  contextWindow?: number;
  compactionPercent?: number;
  modelName?: string;
  error?: boolean;
  errorMessage?: string;
  streamingStatus?: string | null;
  rawEvents?: Record<string, any>[]; // defaults to [] on the backend
  compaction?: MessageCompaction | null;
};

// Message input for API requests
export type MessageIn = {
  sender: string;
  parentMessageId?: string | null;
  content?: string;
  attachments?: AttachmentIn[];
  thinking?: string[];
  thinkingTime?: number;
  error?: boolean;
  errorMessage?: string;
  rawEvents?: Record<string, any>[]; // defaults to [] on the backend
};

// Message update payload (used to finalise AI placeholders)
export type MessageUpdate = {
  content: string;
  thinking?: string[];
  thinkingTime?: number;
  error?: boolean;
  errorMessage?: string;
  rawEvents?: Record<string, any>[]; // defaults to [] on the backend
};
