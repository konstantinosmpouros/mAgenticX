import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

import type {
  Agent,
  AgentPublic,
  ConversationDetail,
  ConversationSummary,
  MessageOut,
} from "./types";

/**
 * Convert a backend-provided Lucide icon name into the actual icon component.
 * Falls back to `Building2` when the icon name is missing or invalid.
 */
export const mapIcon = (name: string | null | undefined): LucideIcon => {
  if (!name) {
    return Icons.Building2;
  }
  const Icon = (Icons as unknown as Record<string, LucideIcon | undefined>)[name];
  return Icon ?? Icons.Building2;
};


// Convenience wrapper ensuring every fetch includes credentials.
export const withCredentials = (init: RequestInit = {}): RequestInit => ({
  ...init,
  credentials: "include",
});


// Dispatch a global unauthorized event so listeners can react (e.g. force logout).
export const emitUnauthorized = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("mx:unauthorized"));
};


const toDate = (value: any): Date => (value ? new Date(value) : new Date());


// Transform functions to map backend data to frontend types
export const transformAgent = (
  agent: AgentPublic | Record<string, any> | undefined,
  fallback?: Partial<AgentPublic>,
): Agent => {
  const resolvedIcon =
    typeof (agent as any)?.icon === "string"
      ? (agent as any).icon
      : typeof (agent as any)?.iconName === "string"
        ? (agent as any).iconName
        : typeof fallback?.icon === "string"
          ? fallback.icon
          : typeof (fallback as any)?.iconName === "string"
            ? (fallback as any).iconName
            : null;
  const resolvedIsActive =
    typeof (agent as any)?.isActive === "boolean"
      ? (agent as any).isActive
      : typeof (agent as any)?.is_active === "boolean"
        ? (agent as any).is_active
        : typeof fallback?.isActive === "boolean"
          ? fallback.isActive
          : typeof (fallback as any)?.is_active === "boolean"
            ? (fallback as any).is_active
            : true;

  return {
    id: agent?.id ?? fallback?.id ?? "",
    name: agent?.name ?? fallback?.name ?? "Unknown Agent",
    description: agent?.description ?? fallback?.description ?? "",
    icon: mapIcon(resolvedIcon),
    iconName: resolvedIcon,
    version: agent?.version ?? fallback?.version,
    isActive: resolvedIsActive,
  };
};


// Transform attachment object from backend to frontend type
export const transformAttachment = (attachment: Record<string, any>) => ({
  id: attachment?.id,
  name: attachment?.name ?? attachment?.file_name ?? "",
  mime: attachment?.mime ?? attachment?.mime_type ?? "",
  size: attachment?.size ?? attachment?.size_bytes ?? undefined,
  timestamp: toDate(attachment?.timestamp ?? attachment?.created_at),
  blobId: attachment?.blobId ?? attachment?.blob_id ?? undefined,
  data: attachment?.data ?? undefined,
});


// Transform message object from backend to frontend type
export const transformMessage = (message: Record<string, any>): MessageOut => ({
  id: message.id,
  parentMessageId: message.parentMessageId ?? message.parent_message_id ?? undefined,
  content: message.content ?? "",
  sender: message.sender,
  type: message.type,
  liked: message.liked ?? undefined,
  created_at: toDate(message.created_at),
  updated_at: toDate(message.updated_at),
  attachments: (message.attachments || []).map(transformAttachment),
  thinking: message.thinking ?? undefined,
  thinkingTime: message.thinkingTime ?? undefined,
  error: message.error ?? undefined,
  errorMessage: message.errorMessage ?? undefined,
  rawEvents: message.rawEvents ?? message.raw_events ?? [],
  plan: message.plan ?? undefined,
  subagents: message.subagents ?? undefined,
});


// Transform conversation summary object from backend to frontend type
export const transformConversationSummary = (
  summary: Record<string, any>,
): ConversationSummary => {
  const archivedAt = summary.archivedAt ?? summary.archived_at;
  const reportedAt = summary.reportedAt ?? summary.reported_at;
  return {
    id: summary.id,
    agent: transformAgent(summary.agent, {
      id: summary.agent?.id ?? summary.agentId ?? summary.agent_id,
      name: summary.agent?.name ?? summary.agentName ?? summary.agent_name,
      isActive: summary.agent?.isActive ?? summary.agent?.is_active ?? summary.isActive ?? summary.is_active,
    }),
    forkedParentId: summary.forkedParentId ?? summary.forked_parent_id ?? null,
    forkedMessageId: summary.forkedMessageId ?? summary.forked_message_id ?? null,
    title: summary.title ?? undefined,
    isPrivate: Boolean(summary.isPrivate),
    isArchived: Boolean(summary.isArchived ?? summary.is_archived),
    archivedAt: archivedAt ? toDate(archivedAt) : null,
    isReported: Boolean(summary.isReported ?? summary.is_reported),
    reportedAt: reportedAt ? toDate(reportedAt) : null,
    lastMessage: summary.lastMessage ?? undefined,
    created_at: summary.created_at ?? "",
    updated_at: summary.updated_at ?? "",
  };
};


// Transform conversation detail object from backend to frontend type
export const transformConversationDetail = (
  detail: Record<string, any>,
): ConversationDetail => {
  const archivedAt = detail.archivedAt ?? detail.archived_at;
  const reportedAt = detail.reportedAt ?? detail.reported_at;
  return {
    id: detail.id,
    agent: transformAgent(detail.agent, {
      id: detail.agent?.id ?? detail.agentId ?? detail.agent_id,
      name: detail.agent?.name ?? detail.agentName ?? detail.agent_name,
      isActive: detail.agent?.isActive ?? detail.agent?.is_active ?? detail.isActive ?? detail.is_active,
    }),
    forkedParentId: detail.forkedParentId ?? detail.forked_parent_id ?? null,
    forkedMessageId: detail.forkedMessageId ?? detail.forked_message_id ?? null,
    title: detail.title ?? "",
    isPrivate: Boolean(detail.isPrivate),
    isArchived: Boolean(detail.isArchived ?? detail.is_archived),
    archivedAt: archivedAt ? toDate(archivedAt) : null,
    isReported: Boolean(detail.isReported ?? detail.is_reported),
    reportedAt: reportedAt ? toDate(reportedAt) : null,
    created_at: toDate(detail.created_at),
    updated_at: toDate(detail.updated_at),
    messages: (detail.messages || []).map(transformMessage),
  };
};
