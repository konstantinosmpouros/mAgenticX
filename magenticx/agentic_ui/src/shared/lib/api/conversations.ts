/**
 * Conversation CRUD — list (active/archived), detail, fork, and the
 * lifecycle mutations (delete, archive, unarchive, report, rename).
 */
import type { ConversationDetail, ConversationReportPayload, ConversationSummary } from "../types";
import { requestJson, requestVoid } from "../http";
import { WireObjectSchema, WirePageItemsSchema } from "../schemas";
import { transformConversationDetail, transformConversationSummary } from "../consts";
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
