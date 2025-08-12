// src/lib/api.ts
import type { Agent } from "./types";
import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

// Raw shape returned by backend
export type AgentPublic = {
  id: string;
  name: string;
  description: string;
  icon: string; // Lucide icon name string, e.g., "Building2"
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
