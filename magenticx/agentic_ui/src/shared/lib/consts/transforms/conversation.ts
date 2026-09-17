import type { ConversationDetail, ConversationSummary } from "../../types/conversations";
import { transformAgent } from "./agent";
import { toDate } from "./base";
import { transformMessage } from "./message";

// Transform conversation summary object from backend to frontend type
export const transformConversationSummary = (summary: Record<string, any>): ConversationSummary => {
  const archivedAt = summary.archivedAt ?? summary.archived_at;
  const reportedAt = summary.reportedAt ?? summary.reported_at;
  return {
    id: summary.id,
    agent: transformAgent(summary.agent, {
      id: summary.agent?.id ?? summary.agentId ?? summary.agent_id,
      name: summary.agent?.name ?? summary.agentName ?? summary.agent_name,
      isActive:
        summary.agent?.isActive ??
        summary.agent?.is_active ??
        summary.isActive ??
        summary.is_active,
    }),
    forkedParentId: summary.forkedParentId ?? summary.forked_parent_id ?? null,
    forkedMessageId: summary.forkedMessageId ?? summary.forked_message_id ?? null,
    title: summary.title ?? undefined,
    // Accept both casings like every neighbouring field. The bridge serializes
    // this as camelCase today, but privacy is the one flag where a casing
    // mismatch would silently render a private conversation as a public one —
    // so it must not depend on a single key being spelled the expected way.
    isPrivate: Boolean(summary.isPrivate ?? summary.is_private),
    isArchived: Boolean(summary.isArchived ?? summary.is_archived),
    archivedAt: archivedAt ? toDate(archivedAt) : null,
    isReported: Boolean(summary.isReported ?? summary.is_reported),
    reportedAt: reportedAt ? toDate(reportedAt) : null,
    activeRunId: summary.activeRunId ?? null,
    isStreaming: Boolean(summary.isStreaming ?? summary.activeRunId),
    lastMessage: summary.lastMessage ?? undefined,
    created_at: summary.created_at ?? "",
    updated_at: summary.updated_at ?? "",
  };
};

// Transform conversation detail object from backend to frontend type
export const transformConversationDetail = (detail: Record<string, any>): ConversationDetail => {
  const archivedAt = detail.archivedAt ?? detail.archived_at;
  const reportedAt = detail.reportedAt ?? detail.reported_at;
  return {
    id: detail.id,
    agent: transformAgent(detail.agent, {
      id: detail.agent?.id ?? detail.agentId ?? detail.agent_id,
      name: detail.agent?.name ?? detail.agentName ?? detail.agent_name,
      isActive:
        detail.agent?.isActive ?? detail.agent?.is_active ?? detail.isActive ?? detail.is_active,
    }),
    forkedParentId: detail.forkedParentId ?? detail.forked_parent_id ?? null,
    forkedMessageId: detail.forkedMessageId ?? detail.forked_message_id ?? null,
    title: detail.title ?? "",
    // See transformConversationSummary — privacy must not hinge on key casing.
    isPrivate: Boolean(detail.isPrivate ?? detail.is_private),
    isArchived: Boolean(detail.isArchived ?? detail.is_archived),
    archivedAt: archivedAt ? toDate(archivedAt) : null,
    isReported: Boolean(detail.isReported ?? detail.is_reported),
    reportedAt: reportedAt ? toDate(reportedAt) : null,
    activeRunId: detail.activeRunId ?? null,
    isStreaming: Boolean(detail.isStreaming ?? detail.activeRunId),
    created_at: toDate(detail.created_at),
    updated_at: toDate(detail.updated_at),
    messages: (detail.messages || []).map(transformMessage),
  };
};
