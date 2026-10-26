// ------------------------------------------------------
// Agent Schemas
// ------------------------------------------------------
// `Agent` is cross-cutting (conversations, sharing, transforms all reference
// it), so this module is deliberately a LEAF: it imports nothing from the rest
// of `types/` — only the Lucide icon type and the Zod-inferred wire contracts.
import type { LucideIcon } from "lucide-react";
import type { AgentFile, AgentKind, CustomAgentSummary } from "../schemas";

// `AgentFile`, `CustomAgentDetail`, `CustomAgentValidation`, `AgentToolRow` and
// `AgentToolsResponse` are inferred from their Zod schemas (see `../schemas`).
export type {
  AgentFile,
  AgentIssue,
  AgentKind,
  AgentModelOption,
  BuiltinToolInfo,
  CustomAgentSummary,
  CustomAgentDetail,
  CustomAgentImportResult,
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
  kind?: AgentKind;
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
  /**
   * "custom" for an agent this user built, "platform" for the rest. Absent where
   * the payload carried no kind (an agent embedded in a conversation, an old
   * snapshot), which every consumer reads as "not known to be custom".
   */
  kind?: AgentKind;
};

/** One of the user's own agents, with the gallery's summary when it was asked for. */
export type MyAgent = Agent & CustomAgentSummary;

// What the builder collects. Mirrors the fields of the backend AgentSpec that a
// user may set; everything else (id, version, type) is derived on submit, and
// the spec document itself is assembled in one place (`buildAgentPayload`) so the
// builder never has to know the YAML shape.
export type AgentDraftSubAgent = {
  /**
   * The builder's own id for this node, stable across edits, renames and moves —
   * what the canvas, the selection and the issue badges key on, so a rename or a
   * sibling's removal never re-points them at another node. Never saved.
   */
  uid: string;
  name: string;
  description: string;
  prompt: string;
  /** A model id, or `""` to inherit the model of the agent above it. */
  model: string;
  /**
   * MCP tools this sub-agent is restricted to, as `server/tool` keys — always a
   * subset of the tools of the agent above it. Empty means **inherit**: it gets
   * every tool that agent has, which is the runtime's behaviour for an omitted list.
   */
  tools: string[];
  /** Its own sub-agents (nested delegation, at most 3 levels below the agent). */
  subagents: AgentDraftSubAgent[];
};

// A reference file the user adds to an agent folder, beyond the prompts the
// builder generates. Always UTF-8: an agent definition is prompts and config only,
// so the backend's extension allowlist has no binary types.
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
  /**
   * MCP tools the agent declares, as canonical cache keys (`server/tool`).
   *
   * Stored as keys rather than `{serverId, toolName}` pairs because every other
   * surface — the catalog, an agent's page, the override rows — identifies a tool
   * by that exact string; the spec's two-field shape is assembled on save.
   * Built-in tools are not listed here: every agent has them.
   */
  tools: string[];
  skills: string[];
  subagents: AgentDraftSubAgent[];
  files: AgentDraftFile[];
  /**
   * The definition's own approval defaults (`hitl`, by bare tool name), kept
   * from an imported YAML or a saved spec and written back as they came. The
   * builder never adds to them: what the user chooses goes to `approvals`.
   */
  hitl: Record<string, boolean>;
  /**
   * Ask / Don't ask choices made in the builder, by tool key (a built-in's name,
   * an MCP tool's `server/tool`). Not part of the definition: saved after it, as
   * this user's approval preferences for the agent (the rows its Approvals tab
   * edits).
   */
  approvals: Record<string, boolean>;
};

// Create/update payload: the agent.yaml document plus the prompt files it
// references. `spec` is opaque here — the backend owns its schema.
export type CustomAgentWritePayload = {
  spec: Record<string, unknown>;
  files: AgentFile[];
};
