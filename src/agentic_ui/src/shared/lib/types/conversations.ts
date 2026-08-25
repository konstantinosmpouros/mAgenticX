// ------------------------------------------------------
// Conversation Schemas from Backend
// ------------------------------------------------------
import type { Agent } from "./agents";
import type { MessageIn, MessageOut } from "./messages";

// Raw shape returned by backend for conversations
export type ConversationSummary = {
  id: string;
  agent: Agent;
  forkedParentId?: string | null;
  forkedMessageId?: string | null;
  title?: string;
  isPrivate: boolean;
  isArchived?: boolean;
  archivedAt?: Date | null;
  isReported?: boolean;
  reportedAt?: Date | null;
  activeRunId?: string | null;
  isStreaming?: boolean;
  lastMessage?: string;
  created_at: string;
  updated_at: string;
};

// Backend conversation detail type from API response
export type ConversationDetail = {
  id: string;
  agent: Agent;
  forkedParentId?: string | null;
  forkedMessageId?: string | null;
  title?: string;
  isPrivate: boolean;
  isArchived?: boolean;
  archivedAt?: Date | null;
  isReported?: boolean;
  reportedAt?: Date | null;
  activeRunId?: string | null;
  isStreaming?: boolean;
  created_at: Date;
  updated_at: Date;
  messages: MessageOut[];
};

export type ConversationReportPayload = {
  reason: string;
  details?: string;
  messageId?: string | null;
};

// ------------------------------------------------------
// API Request Schemas (for creating conversations)
// ------------------------------------------------------
// Conversation creation payload
export type ConversationIn = {
  agentId: string;
  isPrivate: boolean;
  title?: string;
  firstMessage: MessageIn;
};

// Response from createConversation API
export type CreateConversationResponse = {
  detail: ConversationDetail;
  summary: ConversationSummary;
};

// Response from addMessageToConversation API
export type UpdateConversationResponse = {
  message: MessageOut;
  summary: ConversationSummary;
};
