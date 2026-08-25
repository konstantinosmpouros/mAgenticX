import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

import type {
  Agent,
  AgentPublic,
  ConversationDetail,
  InferenceRun,
  ConversationSummary,
  MessageOut,
  ScheduledTask,
  SharedConversationDetail,
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
// Suppressed during an intentional logout: tear-down races with any in-flight
// authenticated requests, which 401 once the session is gone — those must not
// surface as a spurious "Session expired". A genuine idle expiry (no logout in
// progress) still emits normally. Also dedupes a burst of simultaneous 401s.
let unauthorizedSuppressed = false;

export const setUnauthorizedSuppressed = (suppressed: boolean): void => {
  unauthorizedSuppressed = suppressed;
};

export const emitUnauthorized = (): void => {
  if (unauthorizedSuppressed) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("mx:unauthorized"));
};

export const READ_ALOUD_VOICES = [
  { id: "alloy", label: "Alloy", description: "Balanced", gender: "male", genderSymbol: "♂" },
  { id: "ash", label: "Ash", description: "Clear", gender: "male", genderSymbol: "♂" },
  { id: "ballad", label: "Ballad", description: "Warm", gender: "male", genderSymbol: "♂" },
  { id: "cedar", label: "Cedar", description: "Rich", gender: "male", genderSymbol: "♂" },
  { id: "coral", label: "Coral", description: "Bright", gender: "female", genderSymbol: "♀" },
  { id: "echo", label: "Echo", description: "Deep", gender: "male", genderSymbol: "♂" },
  { id: "fable", label: "Fable", description: "Story-like", gender: "male", genderSymbol: "♂" },
  { id: "marin", label: "Marin", description: "Natural", gender: "female", genderSymbol: "♀" },
  { id: "nova", label: "Nova", description: "Energetic", gender: "female", genderSymbol: "♀" },
  { id: "onyx", label: "Onyx", description: "Grounded", gender: "male", genderSymbol: "♂" },
  { id: "sage", label: "Sage", description: "Calm", gender: "female", genderSymbol: "♀" },
  { id: "shimmer", label: "Shimmer", description: "Light", gender: "female", genderSymbol: "♀" },
  { id: "verse", label: "Verse", description: "Expressive", gender: "female", genderSymbol: "♀" },
] as const;

export type ReadAloudVoice = (typeof READ_ALOUD_VOICES)[number]["id"];

export const DEFAULT_READ_ALOUD_VOICE: ReadAloudVoice = "alloy";

export const REALTIME_VOICES = [
  { id: "alloy", label: "Alloy", description: "Balanced", gender: "male", genderSymbol: "♂" },
  { id: "ash", label: "Ash", description: "Clear", gender: "male", genderSymbol: "♂" },
  { id: "ballad", label: "Ballad", description: "Warm", gender: "male", genderSymbol: "♂" },
  { id: "cedar", label: "Cedar", description: "Rich", gender: "male", genderSymbol: "♂" },
  { id: "coral", label: "Coral", description: "Bright", gender: "female", genderSymbol: "♀" },
  { id: "echo", label: "Echo", description: "Deep", gender: "male", genderSymbol: "♂" },
  { id: "marin", label: "Marin", description: "Natural", gender: "female", genderSymbol: "♀" },
  { id: "sage", label: "Sage", description: "Calm", gender: "female", genderSymbol: "♀" },
  { id: "shimmer", label: "Shimmer", description: "Light", gender: "female", genderSymbol: "♀" },
  { id: "verse", label: "Verse", description: "Expressive", gender: "female", genderSymbol: "♀" },
] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number]["id"];

export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "alloy";

export const VOICE_MODE_LANGUAGES = [
  { id: "english", label: "English", native: "English" },
  { id: "greek", label: "Greek", native: "Ελληνικά" },
] as const;

export type VoiceModeLanguage = (typeof VOICE_MODE_LANGUAGES)[number]["id"];

export const DEFAULT_VOICE_MODE_LANGUAGE: VoiceModeLanguage = "english";

// Personality presets for agent responses (Settings → Personalization),
// mirroring ChatGPT's taxonomy. Ids must match the bridge registry
// (schemas.PERSONALITY_IDS) and the agents runtime/personalization.py —
// both fail closed to "default" on an unknown id, so drift degrades safely.
export const PERSONALITY_PRESETS = [
  { id: "default", label: "Default", description: "The agent's own voice" },
  { id: "professional", label: "Professional", description: "Polished and precise" },
  { id: "friendly", label: "Friendly", description: "Warm and chatty" },
  { id: "candid", label: "Candid", description: "Direct and honest" },
  { id: "quirky", label: "Quirky", description: "Playful and imaginative" },
  { id: "efficient", label: "Efficient", description: "Concise and plain" },
  { id: "cynical", label: "Cynical", description: "Critical and sarcastic" },
  { id: "nerdy", label: "Nerdy", description: "Exploratory and enthusiastic" },
] as const;

export type PersonalityId = (typeof PERSONALITY_PRESETS)[number]["id"];

export const DEFAULT_PERSONALITY: PersonalityId = "default";

// Custom-instructions field caps — mirror the bridge schema's max_length so
// the dialog enforces limits client-side (with counters) and never trips a 422.
export const CUSTOM_INSTRUCTIONS_LIMITS = {
  nickname: 100,
  occupation: 150,
  traits: 1500,
  about: 1500,
} as const;


// Profile panel — shared display + layout constants.
export const NA = "N/A";

// Skills tab catalog search: how many ranked results to show for a query, and
// how many to show as an alphabetical browse slice when there is no query.
export const CATALOG_RESULT_LIMIT = 10;
export const CATALOG_BROWSE_LIMIT = 6;

// Below this viewport width the profile sidebar collapses into the compact
// horizontal mobile nav.
export const MOBILE_PROFILE_NAV_BREAKPOINT = 640;

export const MCP_ICON_SRCS = {
  grey: "/mcp-server-stroke-rounded (3).png",
  darkGrey: "/mcp-server-stroke-rounded (4).png",
  white: "/mcp-server-Stroke-Rounded (2).png",
  magenta: "/mcp-server-Stroke-Rounded (1).png",
  black: "/mcp-server-Stroke-Rounded.png",
} as const;

export type McpIconVariant = keyof typeof MCP_ICON_SRCS;

export const MCP_VARIANTS = {
  idleLight: "grey" as const,
  idleDark: "darkGrey" as const,
  hoverLight: "black" as const,
  hoverDark: "white" as const,
  // White, not magenta: the settings-nav Lucide icons render white when their
  // item is selected, and the MCP PNG must match them.
  active: "white" as const,
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
    // Carried through because consumers filter on it (`type === "deep agent"`
    // gates the Tools/Skills/Memories per-agent lists); dropping it here made
    // agents from this path invisible to those filters.
    type: (agent as any)?.type ?? (fallback as any)?.type,
    isActive: resolvedIsActive,
  };
};


// Transform attachment object from backend to frontend type
const transformAttachment = (attachment: Record<string, any>) => ({
  id: attachment?.id,
  name: attachment?.name ?? attachment?.file_name ?? "",
  mime: attachment?.mime ?? attachment?.mime_type ?? "",
  size: attachment?.size ?? attachment?.size_bytes ?? undefined,
  timestamp: toDate(attachment?.timestamp ?? attachment?.created_at),
  blobId: attachment?.blobId ?? attachment?.blob_id ?? undefined,
  data: attachment?.data ?? undefined,
  // Provenance + agent-supplied metadata: without these a generated deliverable
  // reads as a plain upload, so it double-renders (top stack + inline card) and
  // the inline artifact card can never reconcile to its blob (stuck "Preparing").
  origin: attachment?.origin ?? "upload",
  title: attachment?.title ?? undefined,
  summary: attachment?.summary ?? undefined,
});


// Transform message object from backend to frontend type
export const transformMessage = (message: Record<string, any>): MessageOut => ({
  id: message.id,
  parentMessageId: message.parentMessageId ?? message.parent_message_id ?? undefined,
  content: message.content ?? "",
  sender: message.sender,
  liked: message.liked ?? undefined,
  agentId: message.agentId ?? message.agent_id ?? null,
  agentName: message.agentName ?? message.agent_name ?? null,
  created_at: toDate(message.created_at),
  updated_at: toDate(message.updated_at),
  attachments: (message.attachments || []).map(transformAttachment),
  thinking: message.thinking ?? undefined,
  thinkingTime: message.thinkingTime ?? undefined,
  inputTokens: message.inputTokens ?? message.input_tokens ?? undefined,
  outputTokens: message.outputTokens ?? message.output_tokens ?? undefined,
  error: message.error ?? undefined,
  errorMessage: message.errorMessage ?? undefined,
  streamingStatus: message.streamingStatus ?? message.streaming_status ?? null,
  rawEvents: message.rawEvents ?? message.raw_events ?? [],
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

export const transformInferenceRun = (run: Record<string, any>): InferenceRun => ({
  id: run.id,
  userId: run.userId ?? run.user_id ?? "",
  conversationId: run.conversationId ?? run.conversation_id ?? "",
  assistantMessageId: run.assistantMessageId ?? run.assistant_message_id ?? "",
  parentMessageId: run.parentMessageId ?? run.parent_message_id ?? null,
  status: run.status ?? "running",
  scheduledTaskId: run.scheduledTaskId ?? run.scheduled_task_id ?? null,
  messagePath: Array.isArray(run.messagePath ?? run.message_path) ? (run.messagePath ?? run.message_path) : [],
  content: run.content ?? null,
  thinking: Array.isArray(run.thinking) ? run.thinking : null,
  rawEvents: Array.isArray(run.rawEvents ?? run.raw_events) ? (run.rawEvents ?? run.raw_events) : [],
  inputTokens: run.inputTokens ?? run.input_tokens ?? null,
  outputTokens: run.outputTokens ?? run.output_tokens ?? null,
  pendingInterrupts: typeof run.pendingInterrupts === "number" ? run.pendingInterrupts : undefined,
  errorMessage: run.errorMessage ?? run.error_message ?? null,
  startedAt: toDate(run.startedAt ?? run.started_at),
  completedAt: run.completedAt ?? run.completed_at ? toDate(run.completedAt ?? run.completed_at) : null,
  cancelRequestedAt: run.cancelRequestedAt ?? run.cancel_requested_at ? toDate(run.cancelRequestedAt ?? run.cancel_requested_at) : null,
  updatedAt: toDate(run.updatedAt ?? run.updated_at),
});


// Transform public shared conversation snapshot.
export const transformSharedConversationDetail = (
  detail: Record<string, any>,
): SharedConversationDetail => ({
  token: detail.token ?? "",
  title: detail.title ?? null,
  shareMode: detail.shareMode ?? detail.share_mode ?? "branch",
  agent: transformAgent(detail.agent),
  messages: (detail.messages || []).map(transformMessage),
  expiresAt: detail.expiresAt ?? detail.expires_at ? toDate(detail.expiresAt ?? detail.expires_at) : null,
  createdAt: toDate(detail.createdAt ?? detail.created_at),
});


// Transform a scheduled task from backend to frontend type.
export const transformScheduledTask = (task: Record<string, any>): ScheduledTask => {
  const nextRunAt = task.nextRunAt ?? task.next_run_at;
  const lastRunAt = task.lastRunAt ?? task.last_run_at;
  const expiresAt = task.expiresAt ?? task.expires_at;
  const spec = task.scheduleSpec ?? task.schedule_spec;
  return {
    id: task.id,
    agentId: task.agentId ?? task.agent_id ?? null,
    agentName: task.agentName ?? task.agent_name ?? null,
    agentSlug: task.agentSlug ?? task.agent_slug ?? null,
    conversationId: task.conversationId ?? task.conversation_id ?? null,
    title: task.title ?? null,
    prompt: task.prompt ?? "",
    isPrivate: Boolean(task.isPrivate ?? task.is_private),
    targetMode: task.targetMode ?? task.target_mode ?? "fresh",
    scheduleKind: task.scheduleKind ?? task.schedule_kind ?? "interval",
    scheduleSpec: spec && typeof spec === "object" ? spec : {},
    timezone: task.timezone ?? null,
    status: task.status ?? "active",
    nextRunAt: nextRunAt ? toDate(nextRunAt) : null,
    lastRunAt: lastRunAt ? toDate(lastRunAt) : null,
    lastRunStatus: task.lastRunStatus ?? task.last_run_status ?? null,
    lastRunMessageId: task.lastRunMessageId ?? task.last_run_message_id ?? null,
    lastError: task.lastError ?? task.last_error ?? null,
    runCount: task.runCount ?? task.run_count ?? 0,
    maxRuns: task.maxRuns ?? task.max_runs ?? null,
    expiresAt: expiresAt ? toDate(expiresAt) : null,
    createdAt: toDate(task.createdAt ?? task.created_at),
    updatedAt: toDate(task.updatedAt ?? task.updated_at),
    liveStatus: task.liveStatus ?? task.live_status ?? null,
    lastRunConversationId: task.lastRunConversationId ?? task.last_run_conversation_id ?? null,
  };
};
