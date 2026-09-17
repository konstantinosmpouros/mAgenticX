/**
 * Message-level API — the like/dislike feedback toggles.
 *
 * Appending and patching messages used to live here; both moved to the
 * backend-driven inference start flow (see api/inference.ts).
 */
import type { MessageOut } from "../types";
import { requestJson } from "../http";
import { WireObjectSchema } from "../schemas";
import { transformMessage } from "../consts";
import { MESSAGES_BASE_PATH } from "./paths";

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
