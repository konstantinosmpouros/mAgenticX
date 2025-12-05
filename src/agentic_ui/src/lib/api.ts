import type {
  Agent,
  AgentPublic,
  AuthRequest,
  AuthResponse,
  ConversationDetail,
  ConversationSummary,
  MessageOut,
  ConversationIn,
  CreateConversationResponse,
  MessageIn,
  UpdateConversationResponse,
  DownloadAttachmentParams,
  AGUIEvent,
  ToolMetadata,
  ToolPreference,
} from "./types";
import { PROXY_LIMIT_MB } from "./uploadGuards";
import { parseSSE } from "./utils";
import {
  mapIcon,
  withCredentials,
  emitUnauthorized,
  transformConversationDetail,
  transformConversationSummary,
  transformMessage,
} from "./consts";


// Authenticate user credentials
export async function authenticate(credentials: AuthRequest): Promise<AuthResponse> {
  const res = await fetch("/api/authenticate", withCredentials({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(credentials),
  }));
  if (!res.ok) {
    throw new Error(`Failed to authenticate: ${res.status}`);
  }
  const data = await res.json();
  if (data && typeof data === "object" && data.user) {
    const { prefersAgenticChat: _prefersAgenticChat, prefers_agentic_chat: _ignored, ...rest } = data.user as any;
    data.user = {
      ...rest,
      createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
      updatedAt: rest.updatedAt ? new Date(rest.updatedAt) : new Date(),
      lastLoginAt: rest.lastLoginAt ? new Date(rest.lastLoginAt) : undefined,
    };
  }
  return data as AuthResponse;
}


// Refresh user session
export async function refreshSession(): Promise<AuthResponse> {
  const res = await fetch("/api/session/refresh", withCredentials({
    method: "POST",
    headers: {
      "Accept": "application/json",
    },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to refresh session: ${res.status}`);
  }
  const data = await res.json();
  if (data && typeof data === "object" && data.user) {
    const { prefersAgenticChat: _prefersAgenticChat, prefers_agentic_chat: _ignored, ...rest } = data.user as any;
    data.user = {
      ...rest,
      createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
      updatedAt: rest.updatedAt ? new Date(rest.updatedAt) : new Date(),
      lastLoginAt: rest.lastLoginAt ? new Date(rest.lastLoginAt) : undefined,
    };
  }
  return data as AuthResponse;
}


// Fetch agents from backend via nginx proxy
export async function getAgents(): Promise<Agent[]> {
  const res = await fetch("/api/agents", withCredentials({
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
    isActive: Boolean((a as any).isActive ?? (a as any).is_active ?? true),
  }));
}


// Fetch available tools from backend
export async function getTools(): Promise<ToolMetadata[]> {
  const res = await fetch("/api/tools", withCredentials({
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


// Fetch user preferences
export async function getUserPreferences(userId: string) {
  const res = await fetch(`/api/users/${userId}/preferences`, withCredentials({
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

  return { tools: { disabled: tools }, prefersAgenticChat };
}


// Update user preferences
export async function updateUserPreferences(userId: string, prefs: any) {
  const res = await fetch(`/api/users/${userId}/preferences`, withCredentials({
    method: "PUT",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  }));
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
  return { tools: { disabled: tools }, prefersAgenticChat };
}


// Fetch conversations for a user
export async function getConversations(
  userId: string,
  page: number = 1,
  size: number = 10,
): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/users/${userId}/conversations?page=${page}&size=${size}`, withCredentials({
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


// Fetch conversation details with full message history
export async function getConversationDetail(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}`, withCredentials({
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
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}`, withCredentials({
    method: "DELETE",
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to delete conversation: ${res.status}`);
  }
}


// Rename a conversation and return the updated summary
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/title`, withCredentials({
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ title }),
  }));
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
  const res = await fetch(`/api/users/${userId}/conversations`, withCredentials({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }));

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


// Add a message to an existing conversation
export async function addMessageToConversation(
  userId: string,
  conversationId: string,
  payload: MessageIn,
): Promise<UpdateConversationResponse> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/messages`, withCredentials({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  }));

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


// Like a message
export async function likeMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageOut> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/messages/${messageId}/like`, withCredentials({
    method: "POST",
    headers: { "Accept": "application/json" },
  }));
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
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/messages/${messageId}/dislike`, withCredentials({
    method: "POST",
    headers: { "Accept": "application/json" },
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to dislike message: ${res.status}`);
  }
  const m = await res.json();
  return transformMessage(m);
}


// Download an attachment blob
export async function downloadAttachment({
  userId,
  conversationId,
  messageId,
  blobId,
  filename,
}: DownloadAttachmentParams): Promise<void> {
  const url = `/api/users/${userId}/conversations/${conversationId}/messages/${messageId}/blobs/${blobId}`;
  const res = await fetch(url, withCredentials());
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to download attachment: ${res.status}`);
  }
  const blob = await res.blob();
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


// Transcribe an audio dictation blob via the backend
export async function transcribeDictation(
  userId: string,
  audio: Blob,
  filename?: string,
): Promise<string> {
  const formData = new FormData();
  const safeName = filename || "dictation.webm";
  formData.append("audio", audio, safeName);

  const res = await fetch(`/api/users/${userId}/dictation/transcribe`, withCredentials({
    method: "POST",
    headers: { "Accept": "application/json" },
    body: formData,
  }));

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


// Start streaming inference by requesting the bridge SSE endpoint
export async function streamInference(
  userId: string,
  conversationId: string,
  messagePath: string[],
  onEvent: (e: AGUIEvent) => void,
  signal?: AbortSignal,
  enabledTools?: ToolPreference[],
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (Array.isArray(messagePath) && messagePath.length > 0) {
    payload.messagePath = messagePath;
  }
  if (Array.isArray(enabledTools) && enabledTools.length > 0) {
    payload.enabledTools = enabledTools.map((item) => ({
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
    }));
  }
  const headers: Record<string, string> = { "Accept": "text/event-stream" };
  if (Object.keys(payload).length > 0) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/inference/stream`, withCredentials({
    method: "POST",
    headers,
    signal,
    body: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    let detail: string | undefined;
    try {
      const data = await res.json();
      detail = typeof data === "object" && data !== null ? (data as any).detail : undefined;
    } catch {
      // ignore body parse issues
    }
    const error = new Error(detail || `Failed to start inference stream: ${res.status}`);
    (error as any).status = res.status;
    (error as any).detail = detail;
    throw error;
  }
  if (!res.body) {
    throw new Error(`Failed to start inference stream: ${res.status}`);
  }

  const reader = res.body.getReader();
  const textDecoder = new TextDecoder();
  let buffer = "";
  const cancelReader = () => {
    try { reader.cancel(); } catch {}
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += textDecoder.decode(value, { stream: true });
      buffer = parseSSE(buffer, onEvent);
    }
    // Flush any remaining buffered data (handle streams ending without trailing newline)
    buffer += textDecoder.decode(new Uint8Array(), { stream: false });
    if (buffer) {
      // append a newline to ensure the last line is processed
      buffer = parseSSE(buffer + "\n", onEvent);
    }
  } finally {
    signal?.removeEventListener?.("abort", cancelReader as any);
    try { reader.releaseLock(); } catch {}
  }
}
