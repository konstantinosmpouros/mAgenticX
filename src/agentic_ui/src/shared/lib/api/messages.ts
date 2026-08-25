/**
 * Message-level API — append and patch messages on an existing conversation,
 * plus the like/dislike feedback toggles.
 */
import type { MessageIn, MessageOut, MessageUpdate, UpdateConversationResponse } from "../types";
import { requestJson } from "../http";
import { PROXY_LIMIT_MB } from "../uploadGuards";
import { WireObjectSchema } from "../schemas";
import {
  transformConversationDetail,
  transformConversationSummary,
  transformMessage,
} from "../consts";
import { MESSAGES_BASE_PATH } from "./paths";

// Add a message to an existing conversation
export async function addMessageToConversation(
  userId: string,
  conversationId: string,
  payload: MessageIn,
): Promise<UpdateConversationResponse> {
  const data = (await requestJson(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    errorMessages: {
      413:
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`,
    },
    fallbackMessage: "Failed to add message",
  })) as Record<string, unknown>;

  if (data.detail) {
    const detail = transformConversationDetail(data.detail as Record<string, unknown>);
    const last = detail.messages[detail.messages.length - 1];
    return {
      message: last,
      summary: transformConversationSummary(data.summary as Record<string, unknown>),
    };
  }

  return {
    message: transformMessage(data.message as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
  };
}

// Update an existing message in a conversation (used for AI placeholders)
export async function updateMessageInConversation(
  userId: string,
  conversationId: string,
  messageId: string,
  payload: MessageUpdate,
): Promise<UpdateConversationResponse> {
  const data = (await requestJson(
    `${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}`,
    {
      method: "PATCH",
      csrf: true,
      body: payload,
      schema: WireObjectSchema,
      fallbackMessage: "Failed to update message",
    },
  )) as Record<string, unknown>;

  return {
    message: transformMessage(data.message as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
  };
}

// Like a message
export async function likeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const data = await requestJson(
    `${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/like`,
    {
      method: "POST",
      csrf: true,
      schema: WireObjectSchema,
      fallbackMessage: "Failed to like message",
    },
  );
  return transformMessage(data);
}

// Dislike a message
export async function dislikeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const data = await requestJson(
    `${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/dislike`,
    {
      method: "POST",
      csrf: true,
      schema: WireObjectSchema,
      fallbackMessage: "Failed to dislike message",
    },
  );
  return transformMessage(data);
}
