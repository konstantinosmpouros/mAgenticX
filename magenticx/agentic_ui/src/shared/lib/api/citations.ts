/**
 * The sources a conversation's answers may cite (plan 42 §3.7): every source a
 * search tool returned in any of its runs, background tasks included, kept
 * durably by the agents service and served by the bridge (session + ownership
 * checked). Newest first, at most 500; an unknown conversation answers [].
 */
import type { CitationSource } from "../types";
import { requestJson } from "../http";
import { ConversationSourcesSchema, toCitationSources } from "../schemas";
import { CONVERSATIONS_BASE_PATH } from "./paths";

export async function getConversationSources(
  userId: string,
  conversationId: string,
): Promise<CitationSource[]> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(conversationId)}/sources`,
    {
      schema: ConversationSourcesSchema,
      fallbackMessage: "Failed to fetch conversation sources",
    },
  );
  // Production fails open on a schema mismatch and hands back the raw body;
  // re-checking each entry keeps an unvalidated source out of the renderer.
  return toCitationSources(data);
}
