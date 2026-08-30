// ------------------------------------------------------
// Agent Schemas
// ------------------------------------------------------
// `Agent` is cross-cutting (conversations, sharing, transforms all reference
// it), so this module is deliberately a LEAF: it imports nothing from the rest
// of `types/` — only the Lucide icon type and the Zod-inferred wire contracts.
import type { LucideIcon } from "lucide-react";
import type { AgentFile } from "../schemas";

// `AgentFile`, `CustomAgentDetail`, `CustomAgentValidation`, `AgentToolRow` and
// `AgentToolsResponse` are inferred from their Zod schemas (see `../schemas`).
export type {
  AgentFile,
  CustomAgentDetail,
  CustomAgentValidation,
  AgentToolRow,
  AgentToolsResponse,
} from "../schemas";

// Raw shape returned by backend
export type AgentPublic = {
  id: string;
  name: string;
  description: string;
  icon: string; // Lucide icon name string, e.g., "Building2"
  version?: string;
  type?: string;
  isActive: boolean;
};

// Agent type used in the application
export type Agent = {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  iconName?: string | null;
  version?: string;
  // Lifecycle type — "deep agent" / "langgraph agent" / "openai agent".
  // Used by the Skills tab to filter to agents that support per-user
  // skill selection (only deep agents do).
  type?: string;
  isActive: boolean;
};

// What the builder collects. Mirrors the fields of the backend AgentSpec that a
// user may set; everything else (id, version, type) is derived on submit, and
// the spec document itself is assembled in one place (`buildAgentSpec`) so the
// form never has to know the YAML shape.
export type AgentDraftSubAgent = {
  name: string;
  description: string;
  prompt: string;
};

// A reference file the user adds to an agent folder, beyond the prompts the form
// generates. Always UTF-8: an agent definition is prompts and config only, so the
// backend's extension allowlist has no binary types and base64 would be dead weight.
export type AgentDraftFile = {
  path: string;
  content: string;
};

export type AgentDraft = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  prompt: string;
  memory: boolean;
  skills: string[];
  subagents: AgentDraftSubAgent[];
  files: AgentDraftFile[];
};

// Create/update payload: the agent.yaml document plus the prompt files it
// references. `spec` is opaque here — the backend owns its schema.
export type CustomAgentWritePayload = {
  spec: Record<string, unknown>;
  files: AgentFile[];
};
