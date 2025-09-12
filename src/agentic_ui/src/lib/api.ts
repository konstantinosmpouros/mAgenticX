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
  } from "./types";
import { mapIcon } from "./constants";
import { PROXY_LIMIT_MB } from "./uploadGuards";


// Authenticate user credentials
export async function authenticate(credentials: AuthRequest): Promise<AuthResponse> {
  const res = await fetch("/api/authenticate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) {
    throw new Error(`Failed to authenticate: ${res.status}`);
  }
  return await res.json() as AuthResponse;
}

// Fetch agents from backend via nginx proxy
export async function getAgents(): Promise<Agent[]> {
  const res = await fetch("/api/agents", {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch agents: ${res.status}`);
  }
  const data = (await res.json()) as AgentPublic[];
  return data.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    icon: mapIcon(a.icon),
  }));
}

// Fetch conversations for a user
export async function getConversations(userId: string, page: number = 1, size: number = 10): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/users/${userId}/conversations?page=${page}&size=${size}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch conversations: ${res.status}`);
  }
  // Backend returns a Page shape: { items, total, page, size }
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  return items as ConversationSummary[];
}

// Fetch conversation details with full message history
export async function getConversationDetail(userId: string, conversationId: string): Promise<ConversationDetail> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch conversation details: ${res.status}`);
  }
  const data = (await res.json()) as ConversationDetail;
  
  // Transform backend messages to frontend format
  const transformedMessages: MessageOut[] = data.messages.map((msg) => ({
    id: msg.id,
    content: msg.content || "",
    sender: msg.sender,
    type: msg.type,
    created_at: new Date(msg.created_at),
    updated_at: new Date(msg.updated_at),
    attachments: msg.attachments.map((att: any) => ({
      ...att,
      timestamp: new Date(att.timestamp),
      blobId: att.blobId
    })),
    thinking: msg.thinking || undefined,
    thinkingTime: msg.thinkingTime || undefined,
    error: msg.error || undefined,
    errorMessage: msg.errorMessage || undefined,
  }));

  return {
    id: data.id,
    agentId: data.agentId,
    agentName: data.agentName || "Unknown Agent",
    title: data.title || "",
    isPrivate: data.isPrivate,
    created_at: new Date(data.created_at),
    updated_at: new Date(data.updated_at),
    messages: transformedMessages,
    
  };
}

// Delete a conversation
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to delete conversation: ${res.status}`);
  }
}

// Create a new conversation with the first message
export async function createConversation(userId: string, payload: ConversationIn): Promise<CreateConversationResponse> {
  const res = await fetch(`/api/users/${userId}/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    if (res.status === 413) {
      // Show a friendly message tailored to the limits you set
      throw new Error(
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`
      );
    }
    throw new Error(`Failed to create conversation: ${res.status}`);
  }

  const data = await res.json();
  
  // Transform the response to match our CreateConversationResponse type
  return {
    detail: {
      ...data.detail,
      created_at: new Date(data.detail.created_at),
      updated_at: new Date(data.detail.updated_at),
      messages: data.detail.messages.map((message: any) => ({
        ...message,
        created_at: new Date(message.created_at),
        updated_at: new Date(message.updated_at),
        attachments: message.attachments.map((attachment: any) => ({
          ...attachment,
          timestamp: new Date(attachment.timestamp),
          blobId: attachment.blobId || attachment.blob_id // Handle both camelCase and snake_case
        }))
      }))
    },
    summary: data.summary
  };
}

// Add a message to an existing conversation
export async function addMessageToConversation(userId: string, conversationId: string, payload: MessageIn): Promise<UpdateConversationResponse> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    if (res.status === 413) {
      throw new Error(
        `Your message is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). ` +
        `Try smaller files or fewer attachments.`
      );
    }
    throw new Error(`Failed to add message to conversation: ${res.status}`);
  }

  const data = await res.json();

  // Backward-compat: if server still returns detail, derive the last message
  if (data.detail) {
    const last = data.detail.messages[data.detail.messages.length - 1];
    return {
      message: {
        ...last,
        created_at: new Date(last.created_at),
        updated_at: new Date(last.updated_at),
        attachments: (last.attachments || []).map((att: any) => ({
          ...att,
          timestamp: new Date(att.timestamp),
          blobId: att.blobId || att.blob_id
        })),
      },
      summary: data.summary,
    } as UpdateConversationResponse;
  }

  // New shape: { message, summary }
  const m = data.message;
  return {
    message: {
      ...m,
      created_at: new Date(m.created_at),
      updated_at: new Date(m.updated_at),
      attachments: (m.attachments || []).map((att: any) => ({
        ...att,
        timestamp: new Date(att.timestamp),
        blobId: att.blobId || att.blob_id,
      })),
    },
    summary: data.summary,
  } as UpdateConversationResponse;
}

// Download non-image attachment
export async function downloadAttachment(userId: string, conversationId: string, messageId: string, blobId: string): Promise<Blob> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}/messages/${messageId}/blobs/${blobId}`, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error(`Failed to download attachment: ${res.status}`);
  }

  return await res.blob();
}

