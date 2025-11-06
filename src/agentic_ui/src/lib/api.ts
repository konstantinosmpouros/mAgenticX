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
    const user = data.user as any;
    data.user = {
      ...user,
      prefersAgenticChat: Boolean(user.prefersAgenticChat),
      createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
      updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date(),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : undefined,
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
    const user = data.user as any;
    data.user = {
      ...user,
      prefersAgenticChat: Boolean(user.prefersAgenticChat),
      createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
      updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date(),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : undefined,
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
  onEvent: (e: AGUIEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/inference/stream`, withCredentials({
    method: "POST",
    headers: {
      "Accept": "text/event-stream",
    },
    signal,
  }));
  if (!res.ok) {
    if (res.status === 401) emitUnauthorized();
    throw new Error(`Failed to start inference stream: ${res.status}`);
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
