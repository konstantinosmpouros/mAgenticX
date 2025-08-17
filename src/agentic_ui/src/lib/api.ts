// src/lib/api.ts
import type { 
  Agent,
  AgentPublic,
  AuthRequest,
  AuthResponse,
  Conversation,
  ConversationDetail,
  Message,
  ConversationSummary,
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
export async function getConversations(userId: string): Promise<Conversation[]> {
  const res = await fetch(`/api/users/${userId}/conversations`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch conversations: ${res.status}`);
  }
  const data = (await res.json()) as ConversationSummary[];
  return data.map((c) => ({
    id: c.id,
    agentId: c.agentId,
    agentName: c.agentName || "Unknown Agent",
    lastMessage: c.lastMessage || "",
    timestamp: new Date(c.updated_at),
    messages: [], // Will be populated when conversation is selected
    isPrivate: c.isPrivate,
  }));
}

// Fetch conversation details with full message history
export async function getConversationDetail(userId: string, conversationId: string): Promise<Conversation> {
  const res = await fetch(`/api/users/${userId}/conversations/${conversationId}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch conversation details: ${res.status}`);
  }
  const data = (await res.json()) as ConversationDetail;
  
  // Transform backend messages to frontend format
  const transformedMessages: Message[] = data.messages.map((msg) => ({
    id: msg.id,
    content: msg.content || "",
    sender: msg.sender as "user" | "agent",
    timestamp: new Date(msg.timestamp),
    type: msg.type as "text" | "image" | "file",
    attachments: msg.attachments.map(att => att.name), // Transform to string array for now
    thinking: msg.thinking || undefined,
    thinkingTime: msg.thinkingTime || undefined,
    error: msg.error || undefined,
    errorMessage: msg.errorMessage || undefined,
  }));

  return {
    id: data.id,
    agentId: data.agentId,
    agentName: data.agentName || "Unknown Agent",
    lastMessage: transformedMessages.length > 0 ? transformedMessages[transformedMessages.length - 1].content : "",
    timestamp: new Date(data.updated_at),
    messages: transformedMessages,
    isPrivate: data.isPrivate,
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
