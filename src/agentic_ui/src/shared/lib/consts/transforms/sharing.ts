import type { SharedConversationDetail } from "../../types/sharing";
import { transformAgent } from "./agent";
import { toDate } from "./base";
import { transformMessage } from "./message";

// Transform public shared conversation snapshot.
export const transformSharedConversationDetail = (
  detail: Record<string, any>,
): SharedConversationDetail => ({
  token: detail.token ?? "",
  title: detail.title ?? null,
  shareMode: detail.shareMode ?? detail.share_mode ?? "branch",
  agent: transformAgent(detail.agent),
  messages: (detail.messages || []).map(transformMessage),
  expiresAt:
    (detail.expiresAt ?? detail.expires_at) ? toDate(detail.expiresAt ?? detail.expires_at) : null,
  createdAt: toDate(detail.createdAt ?? detail.created_at),
});
