// src/lib/api.ts
import type { Agent, Conversation } from "./types";
import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

// Raw shape returned by backend
export type AgentPublic = {
  id: string;
  name: string;
  description: string;
  icon: string; // Lucide icon name string, e.g., "Building2"
};

// Raw shape returned by backend for conversations
export type ConversationSummary = {
  id: string;
  agentId: string;
  agentName?: string;
  title?: string;
  isPrivate: boolean;
  lastMessage?: string;
  created_at: string;
  updated_at: string;
};

const mapIcon = (name: string): LucideIcon => {
  const Icon = (Icons as Record<string, any>)[name] as LucideIcon | undefined;
  // Fallback gracefully to Building2 if icon name is invalid
  return Icon || Icons.Building2;
};

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
