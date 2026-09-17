// ------------------------------------------------------
// Conversation Sharing Schemas
// ------------------------------------------------------
import type { Agent } from "./agents";
import type { MessageOut } from "./messages";

export type ConversationShareMode = "full" | "branch" | "message";

export type ConversationShareResponse = {
  id: string;
  token: string;
  shareUrl: string;
  conversationId: string;
  messageId: string;
  shareMode: ConversationShareMode;
  title?: string | null;
  isActive: boolean;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
};

export type ConversationShareStatus = "active" | "expired" | "revoked";

export type ConversationShareListItem = {
  id: string;
  token: string;
  shareUrl: string;
  conversationId: string;
  messageId?: string | null;
  shareMode: ConversationShareMode;
  title?: string | null;
  isActive: boolean;
  status: ConversationShareStatus;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
};

export type SharedConversationDetail = {
  token: string;
  title?: string | null;
  shareMode: ConversationShareMode;
  agent: Agent;
  messages: MessageOut[];
  expiresAt?: Date | null;
  createdAt: Date;
};
