/**
 * Conversation sharing — create/list/revoke public share links, read a public
 * snapshot, and download the transient PDF export.
 */
import type {
  ConversationShareListItem,
  ConversationShareMode,
  ConversationShareResponse,
  SharedConversationDetail,
} from "../types";
import { requestJson, requestRaw, requestVoid } from "../http";
import { WireObjectArraySchema, WireObjectSchema } from "../schemas";
import { transformSharedConversationDetail } from "../consts";
import { getFilenameFromDisposition, triggerBrowserDownload } from "../download";
import { CONVERSATIONS_BASE_PATH, SHARED_CONVERSATIONS_BASE_PATH } from "./paths";

// Create a public read-only share snapshot ending at the selected AI message.
export async function shareConversation(
  userId: string,
  conversationId: string,
  messageId: string,
  mode: ConversationShareMode = "full",
  expiresAt?: Date | null,
  branchPath?: string[],
): Promise<ConversationShareResponse> {
  const data = (await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share`, {
    method: "POST",
    csrf: true,
    body: {
      messageId,
      mode,
      ...(branchPath?.length ? { branchPath } : {}),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to share conversation",
  })) as Record<string, any>;

  return {
    id: data.id,
    token: data.token,
    shareUrl: data.shareUrl,
    conversationId: data.conversationId,
    messageId: data.messageId,
    shareMode: data.shareMode ?? data.share_mode ?? mode,
    title: data.title ?? null,
    isActive: Boolean(data.isActive ?? data.is_active ?? true),
    revokedAt:
      (data.revokedAt ?? data.revoked_at) ? new Date(data.revokedAt ?? data.revoked_at) : null,
    expiresAt:
      (data.expiresAt ?? data.expires_at) ? new Date(data.expiresAt ?? data.expires_at) : null,
    createdAt: new Date(data.createdAt ?? data.created_at),
  };
}

// Download a transient PDF export for a conversation share scope.
export async function downloadConversationPdfExport(
  userId: string,
  conversationId: string,
  messageId: string,
  mode: ConversationShareMode = "full",
  branchPath?: string[],
): Promise<void> {
  const res = await requestRaw(
    `${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share/export-pdf`,
    {
      method: "POST",
      csrf: true,
      accept: "application/pdf",
      body: {
        messageId,
        mode,
        ...(branchPath?.length ? { branchPath } : {}),
      },
      fallbackMessage: "Failed to export PDF",
    },
  );

  const blob = await res.blob();
  triggerBrowserDownload(
    blob,
    getFilenameFromDisposition(res.headers.get("Content-Disposition"), "conversation.pdf"),
  );
}

export async function getSharedConversationLinks(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationShareListItem[]> {
  const data = await requestJson(
    `${CONVERSATIONS_BASE_PATH}/${userId}/shares?page=${page}&size=${size}`,
    {
      schema: WireObjectArraySchema,
      fallbackMessage: "Failed to fetch shared conversations",
    },
  );
  return (data as Record<string, any>[]).map((item) => {
    // Hoisted out of the field initializers: written inline as
    // `a ?? b ? new Date(a ?? b) : null` this is correct — `??` binds tighter
    // than `?:` — but it reads like a precedence bug and evaluates the coalesce
    // twice. Naming it says what it means.
    const revokedAt = item.revokedAt ?? item.revoked_at;
    const expiresAt = item.expiresAt ?? item.expires_at;
    return {
      id: item.id,
      token: item.token,
      shareUrl: item.shareUrl ?? item.share_url ?? `/share/${item.token}`,
      conversationId: item.conversationId ?? item.conversation_id,
      messageId: item.messageId ?? item.message_id ?? null,
      shareMode: item.shareMode ?? item.share_mode ?? "branch",
      title: item.title ?? null,
      isActive: Boolean(item.isActive ?? item.is_active),
      status: item.status ?? "active",
      revokedAt: revokedAt ? new Date(revokedAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdAt: new Date(item.createdAt ?? item.created_at),
    };
  });
}

export async function revokeSharedConversationLink(
  userId: string,
  conversationId: string,
  shareId: string,
): Promise<void> {
  await requestVoid(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share/${shareId}`, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to revoke shared conversation",
  });
}

// Fetch a public read-only shared conversation snapshot. Unauthenticated: a 401
// is a genuine access error to surface (with its status), not a session expiry.
export async function getSharedConversation(token: string): Promise<SharedConversationDetail> {
  const data = await requestJson(`${SHARED_CONVERSATIONS_BASE_PATH}/${encodeURIComponent(token)}`, {
    emitOn401: false,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to fetch shared conversation",
  });
  return transformSharedConversationDetail(data);
}
