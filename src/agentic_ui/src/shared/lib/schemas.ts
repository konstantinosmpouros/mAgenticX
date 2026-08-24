/**
 * Runtime response contracts for the backend API — the single source of truth
 * for the *shape* of what the network returns.
 *
 * Why this file exists: `fetch(...).then(r => r.json() as T)` is a compile-time
 * fiction. TypeScript believes the cast; the runtime guarantees nothing. If the
 * bridge renames a field, returns `null` where a string was expected, or drops a
 * key, the bad value propagates deep into the UI and surfaces as a crash far from
 * its cause. These Zod schemas validate at the one boundary we do not control —
 * the network — and, for the simpler shapes, are the source the TypeScript types
 * are *inferred* from (`z.infer`), so the contract is declared exactly once.
 *
 * This module is deliberately a LEAF: it imports only `zod`. Nothing app-level is
 * imported here, so `types.ts` can safely `z.infer` from these schemas without a
 * circular import (`types → schemas`, never the reverse).
 *
 * Two tiers of schema live here:
 *   1. Fully-inferred contracts (Skill, Tool, Memory, …) — the schema `.transform`s
 *      the raw wire object into the exact app shape, and the app type is
 *      `z.infer<typeof …Schema>`. These replace the old hand-written `raw: any`
 *      mappers in `api.ts`. The `.transform` style (rather than `z.object` with
 *      per-field `.catch`) is used on purpose: it yields REQUIRED output keys,
 *      whereas a `.catch`-ed object field is inferred as an OPTIONAL key.
 *   2. Loose gates (`WireObjectSchema`, `WireObjectArraySchema`) — used for the
 *      complex domain objects (messages, conversations, runs, tasks) whose
 *      snake→camel mapping still lives in the proven `consts.ts` transforms. The
 *      gate only asserts "this is an object / array of objects" so a malformed
 *      body is caught before it reaches the transform.
 *
 * Defaulting policy: each mapper applies the same per-field fallback the old
 * hand-mappers used (`?? ""`, `?? null`, `Boolean(...)`), so a field-level
 * mismatch degrades gracefully instead of rejecting the whole response.
 */
import { z } from "zod";


// ---------------------------------------------------------------------------
// Loose gates — assert the container shape only. The camel-mapping for these
// domain objects stays in consts.ts (transformMessage, transformConversation…).
// ---------------------------------------------------------------------------
export const WireObjectSchema = z.record(z.unknown());
export const WireObjectArraySchema = z.array(z.record(z.unknown())).catch([]);

// A plain string list (e.g. the per-(user, agent) enabled-skill names). Non-string
// entries are coerced with String(); a non-array body degrades to [].
export const StringListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) => entries.map(String));


// ---------------------------------------------------------------------------
// Skills catalog + user pool
// ---------------------------------------------------------------------------
const toSkill = (raw: Record<string, unknown>) => ({
  name: typeof raw.name === "string" ? raw.name : "unknown-skill",
  description: typeof raw.description === "string" ? raw.description : "",
  content: typeof raw.content === "string" ? raw.content : "",
  category: typeof raw.category === "string" ? raw.category : "",
});
export const SkillSchema = z.record(z.unknown()).transform(toSkill);
export const SkillListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => rows.map((row) => toSkill(row as Record<string, unknown>)));
export type Skill = z.infer<typeof SkillSchema>;

// Anything that is not exactly "custom" is a global reference — mirrors the old
// `raw.type === "custom" ? "custom" : "global"`. `source_path` is opaque on the
// frontend (only the agents service reads it) and kept snake_case.
const toUserSkill = (raw: Record<string, unknown>) => ({
  name: typeof raw.name === "string" ? raw.name : "unknown-skill",
  type: (raw.type === "custom" ? "custom" : "global") as "global" | "custom",
  description: typeof raw.description === "string" ? raw.description : "",
  source_path: typeof raw.source_path === "string" ? raw.source_path : "",
  category: typeof raw.category === "string" ? raw.category : "",
});
export const UserSkillSchema = z.record(z.unknown()).transform(toUserSkill);
export const UserSkillListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => rows.map((row) => toUserSkill(row as Record<string, unknown>)));
export type UserSkill = z.infer<typeof UserSkillSchema>;

// One file inside a skill folder. `path` is relative to the skill root and
// "/"-separated; `content` is UTF-8 text or base64 for binary assets. `size` is
// the decoded byte length — present on reads, omitted on create, so it stays an
// optional key (hence the explicit return annotation).
const toSkillFile = (
  raw: Record<string, unknown>,
): { path: string; content: string; encoding: "utf-8" | "base64"; size?: number } => ({
  path: typeof raw.path === "string" ? raw.path : "",
  content: typeof raw.content === "string" ? raw.content : "",
  encoding: raw.encoding === "base64" ? "base64" : "utf-8",
  size: typeof raw.size === "number" ? raw.size : undefined,
});
export const SkillFileSchema = z.record(z.unknown()).transform(toSkillFile);
export type SkillFile = z.infer<typeof SkillFileSchema>;

// User-pool entry joined with its file inventory. `content` is the SKILL.md body
// (quick preview); `files` is the full on-disk tree with path-less entries dropped.
export const UserSkillDetailSchema = z.record(z.unknown()).transform((raw) => ({
  ...toUserSkill(raw),
  content: typeof raw.content === "string" ? raw.content : "",
  files: Array.isArray(raw.files)
    ? raw.files.map((f) => toSkillFile(f as Record<string, unknown>)).filter((f) => f.path)
    : [],
}));
export type UserSkillDetail = z.infer<typeof UserSkillDetailSchema>;

// ---------------------------------------------------------------------------
// User-authored agents (the agent builder) — /v1/agents/{user}/custom
// ---------------------------------------------------------------------------
// One file inside an agent folder: a prompt, not a payload. Same shape as a
// skill file, kept separate because the allowlist is narrower server-side.
const toAgentFile = (
  raw: Record<string, unknown>,
): { path: string; content: string; encoding: "utf-8" | "base64"; size?: number } => ({
  path: typeof raw.path === "string" ? raw.path : "",
  content: typeof raw.content === "string" ? raw.content : "",
  encoding: raw.encoding === "base64" ? "base64" : "utf-8",
  size: typeof raw.size === "number" ? raw.size : undefined,
});
export const AgentFileSchema = z.record(z.unknown()).transform(toAgentFile);
export type AgentFile = z.infer<typeof AgentFileSchema>;

// A user-authored agent's full definition. `spec` is the agent.yaml document,
// passed through opaquely — the backend owns its schema, so validating its shape
// here would only create a second contract to keep in sync.
export const CustomAgentDetailSchema = z.record(z.unknown()).transform((raw) => ({
  id: typeof raw.id === "string" ? raw.id : "",
  slug: typeof raw.slug === "string" ? raw.slug : "",
  name: typeof raw.name === "string" ? raw.name : "",
  description: typeof raw.description === "string" ? raw.description : "",
  icon: typeof raw.icon === "string" ? raw.icon : "",
  version: typeof raw.version === "string" ? raw.version : undefined,
  type: typeof raw.type === "string" ? raw.type : "deep agent",
  spec: (raw.spec ?? {}) as Record<string, unknown>,
  files: Array.isArray(raw.files)
    ? raw.files.map((f) => toAgentFile(f as Record<string, unknown>)).filter((f) => f.path)
    : [],
}));
export type CustomAgentDetail = z.infer<typeof CustomAgentDetailSchema>;

// Dry-run result. `valid` defaults false so a malformed response fails closed —
// the builder must never enable Save because validation returned nonsense.
export const CustomAgentValidationSchema = z.object({
  valid: z.boolean().catch(false),
  errors: z.array(z.string()).catch([]),
});
export type CustomAgentValidation = z.infer<typeof CustomAgentValidationSchema>;


// ---------------------------------------------------------------------------
// Agent long-term memory (snake_case wire → camelCase app)
// ---------------------------------------------------------------------------
const toMemorySummary = (raw: Record<string, unknown>) => ({
  name: String(raw.name ?? ""),
  summary: typeof raw.summary === "string" ? raw.summary : "",
  createdAt: (raw.createdAt ?? raw.created_at ?? null) as string | null,
  updatedAt: (raw.updatedAt ?? raw.updated_at ?? null) as string | null,
  sourceConversationId: (raw.sourceConversationId ?? raw.source_conversation_id ?? null) as
    | string
    | null,
});

export const MemorySummarySchema = z.record(z.unknown()).transform(toMemorySummary);
export const MemorySummaryListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => rows.map((row) => toMemorySummary(row as Record<string, unknown>)));
export type MemorySummary = z.infer<typeof MemorySummarySchema>;

export const MemoryDetailSchema = z.record(z.unknown()).transform((raw) => ({
  ...toMemorySummary(raw),
  content: typeof raw.content === "string" ? raw.content : "",
}));
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;


// ---------------------------------------------------------------------------
// Tools catalog (snake_case wire → camelCase app)
// ---------------------------------------------------------------------------
const toToolMetadata = (raw: Record<string, unknown>) => ({
  serverId: typeof raw.server_id === "string" ? raw.server_id : "",
  toolName: typeof raw.tool_name === "string" ? raw.tool_name : "unknown-tool",
  description: typeof raw.description === "string" ? raw.description : "",
  parameterCount: Number.isFinite(raw.parameter_count) ? Math.max(0, Number(raw.parameter_count)) : 0,
});
export const ToolMetadataSchema = z.record(z.unknown()).transform(toToolMetadata);
export const ToolMetadataListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => rows.map((row) => toToolMetadata(row as Record<string, unknown>)));
export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;


// ---------------------------------------------------------------------------
// Per-agent tools (Agents tab) — GET/POST /v1/agents/{user}/{slug}/tools
// ---------------------------------------------------------------------------
export const AgentToolRowSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().catch(""),
  source: z.string(), // "native" | "mcp"
  declared: z.boolean().catch(true), // baseline tool vs an available gateway tool
  disabled: z.boolean(),
});
export const AgentToolsResponseSchema = z.object({
  agentSlug: z.string(),
  tools: z.array(AgentToolRowSchema).catch([]),
});
export type AgentToolRow = z.infer<typeof AgentToolRowSchema>;
export type AgentToolsResponse = z.infer<typeof AgentToolsResponseSchema>;


// ---------------------------------------------------------------------------
// Catalog suggestions — { suggestions: string[] } → filtered string[]
// ---------------------------------------------------------------------------
export const SuggestionsSchema = z
  .object({ suggestions: z.array(z.unknown()).catch([]) })
  .catch({ suggestions: [] })
  .transform((data) =>
    data.suggestions.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ),
  );


// ---------------------------------------------------------------------------
// Attachment preview token (DOCX) — accept camel or snake, default safely.
// ---------------------------------------------------------------------------
export const DocxPreviewTokenSchema = z.record(z.unknown()).transform((raw) => ({
  token: typeof raw.token === "string" ? raw.token : "",
  expiresIn: Number.isFinite(raw.expiresIn)
    ? Number(raw.expiresIn)
    : Number.isFinite(raw.expires_in)
      ? Number(raw.expires_in)
      : 0,
}));
export type DocxPreviewTokenResponse = z.infer<typeof DocxPreviewTokenSchema>;


// ---------------------------------------------------------------------------
// Realtime voice session (WebRTC SDP answer)
// ---------------------------------------------------------------------------
export const RealtimeVoiceSessionResponseSchema = z.record(z.unknown()).transform((raw) => ({
  sdp: typeof raw.sdp === "string" ? raw.sdp : "",
  model: typeof raw.model === "string" ? raw.model : "",
  voice: typeof raw.voice === "string" ? raw.voice : "",
}));
export type RealtimeVoiceSessionResponse = z.infer<typeof RealtimeVoiceSessionResponseSchema>;


// ---------------------------------------------------------------------------
// Workspace search results
// ---------------------------------------------------------------------------
export type WorkspaceSearchResultKind = "conversation" | "message" | "file" | "agent";

const SEARCH_KINDS: readonly WorkspaceSearchResultKind[] = [
  "conversation",
  "message",
  "file",
  "agent",
];

export type WorkspaceSearchResult = {
  kind: WorkspaceSearchResultKind;
  id: string;
  conversationId?: string | null;
  agentId?: string | null;
  title: string;
  subtitle?: string | null;
  snippet?: string | null;
  updatedAt?: string | Date | null;
};

const toWorkspaceSearchResult = (raw: Record<string, unknown>): WorkspaceSearchResult => ({
  kind: SEARCH_KINDS.includes(raw.kind as WorkspaceSearchResultKind)
    ? (raw.kind as WorkspaceSearchResultKind)
    : "conversation",
  id: typeof raw.id === "string" ? raw.id : "",
  conversationId: (raw.conversationId ?? raw.conversation_id ?? null) as string | null,
  agentId: (raw.agentId ?? raw.agent_id ?? null) as string | null,
  title: typeof raw.title === "string" ? raw.title : "",
  subtitle: (raw.subtitle ?? null) as string | null,
  snippet: (raw.snippet ?? null) as string | null,
  updatedAt: (raw.updatedAt ?? raw.updated_at ?? null) as string | Date | null,
});
export const WorkspaceSearchResultSchema = z.record(z.unknown()).transform(toWorkspaceSearchResult);
export const WorkspaceSearchResultListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => rows.map((row) => toWorkspaceSearchResult(row as Record<string, unknown>)));


// ---------------------------------------------------------------------------
// Usage summary (Settings → Usage tab) — camelCase wire, defaulted per field
// ---------------------------------------------------------------------------
export type UsageWindow = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiMessages: number;
};

const toCount = (value: unknown): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;

const toUsageWindow = (raw: unknown): UsageWindow => {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: toCount(record.inputTokens),
    outputTokens: toCount(record.outputTokens),
    totalTokens: toCount(record.totalTokens),
    aiMessages: toCount(record.aiMessages),
  };
};

const toUsageSummary = (raw: Record<string, unknown>) => ({
  totals: toUsageWindow(raw.totals),
  conversations: toCount(raw.conversations),
  today: toUsageWindow(raw.today),
  last7Days: toUsageWindow(raw.last7Days),
  last30Days: toUsageWindow(raw.last30Days),
  perAgent: (Array.isArray(raw.perAgent) ? raw.perAgent : []).map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      ...toUsageWindow(record),
      agentName: typeof record.agentName === "string" && record.agentName ? record.agentName : "Unknown agent",
    };
  }),
  daily: (Array.isArray(raw.daily) ? raw.daily : []).map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      ...toUsageWindow(record),
      date: typeof record.date === "string" ? record.date : "",
    };
  }),
});

export const UsageSummarySchema = z.record(z.unknown()).transform(toUsageSummary);
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
export type UsageAgentBreakdown = UsageSummary["perAgent"][number];
export type UsageDailyPoint = UsageSummary["daily"][number];

// One account this browser is signed in to. The backend never sends a token —
// the parked credential stays server-side — so there is nothing sensitive here.
// `current` marks the active account; `expired` a parked session whose refresh
// token aged out (still listed, because vanishing silently reads as a bug).
export const AccountSummarySchema = z.record(z.unknown()).transform((raw) => ({
  id: typeof raw.id === "string" ? raw.id : "",
  username: typeof raw.username === "string" ? raw.username : "",
  email: typeof raw.email === "string" ? raw.email : undefined,
  displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
  avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : undefined,
  isActive: typeof raw.isActive === "boolean" ? raw.isActive : true,
  current: raw.current === true,
  expired: raw.expired === true,
}));
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

export const AccountListSchema = z.record(z.unknown()).transform((raw) => ({
  accounts: Array.isArray(raw.accounts)
    ? raw.accounts.map((row) => AccountSummarySchema.parse(row))
    : [],
  // Fail closed on a malformed answer: better to hide "add account" than to
  // offer an action the server will reject.
  canAddAccount: raw.canAddAccount === true,
  maxAccounts: typeof raw.maxAccounts === "number" ? raw.maxAccounts : 0,
}));
export type AccountList = z.infer<typeof AccountListSchema>;
