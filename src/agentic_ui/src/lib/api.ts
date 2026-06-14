import type {
  Agent,
  AgentPublic,
  AuthApiError,
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
  Skill,
  SkillFile,
  UserSkill,
  UserSkillDetail,
  CustomSkillCreatePayload,
  ToolMetadata,
  ToolPreference,
  WorkspaceSearchResult,
} from "./types";
import { PROXY_LIMIT_MB } from "./uploadGuards";
import {
  normalizeAuthResponse,
  normalizeRealtimeVoice,
  normalizeVoiceModeLanguage,
  withSessionRequest,
} from "./utils";
import {
  mapIcon,
  emitUnauthorized,
  transformConversationDetail,
  transformConversationSummary,
  transformSharedConversationDetail,
  transformMessage,
  transformInferenceRun,
  type RealtimeVoice,
} from "./consts";


const API_BASE_PATH = "/api/v1";
const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;
const CATALOG_BASE_PATH = `${API_BASE_PATH}/catalog`;
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



// Authenticate user credentials
export async function authenticate(credentials: AuthRequest): Promise<AuthResponse> {
  const res = await fetch(`${AUTH_BASE_PATH}/login`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(credentials),
  }));
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }

    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

    const error = new Error(detail || `Failed to authenticate: ${res.status}`) as AuthApiError;
    error.status = res.status;
    error.detail = detail;
    if (Number.isFinite(retryAfterSeconds)) {
      error.retryAfterSeconds = retryAfterSeconds;
    }
    throw error;
  }
  const data = await res.json();
  return normalizeAuthResponse(data);
}


// Get current session info (used for session restoration and auth checks)
export async function getSessionMe(): Promise<AuthResponse> {
  const res = await fetch(`${AUTH_BASE_PATH}/session`, withSessionRequest({
    headers: {
      "Accept": "application/json",
    },
  }));
  if (!res.ok) {
    const error = new Error(`Failed to fetch current session: ${res.status}`);
    (error as any).status = res.status;
    throw error;
  }
  const data = await res.json();
  return normalizeAuthResponse(data);
}


// Attempt to restore user session, first by checking current session, then by trying to refresh if unauthorized
export async function restoreSession(): Promise<AuthResponse | null> {
  try {
    return await getSessionMe();
  } catch (error) {
    if ((error as any)?.status !== 401) {
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
  const res = await fetch(`${AUTH_BASE_PATH}/session/refresh`, withSessionRequest({
    method: "POST",
    headers: {
      "Accept": "application/json",
    },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401 && emitOnUnauthorized) emitUnauthorized();
    throw new Error(`Failed to refresh session: ${res.status}`);
  }
  const data = await res.json();
  return normalizeAuthResponse(data);
}


// Logout user session
export async function logoutSession(): Promise<void> {
  const res = await fetch(`${AUTH_BASE_PATH}/logout`, withSessionRequest({
    method: "POST",
  }, { csrf: true }));
  if (!res.ok && res.status !== 401) {
    throw new Error(`Failed to logout: ${res.status}`);
  }
}


// Fetch agents from backend via nginx proxy
export async function getAgents(): Promise<Agent[]> {
  const res = await fetch(`${CATALOG_BASE_PATH}/agents`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch agents: ${res.status}`);
  }
  const data = (await res.json()) as AgentPublic[];
  return data.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    icon: mapIcon(a.icon),
    version: a.version,
    type: typeof (a as any).type === "string" ? (a as any).type : undefined,
    isActive: Boolean((a as any).isActive ?? (a as any).is_active ?? true),
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
  const res = await fetch(url, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch skills: ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((skill: any) => ({
    name: typeof skill?.name === "string" ? skill.name : "unknown-skill",
    description: typeof skill?.description === "string" ? skill.description : "",
    content: typeof skill?.content === "string" ? skill.content : "",
    category: typeof skill?.category === "string" ? skill.category : "",
  }));
}


// Fetch enabled skills for a (user, agent) pair.
// Returns a plain string[] of skill names. The bridge reads through a Redis
// cache; mutations invalidate the cache and the next GET re-fetches from the
// agents service (which is authoritative — the on-disk directory IS the state).
export async function getUserAgentSkills(userId: string, agentId: string): Promise<string[]> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`;
  const res = await fetch(url, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch user-agent skills: ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((entry: any) => String(entry));
}


// Enable a skill for the (user, agent) pair. 204 on success.
export async function enableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  const res = await fetch(url, withSessionRequest({
    method: "PUT",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to enable skill ${skillName}: ${res.status}`);
  }
}


// Disable a skill for the (user, agent) pair. 204 on success (idempotent).
export async function disableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  const res = await fetch(url, withSessionRequest({
    method: "DELETE",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to disable skill ${skillName}: ${res.status}`);
  }
}


// ---------------------------------------------------------------------------
// Per-user skill pool (the user's personal registry of globals + customs)
// ---------------------------------------------------------------------------
function normalizeUserSkill(raw: any): UserSkill {
  return {
    name: typeof raw?.name === "string" ? raw.name : "unknown-skill",
    type: raw?.type === "custom" ? "custom" : "global",
    description: typeof raw?.description === "string" ? raw.description : "",
    source_path: typeof raw?.source_path === "string" ? raw.source_path : "",
    category: typeof raw?.category === "string" ? raw.category : "",
  };
}

function normalizeSkillFile(raw: any): SkillFile {
  return {
    path: typeof raw?.path === "string" ? raw.path : "",
    content: typeof raw?.content === "string" ? raw.content : "",
    encoding: raw?.encoding === "base64" ? "base64" : "utf-8",
    size: typeof raw?.size === "number" ? raw.size : undefined,
  };
}


// Fetch the user's pool manifest entries (no SKILL.md content). Read-through
// cached on the bridge with a 5min TTL. ``bypassRedis: true`` forces an
// upstream fetch and upserts the cache.
export async function getMySkills(
  userId: string,
  options?: { bypassRedis?: boolean },
): Promise<UserSkill[]> {
  const base = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}`;
  const url = options?.bypassRedis ? `${base}?bypass_redis=true` : base;
  const res = await fetch(url, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    const error = new Error(`Failed to fetch my skills: ${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(normalizeUserSkill);
}


// Fetch a single user-pool skill with its SKILL.md body. Used when the user
// expands a card in the My skills view.
export async function getMySkillDetail(
  userId: string,
  skillName: string,
): Promise<UserSkillDetail> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  const res = await fetch(url, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch skill detail ${skillName}: ${res.status}`);
  }
  const raw = await res.json();
  return {
    ...normalizeUserSkill(raw),
    content: typeof raw?.content === "string" ? raw.content : "",
    files: Array.isArray(raw?.files)
      ? raw.files.map(normalizeSkillFile).filter((f: SkillFile) => f.path)
      : [],
  };
}


// Append a global-catalog skill into the user's pool. 204 on success. 404 if
// the skill isn't in the global catalog; 409 if it's already in the pool.
export async function addGlobalSkillToPool(
  userId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/global/${encodeURIComponent(skillName)}`;
  const res = await fetch(url, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to add global skill ${skillName} to pool: ${res.status}`);
  }
}


// Create a user-owned custom skill in the pool. 201 with the new manifest
// entry on success; 409 on name collision with global or own pool.
export async function createCustomSkill(
  userId: string,
  payload: CustomSkillCreatePayload,
): Promise<UserSkill> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/custom`;
  const res = await fetch(url, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    if (res.status === 413) {
      throw new Error(
        `This skill is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). Use smaller files.`,
      );
    }
    let detail = "";
    try {
      const errBody = await res.json();
      detail = typeof errBody?.detail === "string" ? errBody.detail : "";
    } catch {
      // swallow — we'll throw a generic error
    }
    throw new Error(detail || `Failed to create custom skill: ${res.status}`);
  }
  const raw = await res.json();
  return normalizeUserSkill(raw);
}


// Remove a skill from the user's pool. Cascades on the agents service —
// also removes the skill from every per-(user, agent) assignment folder.
export async function removeSkillFromPool(
  userId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  const res = await fetch(url, withSessionRequest({
    method: "DELETE",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to remove skill ${skillName} from pool: ${res.status}`);
  }
}


// Fetch available tools from backend
export async function getTools(): Promise<ToolMetadata[]> {
  const res = await fetch(`${CATALOG_BASE_PATH}/tools`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch tools: ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((tool: any) => ({
    serverId: typeof tool?.server_id === "string" ? tool.server_id : "",
    toolName: typeof tool?.tool_name === "string" ? tool.tool_name : "unknown-tool",
    description: typeof tool?.description === "string" ? tool.description : "",
    parameterCount: Number.isFinite(tool?.parameter_count) ? Math.max(0, Number(tool.parameter_count)) : 0,
  }));
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
  const res = await fetch(`${SEARCH_BASE_PATH}/${encodeURIComponent(userId)}?${params.toString()}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to search workspace: ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data as WorkspaceSearchResult[] : [];
}


// Fetch user preferences
export async function getUserPreferences(userId: string) {
  const res = await fetch(`${PREFERENCES_BASE_PATH}/${userId}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch user preferences: ${res.status}`);
  }
  const data = await res.json();
  const tools = Array.isArray(data?.tools?.disabled) ? (data.tools.disabled as any[]) : [];
  const prefersAgenticChat =
    typeof data?.prefersAgenticChat === "boolean"
      ? data.prefersAgenticChat
      : false;
  const suggestionsEnabled =
    typeof data?.suggestionsEnabled === "boolean"
      ? data.suggestionsEnabled
      : true;
  const voiceModeVoice = normalizeRealtimeVoice(data?.voiceModeVoice);
  const voiceModeLanguage = normalizeVoiceModeLanguage(data?.voiceModeLanguage);

  return { tools: { disabled: tools }, prefersAgenticChat, suggestionsEnabled, voiceModeVoice, voiceModeLanguage };
}


// Update user preferences
export async function updateUserPreferences(userId: string, prefs: any) {
  const res = await fetch(`${PREFERENCES_BASE_PATH}/${userId}`, withSessionRequest({
    method: "PUT",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to update user preferences: ${res.status}`);
  }
  const data = await res.json();
  const tools = Array.isArray(data?.tools?.disabled) ? (data.tools.disabled as any[]) : [];
  const prefersAgenticChat =
    typeof data?.prefersAgenticChat === "boolean"
      ? data.prefersAgenticChat
      : false;
  const suggestionsEnabled =
    typeof data?.suggestionsEnabled === "boolean"
      ? data.suggestionsEnabled
      : true;
  const voiceModeVoice = normalizeRealtimeVoice(data?.voiceModeVoice);
  const voiceModeLanguage = normalizeVoiceModeLanguage(data?.voiceModeLanguage);
  return { tools: { disabled: tools }, prefersAgenticChat, suggestionsEnabled, voiceModeVoice, voiceModeLanguage };
}


// Fetch personalized starter suggestions for a new chat.
export async function getSuggestions(userId: string, agentId?: string | null): Promise<string[]> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await fetch(`${CATALOG_BASE_PATH}/${userId}/suggestions${query}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch suggestions: ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.suggestions)
    ? data.suggestions.filter((suggestion: unknown): suggestion is string => typeof suggestion === "string" && suggestion.trim().length > 0)
    : [];
}


// Fetch conversations for a user
export async function getConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}?page=${page}&size=${size}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch conversations: ${res.status}`);
  }
  // Backend returns a Page shape: { items, total, page, size }
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  return (items as any[]).map(transformConversationSummary);
}


// Fetch archived conversations for a user
export async function getArchivedConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/archived?page=${page}&size=${size}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch archived conversations: ${res.status}`);
  }
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  return (items as any[]).map(transformConversationSummary);
}


// Fetch conversation details with full message history
export async function getConversationDetail(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch conversation details: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationDetail(data);
}


// Delete a conversation
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}`, withSessionRequest({
    method: "DELETE",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to delete conversation: ${res.status}`);
  }
}


// Archive a conversation and return the updated summary
export async function archiveConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/archive`, withSessionRequest({
    method: "PATCH",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to archive conversation: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationSummary(data);
}


// Unarchive a conversation and return the updated summary
export async function unarchiveConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/unarchive`, withSessionRequest({
    method: "PATCH",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to unarchive conversation: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationSummary(data);
}


// Report a conversation with an optional specific message target
export async function reportConversation(
  userId: string,
  conversationId: string,
  payload: ConversationReportPayload,
): Promise<ConversationSummary> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/report`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to report conversation: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationSummary(data);
}


// Rename a conversation and return the updated summary
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/title`, withSessionRequest({
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ title }),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to rename conversation: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationSummary(data);
}


// Create a new conversation with the first message
export async function createConversation(
  userId: string,
  payload: ConversationIn,
): Promise<CreateConversationResponse> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) {
      emitUnauthorized();
      throw new Error(`Failed to create conversation: ${res.status}`);
    }
    if (res.status === 413) {
      // Show a friendly message tailored to the limits you set
      throw new Error(
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`,
      );
    }
    throw new Error(`Failed to create conversation: ${res.status}`);
  }

  const data = await res.json();

  const detail = transformConversationDetail(data.detail);
  const summary = transformConversationSummary(data.summary);

  return { detail, summary };
}


// Fork the current branch ending at the selected AI message.
export async function forkConversation(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<ConversationSummary> {
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/fork`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ messageId }),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to fork conversation: ${res.status}`);
  }

  const data = await res.json();
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
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      messageId,
      mode,
      ...(branchPath?.length ? { branchPath } : {}),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    }),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to share conversation: ${res.status}`);
  }

  const data = await res.json();
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
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share/export-pdf`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/pdf",
    },
    body: JSON.stringify({
      messageId,
      mode,
      ...(branchPath?.length ? { branchPath } : {}),
    }),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to export PDF: ${res.status}`);
  }

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
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/shares?page=${page}&size=${size}`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch shared conversations: ${res.status}`);
  }
  const data = await res.json();
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
  const res = await fetch(`${CONVERSATIONS_BASE_PATH}/${userId}/${conversationId}/share/${shareId}`, withSessionRequest({
    method: "DELETE",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to revoke shared conversation: ${res.status}`);
  }
}


// Fetch a public read-only shared conversation snapshot.
export async function getSharedConversation(token: string): Promise<SharedConversationDetail> {
  const res = await fetch(`${SHARED_CONVERSATIONS_BASE_PATH}/${encodeURIComponent(token)}`, {
    headers: {
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const error = new Error(`Failed to fetch shared conversation: ${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  const data = await res.json();
  return transformSharedConversationDetail(data);
}

// Add a message to an existing conversation
export async function addMessageToConversation(
  userId: string,
  conversationId: string,
  payload: MessageIn,
): Promise<UpdateConversationResponse> {
  const res = await fetch(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) {
      emitUnauthorized();
      throw new Error(`Failed to add message: ${res.status}`);
    }
    if (res.status === 413) {
      throw new Error(
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`,
      );
    }
    throw new Error(`Failed to add message: ${res.status}`);
  }

  const data = await res.json();

  if (data.detail) {
    const detail = transformConversationDetail(data.detail);
    const last = detail.messages[detail.messages.length - 1];
    return {
      message: last,
      summary: transformConversationSummary(data.summary),
    } as UpdateConversationResponse;
  }

  const m = data.message;
  return {
    message: transformMessage(m),
    summary: transformConversationSummary(data.summary),
  } as UpdateConversationResponse;
}


// Update an existing message in a conversation (used for AI placeholders)
export async function updateMessageInConversation(
  userId: string,
  conversationId: string,
  messageId: string,
  payload: MessageUpdate,
): Promise<UpdateConversationResponse> {
  const res = await fetch(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}`, withSessionRequest({
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) {
      emitUnauthorized();
      throw new Error(`Failed to update message: ${res.status}`);
    }
    throw new Error(`Failed to update message: ${res.status}`);
  }

  const data = await res.json();
  return {
    message: transformMessage(data.message),
    summary: transformConversationSummary(data.summary),
  } as UpdateConversationResponse;
}


// Like a message
export async function likeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const res = await fetch(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/like`, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to like message: ${res.status}`);
  }
  const m = await res.json();
  return transformMessage(m);
}


// Dislike a message
export async function dislikeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const res = await fetch(`${MESSAGES_BASE_PATH}/${userId}/${conversationId}/${messageId}/dislike`, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to dislike message: ${res.status}`);
  }
  const m = await res.json();
  return transformMessage(m);
}


// Generate read-aloud audio for an AI message
export async function generateMessageReadAloudAudio(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<Blob> {
  const res = await fetch(`${SPEECH_BASE_PATH}/read-aloud/${userId}/${conversationId}/${messageId}`, withSessionRequest({
    method: "POST",
    headers: { "Accept": "audio/mpeg,audio/*" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to generate read-aloud audio: ${res.status}`);
  }
  return await res.blob();
}


// Generate a short read-aloud preview for a selected voice
export async function generateReadAloudPreviewAudio(
  userId: string,
  voice: RealtimeVoice,
  text = "Hey! I am your AI speaker.",
): Promise<Blob> {
  const res = await fetch(`${SPEECH_BASE_PATH}/read-aloud-preview/${userId}`, withSessionRequest({
    method: "POST",
    headers: {
      "Accept": "audio/mpeg,audio/*",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ voice: normalizeRealtimeVoice(voice), text }),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to generate read-aloud preview: ${res.status}`);
  }
  return await res.blob();
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
  const res = await fetch(url, withSessionRequest());
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to download attachment: ${res.status}`);
  }
  return await res.blob();
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
  const res = await fetch(getAttachmentPreviewUrl({ userId, conversationId, messageId, blobId }), withSessionRequest());
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to preview attachment: ${res.status}`);
  }
  return await res.blob();
}


export async function fetchDocxPreviewToken({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<DocxPreviewTokenResponse> {
  const segments = [userId, conversationId, messageId, blobId].map(encodeURIComponent);
  const res = await fetch(
    `${ATTACHMENTS_BASE_PATH}/preview-token/${segments.join("/")}`,
    withSessionRequest(),
  );
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to obtain preview token: ${res.status}`);
  }
  return await res.json() as DocxPreviewTokenResponse;
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

  const res = await fetch(`${SPEECH_BASE_PATH}/dictation/${userId}`, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json" },
    body: formData,
  }, { csrf: true }));

  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to transcribe dictation: ${res.status}`);
  }

  const data = await res.json();
  if (!data || typeof data.text !== "string") {
    throw new Error("Invalid dictation response.");
  }

  return data.text;
}

export async function createRealtimeVoiceSession(
  userId: string,
  payload: RealtimeVoiceSessionRequest,
): Promise<RealtimeVoiceSessionResponse> {
  const res = await fetch(`${VOICE_BASE_PATH}/realtime/${userId}/session`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(detail || `Failed to create realtime voice session: ${res.status}`);
  }
  const data = await res.json();
  return {
    sdp: data.sdp,
    model: data.model,
    voice: data.voice,
  };
}

export async function persistRealtimeVoiceConversationEvent(
  userId: string,
  payload: RealtimeVoiceConversationEventRequest,
): Promise<UpdateConversationResponse> {
  const res = await fetch(`${VOICE_BASE_PATH}/realtime/${userId}/conversation-event`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to persist realtime voice transcript: ${res.status}`);
  }
  const data = await res.json();
  return {
    message: transformMessage(data.message),
    summary: transformConversationSummary(data.summary),
  };
}

export async function endRealtimeVoiceSession(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const res = await fetch(`${VOICE_BASE_PATH}/realtime/${userId}/end`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ conversationId }),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to end realtime voice session: ${res.status}`);
  }
  const data = await res.json();
  return transformConversationSummary(data.summary);
}


const serializeToolPreferences = (enabledTools?: ToolPreference[]) =>
  Array.isArray(enabledTools) && enabledTools.length > 0
    ? enabledTools.map((item) => ({
        server_id:
          typeof (item as any).server_id === "string"
            ? (item as any).server_id
            : typeof item.serverId === "string"
              ? item.serverId
              : "",
        tool_name:
          typeof (item as any).tool_name === "string"
            ? (item as any).tool_name
            : typeof item.toolName === "string"
              ? item.toolName
              : "",
      }))
    : undefined;

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
  const enabledTools = serializeToolPreferences(payload.enabledTools);
  if (enabledTools) {
    body.enabledTools = enabledTools;
  }

  const res = await fetch(`${INFERENCE_BASE_PATH}/runs/${userId}/start`, withSessionRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore body parse issues
    }
    const error = new Error(detail || `Failed to start inference: ${res.status}`);
    (error as any).status = res.status;
    (error as any).detail = detail;
    throw error;
  }
  const data = await res.json();
  return {
    detail: transformConversationDetail(data.detail),
    summary: transformConversationSummary(data.summary),
    run: transformInferenceRun(data.run),
    message: transformMessage(data.message),
  };
}

export async function getActiveInferenceRuns(userId: string): Promise<InferenceRun[]> {
  const res = await fetch(`${INFERENCE_BASE_PATH}/runs/${userId}?status=active`, withSessionRequest({
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to fetch active inference runs: ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data.map(transformInferenceRun) : [];
}

export async function cancelInferenceRun(userId: string, runId: string): Promise<InferenceRun> {
  const res = await fetch(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/cancel`, withSessionRequest({
    method: "POST",
    headers: { "Accept": "application/json" },
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to cancel inference run: ${res.status}`);
  }
  return transformInferenceRun(await res.json());
}

export type ResumeInferenceRunBody = {
  // LangGraph interrupt id from the HITL_INTERRUPT event the user is acting
  // on. Lets the bridge/agents service verify the right interrupt is being
  // resolved when multiple HITLs fire in sequence on the same conversation.
  interruptId: string;
  threadId: string;
  decision: "approve" | "reject";
  reason?: string;
  value?: unknown;
};

export async function resumeInferenceRun(
  userId: string,
  runId: string,
  body: ResumeInferenceRunBody,
): Promise<InferenceRun> {
  const res = await fetch(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/resume`, withSessionRequest({
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      interruptId: body.interruptId,
      threadId: body.threadId,
      decision: body.decision,
      reason: body.reason ?? null,
      value: body.value ?? null,
    }),
  }, { csrf: true }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch { /* ignore */ }
    const error = new Error(detail || `Failed to resume inference run: ${res.status}`);
    (error as any).status = res.status;
    (error as any).detail = detail;
    throw error;
  }
  return transformInferenceRun(await res.json());
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
        emitUnauthorized();
        finalize(() => reject(new PermanentInferenceWebSocketError(
          event.reason || "Authentication required",
          event.code,
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
