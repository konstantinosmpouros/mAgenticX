import type {
  Agent,
  AuthRequest,
  AuthResponse,
  ConversationDetail,
  ConversationSummary,
  MessageOut,
  ConversationIn,
  ConversationReportPayload,
  ConversationShareListItem,
  ConversationShareResponse,
  ConversationShareMode,
  CreateConversationResponse,
  MessageIn,
  MessageUpdate,
  RealtimeVoiceConversationEventRequest,
  RealtimeVoiceSessionRequest,
  RealtimeVoiceSessionResponse,
  SharedConversationDetail,
  UpdateConversationResponse,
  DocxPreviewTokenResponse,
  DownloadAttachmentParams,
  InferenceRun,
  InferenceRunEvent,
  InferenceStartRequest,
  InferenceStartResponse,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
  Skill,
  UserSkill,
  UserSkillDetail,
  CustomSkillCreatePayload,
  MemorySummary,
  MemoryDetail,
  ToolMetadata,
  WorkspaceSearchResult,
} from "./types";
import { PROXY_LIMIT_MB } from "./uploadGuards";
import { requestJson, requestVoid, requestBlob, requestRaw } from "./http";
import { ensureFreshSession } from "./sessionRefresh";
import {
  DocxPreviewTokenSchema,
  MemoryDetailSchema,
  MemorySummaryListSchema,
  RealtimeVoiceSessionResponseSchema,
  SkillListSchema,
  StringListSchema,
  SuggestionsSchema,
  ToolMetadataListSchema,
  UserSkillListSchema,
  UserSkillSchema,
  UserSkillDetailSchema,
  AgentToolsResponseSchema,
  UsageSummarySchema,
  WireObjectArraySchema,
  WireObjectSchema,
  WorkspaceSearchResultListSchema,
} from "./schemas";
import {
  normalizeAuthResponse,
  normalizeCustomInstructions,
  normalizePersonality,
  normalizeRealtimeVoice,
  normalizeVoiceModeLanguage,
} from "./utils";
import {
  mapIcon,
  emitUnauthorized,
  transformConversationDetail,
  transformConversationSummary,
  transformSharedConversationDetail,
  transformMessage,
  transformInferenceRun,
  transformScheduledTask,
  type RealtimeVoice,
} from "./consts";


const API_BASE_PATH = "/api/v1";
const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;
const CATALOG_BASE_PATH = `${API_BASE_PATH}/catalog`;
const AGENTS_BASE_PATH = `${API_BASE_PATH}/agents`;
const PREFERENCES_BASE_PATH = `${API_BASE_PATH}/preferences`;
const CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/conversations`;
const MESSAGES_BASE_PATH = `${API_BASE_PATH}/messages`;
const ATTACHMENTS_BASE_PATH = `${API_BASE_PATH}/attachments`;
const INFERENCE_BASE_PATH = `${API_BASE_PATH}/inference`;
const SPEECH_BASE_PATH = `${API_BASE_PATH}/speech`;
const VOICE_BASE_PATH = `${API_BASE_PATH}/voice`;
const SHARED_CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/shared-conversations`;
const SEARCH_BASE_PATH = `${API_BASE_PATH}/search`;
const SKILLS_BASE_PATH = `${API_BASE_PATH}/skills`;
const MEMORIES_BASE_PATH = `${API_BASE_PATH}/memories`;
const SCHEDULED_TASKS_BASE_PATH = `${API_BASE_PATH}/scheduled-tasks`;
const USAGE_BASE_PATH = `${API_BASE_PATH}/usage`;


// Authenticate user credentials. A failed login is a credential error, not a
// session expiry, so it must NOT emit the global unauthorized event; the
// Retry-After header is captured so the form can show a rate-limit countdown.
export async function authenticate(credentials: AuthRequest): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/login`, {
    method: "POST",
    body: credentials,
    emitOn401: false,
    // A 401 here is bad credentials, not an expired session — never refresh-retry.
    skipAuthRetry: true,
    captureRetryAfter: true,
    fallbackMessage: "Failed to authenticate",
  });
  return normalizeAuthResponse(data);
}


// Get current session info (used for session restoration and auth checks). A 401
// here is an expected "not signed in" answer, not an event-worthy expiry.
export async function getSessionMe(): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/session`, {
    emitOn401: false,
    // restoreSession() owns the 401→refresh fallback here; don't double-refresh.
    skipAuthRetry: true,
    fallbackMessage: "Failed to fetch current session",
  });
  return normalizeAuthResponse(data);
}


// Attempt to restore user session, first by checking current session, then by trying to refresh if unauthorized
export async function restoreSession(): Promise<AuthResponse | null> {
  try {
    return await getSessionMe();
  } catch (error) {
    if ((error as { status?: number })?.status !== 401) {
      throw error;
    }
  }

  try {
    return await refreshSession(false);
  } catch {
    return null;
  }
}


// Refresh user session
export async function refreshSession(emitOnUnauthorized: boolean = true): Promise<AuthResponse> {
  const data = await requestJson(`${AUTH_BASE_PATH}/session/refresh`, {
    method: "POST",
    csrf: true,
    emitOn401: emitOnUnauthorized,
    // This IS the refresh — a 401 means the refresh token is dead; never recurse.
    skipAuthRetry: true,
    fallbackMessage: "Failed to refresh session",
  });
  return normalizeAuthResponse(data);
}


// Logout user session. A 401 means the session was already gone — treat it as a
// successful logout rather than an error, and do not emit an unauthorized event.
export async function logoutSession(): Promise<void> {
  await requestVoid(`${AUTH_BASE_PATH}/logout`, {
    method: "POST",
    csrf: true,
    ignoreStatuses: [401],
    fallbackMessage: "Failed to logout",
  });
}

// Public config: whether Microsoft (Entra) SSO is available, so the login page
// only shows the button when the backend is actually configured for it. A 401
// is not meaningful here and never triggers a refresh.
export async function getAuthConfig(): Promise<{ oidcEnabled: boolean }> {
  const data = await requestJson(`${AUTH_BASE_PATH}/config`, {
    emitOn401: false,
    skipAuthRetry: true,
    fallbackMessage: "Failed to fetch auth config",
  });
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return { oidcEnabled: record.oidcEnabled === true };
}

// Enter the Entra auth-code flow. This is a full-page navigation, NOT a fetch:
// the browser must follow the 302 to Microsoft and back through the callback,
// which sets the session cookies before redirecting into the app.
export function beginEntraLogin(): void {
  window.location.href = `${AUTH_BASE_PATH}/oidc/login`;
}


// Fetch agents from backend via nginx proxy. The wire shape is validated as an
// array of objects; each row is coerced into the app `Agent` (icon name → the
// Lucide component, snake/camel `is_active` reconciled).
export async function getAgents(): Promise<Agent[]> {
  const data = await requestJson(`${CATALOG_BASE_PATH}/agents`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch agents",
  });
  return data.map((a) => ({
    id: String(a.id ?? ""),
    name: typeof a.name === "string" ? a.name : "Unknown Agent",
    description: typeof a.description === "string" ? a.description : "",
    icon: mapIcon(typeof a.icon === "string" ? a.icon : null),
    version: typeof a.version === "string" ? a.version : undefined,
    type: typeof a.type === "string" ? a.type : undefined,
    isActive: Boolean(a.isActive ?? a.is_active ?? true),
  }));
}


// Fetch the central skills registry. Used by the bootstrap path
// (auth handlers + auth rehydrate hook) the same way as ``getAgents`` and
// ``getTools`` — fetched on every page refresh, with an IndexedDB snapshot
// for instant paint while the request is in flight. Pass ``{ bypassRedis:
// true }`` to force the bridge to skip its Redis cache and re-fetch from the
// agents service — that path also upserts the cache so the next normal
// request benefits from the new data. Only the manual refresh button uses
// the bypass; everything else (login, page refresh) leaves it false so the
// cache absorbs the load.
export async function getSkills(options?: { bypassRedis?: boolean }): Promise<Skill[]> {
  const url = options?.bypassRedis ? `${SKILLS_BASE_PATH}?bypass_redis=true` : SKILLS_BASE_PATH;
  return requestJson(url, {
    schema: SkillListSchema,
    fallbackMessage: "Failed to fetch skills",
  });
}


// Fetch enabled skills for a (user, agent) pair.
// Returns a plain string[] of skill names. The bridge reads through a Redis
// cache; mutations invalidate the cache and the next GET re-fetches from the
// agents service (which is authoritative — the on-disk directory IS the state).
export async function getUserAgentSkills(userId: string, agentId: string): Promise<string[]> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`;
  return requestJson(url, {
    schema: StringListSchema,
    fallbackMessage: "Failed to fetch user-agent skills",
  });
}


// Enable a skill for the (user, agent) pair. 204 on success.
export async function enableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "PUT",
    csrf: true,
    fallbackMessage: `Failed to enable skill ${skillName}`,
  });
}


// Disable a skill for the (user, agent) pair. 204 on success (idempotent).
export async function disableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to disable skill ${skillName}`,
  });
}


// ---------------------------------------------------------------------------
// Per-agent tools (Agents tab). List the tools an agent may use with their
// per-(user, agent) disabled flags, and toggle one. Proxied to the agents
// service by the bridge; the toggle is CSRF-protected + returns refreshed rows.
// ---------------------------------------------------------------------------
export async function getAgentTools(userId: string, agentId: string) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools`;
  return requestJson(url, {
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to fetch agent tools",
  });
}


export async function toggleAgentTool(
  userId: string,
  agentId: string,
  toolKey: string,
  disabled: boolean,
) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools/toggle`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: { toolKey, disabled },
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to update tool",
  });
}


// List the memories this agent has saved about the user (metadata only).
export async function listAgentMemories(userId: string, agentId: string): Promise<MemorySummary[]> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`;
  return requestJson(url, {
    schema: MemorySummaryListSchema,
    fallbackMessage: "Failed to fetch agent memories",
  });
}


// Fetch one saved memory with its full content (click-to-preview).
export async function getAgentMemory(
  userId: string,
  agentId: string,
  name: string,
): Promise<MemoryDetail> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`;
  return requestJson(url, {
    schema: MemoryDetailSchema,
    fallbackMessage: `Failed to fetch memory ${name}`,
  });
}


// Delete one of the agent's saved memories. 204 on success (idempotent).
export async function deleteAgentMemory(
  userId: string,
  agentId: string,
  name: string,
): Promise<void> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to delete memory ${name}`,
  });
}


// ---------------------------------------------------------------------------
// Per-user skill pool (the user's personal registry of globals + customs)
// ---------------------------------------------------------------------------

// Fetch the user's pool manifest entries (no SKILL.md content). Read-through
// cached on the bridge with a 5min TTL. ``bypassRedis: true`` forces an
// upstream fetch and upserts the cache.
export async function getMySkills(
  userId: string,
  options?: { bypassRedis?: boolean },
): Promise<UserSkill[]> {
  const base = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}`;
  const url = options?.bypassRedis ? `${base}?bypass_redis=true` : base;
  return requestJson(url, {
    schema: UserSkillListSchema,
    fallbackMessage: "Failed to fetch my skills",
  });
}


// Fetch a single user-pool skill with its SKILL.md body. Used when the user
// expands a card in the My skills view.
export async function getMySkillDetail(
  userId: string,
  skillName: string,
): Promise<UserSkillDetail> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  return requestJson(url, {
    schema: UserSkillDetailSchema,
    fallbackMessage: `Failed to fetch skill detail ${skillName}`,
  });
}


// Append a global-catalog skill into the user's pool. 204 on success. 404 if
// the skill isn't in the global catalog; 409 if it's already in the pool.
export async function addGlobalSkillToPool(
  userId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/global/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "POST",
    csrf: true,
    fallbackMessage: `Failed to add global skill ${skillName} to pool`,
  });
}


// Create a user-owned custom skill in the pool. 201 with the new manifest
// entry on success; 409 on name collision with global or own pool.
export async function createCustomSkill(
  userId: string,
  payload: CustomSkillCreatePayload,
): Promise<UserSkill> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/custom`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: UserSkillSchema,
    errorMessages: {
      413: `This skill is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). Use smaller files.`,
    },
    fallbackMessage: "Failed to create custom skill",
  });
}


// Remove a skill from the user's pool. Cascades on the agents service —
// also removes the skill from every per-(user, agent) assignment folder.
export async function removeSkillFromPool(
  userId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to remove skill ${skillName} from pool`,
  });
}


// Fetch available tools from backend
export async function getTools(): Promise<ToolMetadata[]> {
  return requestJson(`${CATALOG_BASE_PATH}/tools`, {
    schema: ToolMetadataListSchema,
    fallbackMessage: "Failed to fetch tools",
  });
}


// Search the signed-in user's active workspace data.
export async function searchWorkspace(
  userId: string,
  query: string,
  limit: number = 20,
): Promise<WorkspaceSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  return requestJson(`${SEARCH_BASE_PATH}/${encodeURIComponent(userId)}?${params.toString()}`, {
    schema: WorkspaceSearchResultListSchema,
    fallbackMessage: "Failed to search workspace",
  });
}


// Map the raw preferences payload (mixed camelCase) into the app shape, applying
// the same per-field defaults on both read and write so the two paths cannot
// drift. Tool disable-list entries are passed through verbatim.
function mapUserPreferences(data: unknown) {
  const record = (data ?? {}) as Record<string, unknown>;
  const prefersAgenticChat =
    typeof record.prefersAgenticChat === "boolean" ? record.prefersAgenticChat : false;
  const suggestionsEnabled =
    typeof record.suggestionsEnabled === "boolean" ? record.suggestionsEnabled : true;
  const showMessageTokenUsage =
    typeof record.showMessageTokenUsage === "boolean" ? record.showMessageTokenUsage : false;
  const searchPastConvs =
    typeof record.searchPastConvs === "boolean" ? record.searchPastConvs : false;
  const useMemory = typeof record.useMemory === "boolean" ? record.useMemory : true;
  const personality = normalizePersonality(record.personality);
  const customInstructions = normalizeCustomInstructions(record.customInstructions);
  const voiceModeVoice = normalizeRealtimeVoice(record.voiceModeVoice);
  const voiceModeLanguage = normalizeVoiceModeLanguage(record.voiceModeLanguage);

  return {
    prefersAgenticChat,
    suggestionsEnabled,
    showMessageTokenUsage,
    searchPastConvs,
    useMemory,
    personality,
    customInstructions,
    voiceModeVoice,
    voiceModeLanguage,
  };
}


// Fetch the workspace-wide usage rollup for the Settings → Usage tab.
export async function getUsageSummary(userId: string) {
  return requestJson(`${USAGE_BASE_PATH}/${encodeURIComponent(userId)}/summary`, {
    schema: UsageSummarySchema,
    fallbackMessage: "Failed to fetch usage summary",
  });
}


// Fetch user preferences
export async function getUserPreferences(userId: string) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    fallbackMessage: "Failed to fetch user preferences",
  });
  return mapUserPreferences(data);
}


// Update user preferences
export async function updateUserPreferences(userId: string, prefs: unknown) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    method: "PUT",
    csrf: true,
    body: prefs,
    fallbackMessage: "Failed to update user preferences",
  });
  return mapUserPreferences(data);
}


// Fetch personalized starter suggestions for a new chat.
export async function getSuggestions(userId: string, agentId?: string | null): Promise<string[]> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  return requestJson(`${CATALOG_BASE_PATH}/${userId}/suggestions${query}`, {
    schema: SuggestionsSchema,
    fallbackMessage: "Failed to fetch suggestions",
  });
}


// Fetch conversations for a user. The bridge returns either a bare array or a
// Page shape ({ items, total, page, size }); both are accepted.
export async function getConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}?page=${page}&size=${size}`, {
    fallbackMessage: "Failed to fetch conversations",
  });
  const items = Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
  return (items as Record<string, unknown>[]).map(transformConversationSummary);
}


// Fetch archived conversations for a user
export async function getArchivedConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/archived?page=${page}&size=${size}`, {
    fallbackMessage: "Failed to fetch archived conversations",
  });
  const items = Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
  return (items as Record<string, unknown>[]).map(transformConversationSummary);
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
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/unarchive`, {
    method: "PATCH",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to unarchive conversation",
  });
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


// Create a new conversation with the first message
export async function createConversation(
  userId: string,
  payload: ConversationIn,
): Promise<CreateConversationResponse> {
  const data = (await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    errorMessages: {
      413:
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`,
    },
    fallbackMessage: "Failed to create conversation",
  })) as Record<string, unknown>;

  return {
    detail: transformConversationDetail(data.detail as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
  };
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
    revokedAt: data.revokedAt ?? data.revoked_at ? new Date(data.revokedAt ?? data.revoked_at) : null,
    expiresAt: data.expiresAt ?? data.expires_at ? new Date(data.expiresAt ?? data.expires_at) : null,
    createdAt: new Date(data.createdAt ?? data.created_at),
  };
}

const getFilenameFromDisposition = (disposition: string | null, fallback: string) => {
  if (!disposition) return fallback;
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].replace(/"/g, ""));
    } catch {
      return utfMatch[1].replace(/"/g, "");
    }
  }
  const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
  return asciiMatch?.[1] || fallback;
};


// Download a transient PDF export for a conversation share scope.
export async function downloadConversationPdfExport(
  userId: string,
  conversationId: string,
  messageId: string,
  mode: ConversationShareMode = "full",
  branchPath?: string[],
): Promise<void> {
  const res = await requestRaw(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share/export-pdf`, {
    method: "POST",
    csrf: true,
    accept: "application/pdf",
    body: {
      messageId,
      mode,
      ...(branchPath?.length ? { branchPath } : {}),
    },
    fallbackMessage: "Failed to export PDF",
  });

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = getFilenameFromDisposition(res.headers.get("Content-Disposition"), "conversation.pdf");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}


export async function getSharedConversationLinks(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationShareListItem[]> {
  const data = await requestJson(`${CONVERSATIONS_BASE_PATH}/${userId}/shares?page=${page}&size=${size}`, {
    fallbackMessage: "Failed to fetch shared conversations",
  });
  if (!Array.isArray(data)) return [];
  return data.map((item: any) => ({
    id: item.id,
    token: item.token,
    shareUrl: item.shareUrl ?? item.share_url ?? `/share/${item.token}`,
    conversationId: item.conversationId ?? item.conversation_id,
    messageId: item.messageId ?? item.message_id ?? null,
    shareMode: item.shareMode ?? item.share_mode ?? "branch",
    title: item.title ?? null,
    isActive: Boolean(item.isActive ?? item.is_active),
    status: item.status ?? "active",
    revokedAt: item.revokedAt ?? item.revoked_at ? new Date(item.revokedAt ?? item.revoked_at) : null,
    expiresAt: item.expiresAt ?? item.expires_at ? new Date(item.expiresAt ?? item.expires_at) : null,
    createdAt: new Date(item.createdAt ?? item.created_at),
  }));
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
  const data = (await requestJson(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}`, {
    method: "PATCH",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update message",
  })) as Record<string, unknown>;

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
  const data = await requestJson(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/like`, {
    method: "POST",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to like message",
  });
  return transformMessage(data);
}


// Dislike a message
export async function dislikeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const data = await requestJson(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/dislike`, {
    method: "POST",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to dislike message",
  });
  return transformMessage(data);
}


// Generate read-aloud audio for an AI message
export async function generateMessageReadAloudAudio(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<Blob> {
  return requestBlob(`${SPEECH_BASE_PATH}/read-aloud/${userId}/${conversationId}/${messageId}`, {
    method: "POST",
    csrf: true,
    accept: "audio/mpeg,audio/*",
    fallbackMessage: "Failed to generate read-aloud audio",
  });
}


// Generate a short read-aloud preview for a selected voice
export async function generateReadAloudPreviewAudio(
  userId: string,
  voice: RealtimeVoice,
  text = "Hey! I am your AI speaker.",
): Promise<Blob> {
  return requestBlob(`${SPEECH_BASE_PATH}/read-aloud-preview/${userId}`, {
    method: "POST",
    csrf: true,
    accept: "audio/mpeg,audio/*",
    body: { voice: normalizeRealtimeVoice(voice), text },
    fallbackMessage: "Failed to generate read-aloud preview",
  });
}


// Download an attachment blob
export async function downloadAttachment({
  userId,
  conversationId,
  messageId,
  blobId,
  filename,
}: DownloadAttachmentParams): Promise<void> {
  const blob = await fetchAttachmentBlob({
    userId,
    conversationId,
    messageId,
    blobId,
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  if (filename) {
    anchor.download = filename;
  }
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}


// Fetch for preview an attachment blob from the backend
export async function fetchAttachmentBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  const url = `${ATTACHMENTS_BASE_PATH}/download/${userId}/${conversationId}/${messageId}/${blobId}`;
  return requestBlob(url, {
    accept: null,
    fallbackMessage: "Failed to download attachment",
  });
}


export function getAttachmentPreviewUrl({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): string {
  const segments = [userId, conversationId, messageId, blobId].map((value) => encodeURIComponent(value));
  return `${ATTACHMENTS_BASE_PATH}/preview/${segments.join("/")}`;
}


// Fetch a blob through the inline preview endpoint for in-browser renderers.
export async function fetchAttachmentPreviewBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  return requestBlob(getAttachmentPreviewUrl({ userId, conversationId, messageId, blobId }), {
    accept: null,
    fallbackMessage: "Failed to preview attachment",
  });
}


export async function fetchDocxPreviewToken({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<DocxPreviewTokenResponse> {
  const segments = [userId, conversationId, messageId, blobId].map(encodeURIComponent);
  return requestJson(`${ATTACHMENTS_BASE_PATH}/preview-token/${segments.join("/")}`, {
    schema: DocxPreviewTokenSchema,
    fallbackMessage: "Failed to obtain preview token",
  });
}


// Transcribe an audio dictation blob via the backend
export async function transcribeDictation(
  userId: string,
  audio: Blob,
  filename?: string,
): Promise<string> {
  const formData = new FormData();
  const safeName = filename || "dictation.webm";
  formData.append("audio", audio, safeName);

  const data = await requestJson(`${SPEECH_BASE_PATH}/dictation/${userId}`, {
    method: "POST",
    csrf: true,
    body: formData,
    fallbackMessage: "Failed to transcribe dictation",
  });

  if (!data || typeof (data as { text?: unknown }).text !== "string") {
    throw new Error("Invalid dictation response.");
  }

  return (data as { text: string }).text;
}

export async function createRealtimeVoiceSession(
  userId: string,
  payload: RealtimeVoiceSessionRequest,
): Promise<RealtimeVoiceSessionResponse> {
  return requestJson(`${VOICE_BASE_PATH}/realtime/${userId}/session`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: RealtimeVoiceSessionResponseSchema,
    fallbackMessage: "Failed to create realtime voice session",
  });
}

export async function persistRealtimeVoiceConversationEvent(
  userId: string,
  payload: RealtimeVoiceConversationEventRequest,
): Promise<UpdateConversationResponse> {
  const data = (await requestJson(`${VOICE_BASE_PATH}/realtime/${userId}/conversation-event`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to persist realtime voice transcript",
  })) as Record<string, unknown>;

  return {
    message: transformMessage(data.message as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
  };
}

export async function endRealtimeVoiceSession(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const data = (await requestJson(`${VOICE_BASE_PATH}/realtime/${userId}/end`, {
    method: "POST",
    csrf: true,
    body: { conversationId },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to end realtime voice session",
  })) as Record<string, unknown>;
  return transformConversationSummary(data.summary as Record<string, unknown>);
}


const transformInferenceRunEvent = (event: Record<string, any>): InferenceRunEvent => ({
  type: event.type,
  run: transformInferenceRun(event.run ?? {}),
  message: event.message ? transformMessage(event.message) : null,
  summary: event.summary ? transformConversationSummary(event.summary) : null,
  // Raw AG-UI events of an "events" delta frame — consumed verbatim by the
  // timeline reducer, never field-mapped.
  events: Array.isArray(event.events) ? event.events : undefined,
});

export async function startInference(
  userId: string,
  payload: InferenceStartRequest,
): Promise<InferenceStartResponse> {
  const body: Record<string, unknown> = {
    mode: payload.mode,
  };
  if (payload.agentId) body.agentId = payload.agentId;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (payload.title) body.title = payload.title;
  if (payload.sharedConversationToken) body.sharedConversationToken = payload.sharedConversationToken;
  if (payload.conversationId) body.conversationId = payload.conversationId;
  if (payload.parentMessageId) body.parentMessageId = payload.parentMessageId;
  if (payload.targetMessageId) body.targetMessageId = payload.targetMessageId;
  if (payload.messagePath?.length) body.messagePath = payload.messagePath;
  if (payload.message) body.message = payload.message;

  const data = (await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/start`, {
    method: "POST",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to start inference",
  })) as Record<string, unknown>;

  return {
    detail: transformConversationDetail(data.detail as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
    run: transformInferenceRun(data.run as Record<string, unknown>),
    message: transformMessage(data.message as Record<string, unknown>),
  };
}

export async function getActiveInferenceRuns(userId: string): Promise<InferenceRun[]> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}?status=active`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch active inference runs",
  });
  return data.map(transformInferenceRun);
}

export async function cancelInferenceRun(userId: string, runId: string): Promise<InferenceRun> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/cancel`, {
    method: "POST",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to cancel inference run",
  });
  return transformInferenceRun(data);
}


// ----------------------------------------------------------------------------
// Scheduled tasks
// ----------------------------------------------------------------------------
export async function listScheduledTasks(userId: string): Promise<ScheduledTask[]> {
  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch scheduled tasks",
  });
  return data.map(transformScheduledTask);
}

export async function createScheduledTask(
  userId: string,
  payload: ScheduledTaskCreatePayload,
): Promise<ScheduledTask> {
  const body: Record<string, unknown> = {
    agentId: payload.agentId,
    prompt: payload.prompt,
    targetMode: payload.targetMode,
    scheduleKind: payload.scheduleKind,
  };
  if (payload.title) body.title = payload.title;
  if (payload.runAt) body.runAt = payload.runAt;
  if (typeof payload.intervalSeconds === "number") body.intervalSeconds = payload.intervalSeconds;
  if (payload.cronExpr) body.cronExpr = payload.cronExpr;
  if (payload.timezone) body.timezone = payload.timezone;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (typeof payload.maxRuns === "number") body.maxRuns = payload.maxRuns;
  if (payload.expiresAt) body.expiresAt = payload.expiresAt;

  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}`, {
    method: "POST",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to create scheduled task",
  });
  return transformScheduledTask(data);
}

export async function updateScheduledTask(
  userId: string,
  taskId: string,
  payload: ScheduledTaskUpdatePayload,
): Promise<ScheduledTask> {
  const body: Record<string, unknown> = {};
  if (typeof payload.title === "string") body.title = payload.title;
  if (typeof payload.prompt === "string") body.prompt = payload.prompt;
  if (payload.status) body.status = payload.status;
  if (payload.agentId) body.agentId = payload.agentId;
  if (payload.targetMode) body.targetMode = payload.targetMode;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (typeof payload.maxRuns === "number") body.maxRuns = payload.maxRuns;
  if (payload.expiresAt) body.expiresAt = payload.expiresAt;
  if (payload.scheduleKind) body.scheduleKind = payload.scheduleKind;
  if (payload.runAt) body.runAt = payload.runAt;
  if (typeof payload.intervalSeconds === "number") body.intervalSeconds = payload.intervalSeconds;
  if (payload.cronExpr) body.cronExpr = payload.cronExpr;
  if (payload.timezone) body.timezone = payload.timezone;

  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}/${taskId}`, {
    method: "PATCH",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update scheduled task",
  });
  return transformScheduledTask(data);
}

export async function deleteScheduledTask(userId: string, taskId: string): Promise<void> {
  await requestVoid(`${SCHEDULED_TASKS_BASE_PATH}/${userId}/${taskId}`, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to delete scheduled task",
  });
}

export type ResumeActionDecision = {
  decision: "approve" | "reject";
  reason?: string;
};

export type ResumeInferenceRunBody = {
  // LangGraph interrupt id from the HITL_INTERRUPT event the user is acting
  // on. Lets the bridge/agents service verify the right interrupt is being
  // resolved when multiple HITLs fire in sequence on the same conversation.
  interruptId: string;
  threadId: string;
  decision: "approve" | "reject";
  reason?: string;
  value?: unknown;
  // Per-action decisions for a batched interrupt (one entry per action_request,
  // in order). When present, the backend applies them positionally instead of
  // replicating the single `decision`. The `decision` field stays as the
  // overall/legacy fallback.
  decisions?: ResumeActionDecision[];
};

export async function resumeInferenceRun(
  userId: string,
  runId: string,
  body: ResumeInferenceRunBody,
): Promise<InferenceRun> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/resume`, {
    method: "POST",
    csrf: true,
    body: {
      interruptId: body.interruptId,
      threadId: body.threadId,
      decision: body.decision,
      reason: body.reason ?? null,
      value: body.value ?? null,
      decisions: body.decisions ?? null,
    },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to resume inference run",
  });
  return transformInferenceRun(data);
}

// Reconnect backoff schedule for the inference WebSocket client. After this
// many consecutive failures (without any successful frame in between), the
// outer promise rejects and the caller surfaces a toast. Successful frames
// reset the counter — long-running streams that briefly disconnect should
// recover seamlessly.
const INFERENCE_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

// Tracks the last delivered Redis-stream entry ID per active run so reconnects
// can resume with ``since=lastSeenSeq``. Cleared when the terminal frame is
// received (or when an explicit abort completes the run).
const lastSeenInferenceSeq = new Map<string, string>();

class PermanentInferenceWebSocketError extends Error {
  readonly permanent = true;
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "PermanentInferenceWebSocketError";
    this.code = code;
  }
}

// The server closed the socket with 4401 (access token expired/invalid). Unlike a
// permanent error this is recoverable: the reconnect loop refreshes the session
// once and reconnects with the fresh cookie, matching the REST 401 behavior. Only
// if that refresh fails is the session genuinely over.
class AuthExpiredWebSocketError extends Error {
  readonly authExpired = true;
  constructor(message: string) {
    super(message);
    this.name = "AuthExpiredWebSocketError";
  }
}

function getInferenceWebSocketUrl(userId: string, runId: string): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const segments = [encodeURIComponent(userId), encodeURIComponent(runId)].join("/");
  return `${wsProtocol}//${window.location.host}${INFERENCE_BASE_PATH}/runs/${segments}/ws`;
}

function inferenceSleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function runOneInferenceWebSocketConnection(
  url: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finalize = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      action();
    };
    const onAbort = () => {
      try { socket.close(1000, "Aborted"); } catch { /* ignore */ }
      finalize(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    socket.onopen = () => {
      const since = lastSeenInferenceSeq.get(runId) ?? null;
      try {
        socket.send(JSON.stringify({ type: "subscribe", since }));
      } catch {
        // Server-side close handler will trigger the reconnect path.
      }
    };

    socket.onmessage = (msg) => {
      onProgress();
      let frame: any;
      try {
        frame = JSON.parse(typeof msg.data === "string" ? msg.data : "");
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "event" && frame.payload) {
        try {
          onEvent(transformInferenceRunEvent(frame.payload));
        } catch {
          // ignore malformed event payload
        }
        if (typeof frame.seq === "string" && frame.seq) {
          lastSeenInferenceSeq.set(runId, frame.seq);
        }
        return;
      }
      if (frame.type === "snapshot" && frame.payload) {
        try {
          onEvent(transformInferenceRunEvent(frame.payload));
        } catch {
          // ignore malformed snapshot payload
        }
        return;
      }
      if (frame.type === "terminal") {
        // The payload is the DB-built final state — apply it so the run
        // flips to its real status even when the terminal stream entry was
        // lost on this socket (send raced the close, reconnect gap).
        if (frame.payload) {
          try {
            onEvent(transformInferenceRunEvent(frame.payload));
          } catch {
            // ignore malformed terminal payload
          }
        }
        finalize(() => {
          try { socket.close(1000, "Done"); } catch { /* ignore */ }
          lastSeenInferenceSeq.delete(runId);
          resolve();
        });
      }
    };

    socket.onerror = () => {
      // The close handler runs immediately after and surfaces the rejection.
    };

    socket.onclose = (event) => {
      if (event.code === 4401) {
        // Recoverable — the reconnect loop refreshes once and retries. Do NOT
        // emit unauthorized here; that only happens if the refresh itself fails.
        finalize(() => reject(new AuthExpiredWebSocketError(
          event.reason || "Authentication required",
        )));
        return;
      }
      if (event.code === 4403 || event.code === 4404) {
        finalize(() => reject(new PermanentInferenceWebSocketError(
          event.reason || `WebSocket closed with code ${event.code}`,
          event.code,
        )));
        return;
      }
      finalize(() => reject(new Error(`WebSocket closed (code ${event.code})`)));
    };
  });
}

export async function connectInferenceWebSocket(
  userId: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = getInferenceWebSocketUrl(userId, runId);
  let consecutiveFailures = 0;
  let authRefreshAttempted = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await runOneInferenceWebSocketConnection(url, runId, onEvent, signal, () => {
        consecutiveFailures = 0;
      });
      return;
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (err?.authExpired) {
        // Mirror the REST 401 flow: refresh the session once, then reconnect with
        // the fresh cookie. A second auth expiry (or a failed refresh) means the
        // session is really over — surface it as unauthorized and stop.
        if (!authRefreshAttempted) {
          authRefreshAttempted = true;
          const outcome = await ensureFreshSession({ force: true });
          if (outcome.status !== "failed") {
            continue;
          }
        }
        emitUnauthorized();
        throw new PermanentInferenceWebSocketError(err.message || "Authentication required", 4401);
      }
      if (err?.permanent) {
        throw err;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures > INFERENCE_RECONNECT_BACKOFF_MS.length) {
        throw new Error("Inference stream lost after repeated reconnect attempts.");
      }
      const delay = INFERENCE_RECONNECT_BACKOFF_MS[consecutiveFailures - 1];
      await inferenceSleepWithAbort(delay, signal);
    }
  }
}
