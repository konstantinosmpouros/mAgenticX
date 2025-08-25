// src/lib/api.ts
import type { 
  Agent,
  AgentPublic,
  AuthRequest,
  AuthResponse,
  ConversationDetail,
  ConversationSummary,
  MessageOut,
  AttachmentOut,
  ConversationIn,
  AttachmentIn,
  FileAttachment
  } from "./types";
import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";


const mapIcon = (name: string): LucideIcon => {
  const Icon = (Icons as Record<string, any>)[name] as LucideIcon | undefined;
  // Fallback gracefully to Building2 if icon name is invalid
  return Icon || Icons.Building2;
};

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
export async function getConversations(userId: string): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/users/${userId}/conversations`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch conversations: ${res.status}`);
  }
  const data = (await res.json()) as ConversationSummary[];
  return data;
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
      timestamp: new Date(att.timestamp)
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

// Convert File to base64 AttachmentIn format
export async function fileToAttachmentIn(file: File): Promise<AttachmentIn> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result as string;
      // Remove the data:mime;base64, prefix
      const dataB64 = base64String.split(',')[1];
      resolve({
        name: file.name,
        mime: file.type,
        dataB64,
        size: file.size
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Convert FileAttachment array to AttachmentIn array
export async function convertFileAttachments(fileAttachments: FileAttachment[]): Promise<AttachmentIn[]> {
  const attachmentPromises = fileAttachments.map(attachment => 
    fileToAttachmentIn(attachment.file)
  );
  return Promise.all(attachmentPromises);
}

// Create a new conversation with the first message
export async function createConversation(userId: string, payload: ConversationIn): Promise<ConversationDetail> {
  const res = await fetch(`/api/users/${userId}/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to create conversation: ${res.status}`);
  }

  const data = await res.json();
  
  // Transform the response to match our ConversationDetail type
  return {
    ...data,
    created_at: new Date(data.created_at),
    updated_at: new Date(data.updated_at),
    messages: data.messages.map((message: any) => ({
      ...message,
      created_at: new Date(message.created_at),
      updated_at: new Date(message.updated_at),
      attachments: message.attachments.map((attachment: any) => ({
        ...attachment,
        timestamp: new Date(attachment.timestamp)
      }))
    }))
  };
}
