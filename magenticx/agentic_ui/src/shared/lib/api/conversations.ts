/**
 * Conversation CRUD — list (active/pinned/archived), detail, fork, and the
 * lifecycle mutations (delete, archive, unarchive, pin, unpin, report, rename).
 */
import type {
  CompactionOutcome,
  ConversationDetail,
  ConversationReportPayload,
  ConversationSummary,
  MessageOut,
} from "../types";
import { requestJson, requestVoid } from "../http";
import {
  CompactConversationResponseSchema,
  WireObjectSchema,
  WirePageItemsSchema,
} from "../schemas";
import {
  transformConversationDetail,
  transformConversationSummary,
  transformMessage,
} from "../consts";
import { CONVERSATIONS_BASE_PATH } from "./paths";

// Fetch conversations for a user. The bridge returns either a bare array or a
// Page shape ({ items, total, page, size }); both are accepted.
export async function getConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}?page=${page}&size=${size}`, {
    schema: WirePageItemsSchema,
    fallbackMessage: "Failed to fetch conversations",
  });
  return data.map(transformConversationSummary);
}

// The pagination ceiling. The bridge caps pins at or below it, so one request
// at this size always returns every pinned conversation.
const PINNED_PAGE_SIZE = 100;

// Fetch every pinned conversation for a user, newest pin first.
export async function getPinnedConversations(userId: string): Promise<ConversationSummary[]> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/pinned?page=1&size=${PINNED_PAGE_SIZE}`,
    {
      schema: WirePageItemsSchema,
      fallbackMessage: "Failed to fetch pinned conversations",
    },
  );
  return data.map(transformConversationSummary);
}

// The sidebar's first load: every pin plus the first page of Chats, fetched in
// parallel. The two lists are disjoint server-side, so they simply concatenate;
// later pages come from getConversations and never contain a pinned row.
export async function getSidebarConversations(
  userId: string,
  size: number,
): Promise<ConversationSummary[]> {
  const [pinned, recent] = await Promise.all([
    getPinnedConversations(userId),
    getConversations(userId, 1, size),
  ]);
  return [...pinned, ...recent];
}

// Fetch archived conversations for a user
export async function getArchivedConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/archived?page=${page}&size=${size}`,
    {
      schema: WirePageItemsSchema,
      fallbackMessage: "Failed to fetch archived conversations",
    },
  );
  return data.map(transformConversationSummary);
}

// Fetch conversation details with full message history
export async function getConversationDetail(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}`, {
    schema: WireObjectSchema,
    fallbackMessage: "Failed to fetch conversation details",
  });
  return transformConversationDetail(data);
}

// Delete a conversation
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await requestVoid(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}`, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to delete conversation",
  });
}

// Archive a conversation and return the updated summary
export async function archiveConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/archive`, {
    method: "PATCH",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to archive conversation",
  });
  return transformConversationSummary(data);
}

// Unarchive a conversation and return the updated summary
export async function unarchiveConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/unarchive`,
    {
      method: "PATCH",
      csrf: true,
      schema: WireObjectSchema,
      fallbackMessage: "Failed to unarchive conversation",
    },
  );
  return transformConversationSummary(data);
}

// Pin or unpin a conversation and return the updated summary. Pinning fails
// with 409 past the pin cap, or for a private or archived conversation.
export async function setConversationPinned(
  userId: string,
  conversationId: string,
  pinned: boolean,
): Promise<ConversationSummary> {
  const action = pinned ? "pin" : "unpin";
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/${action}`,
    {
      method: "PATCH",
      csrf: true,
      schema: WireObjectSchema,
      fallbackMessage: pinned ? "Failed to pin conversation" : "Failed to unpin conversation",
    },
  );
  return transformConversationSummary(data);
}

// Report a conversation with an optional specific message target
export async function reportConversation(
  userId: string,
  conversationId: string,
  payload: ConversationReportPayload,
): Promise<ConversationSummary> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/report`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to report conversation",
  });
  return transformConversationSummary(data);
}

// Rename a conversation and return the updated summary
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/title`, {
    method: "PATCH",
    csrf: true,
    body: { title },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to rename conversation",
  });
  return transformConversationSummary(data);
}

// Fork the current branch ending at the selected AI message.
export async function forkConversation(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<ConversationSummary> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/fork`, {
    method: "POST",
    csrf: true,
    body: { messageId },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to fork conversation",
  });
  return transformConversationSummary(data);
}

// Compact the conversation's context now, after the given answer (plan 34).
// The summary call can take a while; the bridge bounds it below the proxy's
// timeout, so this always resolves with the bridge's own answer.
export async function compactConversation(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<CompactionOutcome> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/compact`, {
    method: "POST",
    csrf: true,
    body: { messageId },
    schema: CompactConversationResponseSchema,
    fallbackMessage: "Failed to compact the conversation",
  });
  return data.status === "compacted" && data.message
    ? { status: "compacted", message: transformMessage(data.message) }
    : { status: "nothing_to_compact", message: null };
}

// Take back the compaction recorded on the given answer, while nothing was sent after it.
export async function undoCompaction(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/compact/undo`,
    {
      method: "POST",
      csrf: true,
      body: { messageId },
      schema: WireObjectSchema,
      fallbackMessage: "Failed to undo the compaction",
    },
  );
  return transformMessage(data);
}
