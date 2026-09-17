// ------------------------------------------------------
// Inference Run Schemas
// ------------------------------------------------------
import type { ConversationDetail, ConversationSummary } from "./conversations";
import type { MessageIn, MessageOut } from "./messages";
import type { RunTimeline } from "./timeline";

export type InferenceRunStatus =
  "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";

export type InferenceRun = {
  id: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  parentMessageId?: string | null;
  status: InferenceRunStatus | string;
  // Set when this run was produced by a scheduled-task fire (lets the UI tie a
  // live run back to its task for the "running" badge).
  scheduledTaskId?: string | null;
  messagePath: string[];
  content?: string | null;
  thinking?: string[] | null;
  rawEvents?: Record<string, any>[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  pendingInterrupts?: number;
  errorMessage?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  cancelRequestedAt?: Date | null;
  updatedAt: Date;
  timeline?: RunTimeline;
};

export type InferenceStartMode = "new" | "send" | "edit" | "retry" | "shared_continue";

export type InferenceStartRequest = {
  mode: InferenceStartMode;
  agentId?: string;
  isPrivate?: boolean;
  title?: string;
  sharedConversationToken?: string;
  conversationId?: string;
  parentMessageId?: string;
  targetMessageId?: string;
  messagePath?: string[];
  message?: MessageIn;
};

export type InferenceStartResponse = {
  detail: ConversationDetail;
  summary: ConversationSummary;
  run: InferenceRun;
  message: MessageOut;
};

// Wire frames from the inference run stream. "snapshot" carries the full
// state (terminal runs: DB-built run+message; in-flight runs: run.rawEvents
// holds the coalesced log so far). "events" carries the new seq-stamped AG-UI
// events of one upstream chunk plus run meta. "update" is client-local only —
// REST responses (cancel/resume) merged through the same code path.
export type InferenceRunEvent = {
  type: "snapshot" | "update" | "terminal" | "events";
  run: InferenceRun;
  message?: MessageOut | null;
  summary?: ConversationSummary | null;
  events?: Record<string, any>[];
};
