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
 *      snake→camel mapping still lives in the proven `consts/transforms/` modules. The
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
// domain objects stays in consts/transforms/ (transformMessage, transformConversation…).
// ---------------------------------------------------------------------------
export const WireObjectSchema = z.record(z.unknown());
export const WireObjectArraySchema = z.array(z.record(z.unknown())).catch([]);

// A fastapi-pagination `Page` envelope — `{ items, total, page, size, pages }` —
// unwrapped to just the rows. A bare array is accepted too: not every list
// endpoint is paginated, and these callers have always tolerated both shapes.
//
// Use this, NOT WireObjectArraySchema, for any paginated endpoint. That schema
// is `z.array(...).catch([])`, so a Page object fails its array check, hits the
// `.catch`, and yields an EMPTY LIST. Because `.catch` makes `safeParse`
// *succeed*, the dev-strict branch in http.ts never fires — the list would come
// back silently empty in every environment.
export const WirePageItemsSchema = z
  .union([
    z.array(z.record(z.unknown())),
    z.object({ items: z.array(z.record(z.unknown())).catch([]) }).transform((page) => page.items),
  ])
  .catch([]);

// ---------------------------------------------------------------------------
// Agent plan snapshot (the PLAN_SNAPSHOT AG-UI custom event payload).
//
// Lives here rather than beside the other AG-UI schemas because `RunTimeline`
// in shared/lib/types names `PlanSnapshot`, and shared/ must not import from
// features/. Keeping the schema (not a hand-copied type) in this zod-only leaf
// means the shared type stays derived from the wire contract and cannot drift.
// features/inference/agui.ts re-exports these for its own consumers.
// ---------------------------------------------------------------------------
const PlanMetadataSchema = z.record(z.string(), z.any());

export const PlanItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.object({
  content: z.string(),
  status: PlanItemStatusSchema,
  metadata: PlanMetadataSchema.nullish(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanSnapshotSchema = z.object({
  items: z.array(PlanItemSchema),
  updated_at: z.number().nullish(),
  metadata: PlanMetadataSchema.nullish(),
});
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

// A plain string list (e.g. the per-(user, agent) enabled-skill names). Non-string
// entries are coerced with String(); a non-array body degrades to [].
export const StringListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) => entries.map(String));

// ---------------------------------------------------------------------------
// Skills: the remote catalogue search + the user's pool
// ---------------------------------------------------------------------------
// An upstream link is rendered as an <a href>, so only an https URL survives —
// a `javascript:` or `data:` value from a compromised response must never
// reach the DOM as a link.
const safeHttpsUrl = (value: unknown): string | null =>
  typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) ? value : null;
const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

// Where a remote pool skill came from. `commit` is the upstream commit, or the
// artifact's `sha256:` digest for a publisher-hosted skill; `licence` is null
// for those (the publisher distributes them itself).
const toRemoteProvenance = (
  raw: unknown,
): {
  sourceId: string;
  sourceLabel: string;
  commit: string | null;
  licence: string | null;
  upstreamUrl: string | null;
} | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source_id !== "string" || !r.source_id) return null;
  return {
    sourceId: r.source_id,
    sourceLabel: typeof r.source_label === "string" ? r.source_label : r.source_id,
    commit: optionalString(r.commit),
    licence: optionalString(r.licence),
    upstreamUrl: safeHttpsUrl(r.upstream_url),
  };
};
export type RemoteProvenance = NonNullable<ReturnType<typeof toRemoteProvenance>>;

// `type` keeps the three server kinds; anything unknown reads as "global" (the
// legacy catalogue reference) rather than being promoted to something it is
// not. `source_path` is opaque on the frontend and kept snake_case.
const toUserSkill = (raw: Record<string, unknown>) => ({
  name: typeof raw.name === "string" ? raw.name : "unknown-skill",
  type: (raw.type === "custom" || raw.type === "remote" ? raw.type : "global") as
    | "global"
    | "custom"
    | "remote",
  description: typeof raw.description === "string" ? raw.description : "",
  source_path: typeof raw.source_path === "string" ? raw.source_path : "",
  category: typeof raw.category === "string" ? raw.category : "",
  provenance: toRemoteProvenance(raw.provenance),
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

// One result of the remote catalogue search. Added by (sourceId, skillId).
const toCatalogueSkill = (raw: Record<string, unknown>) => ({
  sourceId: typeof raw.source_id === "string" ? raw.source_id : "",
  sourceLabel: typeof raw.source_label === "string" ? raw.source_label : "",
  skillId: typeof raw.skill_id === "string" ? raw.skill_id : "",
  name: typeof raw.name === "string" ? raw.name : "",
  description: typeof raw.description === "string" ? raw.description : "",
  category: typeof raw.category === "string" ? raw.category : "",
  licence: optionalString(raw.licence),
  commit: optionalString(raw.commit),
  upstreamUrl: safeHttpsUrl(raw.upstream_url),
});
export type CatalogueSkill = ReturnType<typeof toCatalogueSkill>;

// A page of search results. `total` counts every match, not just this page;
// `remoteEnabled` is false when the server has remote sources switched off.
// Rows without an id are dropped: they could not be added anyway.
export const CatalogueSearchPageSchema = z.record(z.unknown()).transform((raw) => ({
  results: Array.isArray(raw.results)
    ? raw.results
        .map((row) => toCatalogueSkill((row ?? {}) as Record<string, unknown>))
        .filter((row) => row.sourceId && row.skillId)
    : [],
  total: typeof raw.total === "number" ? raw.total : 0,
  limit: typeof raw.limit === "number" ? raw.limit : 0,
  offset: typeof raw.offset === "number" ? raw.offset : 0,
  remoteEnabled: raw.remote_enabled === true,
}));
export type CatalogueSearchPage = z.infer<typeof CatalogueSearchPageSchema>;

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
    string | null,
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
  parameterCount: Number.isFinite(raw.parameter_count)
    ? Math.max(0, Number(raw.parameter_count))
    : 0,
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
  // "builtin" tools are prebuilt and always present; only their approval is
  // configurable. "mcp" tools are configurable on both axes.
  kind: z.enum(["builtin", "mcp"]).catch("mcp"),
  // Display grouping: a builtin's family, or the MCP server id.
  group: z.string().catch("mcp"),
  declared: z.boolean().catch(true),
  available: z.boolean().catch(true),
  unavailableReason: z.string().nullable().catch(null),
  enabled: z.boolean(),
  approval: z.boolean().catch(false),
  approvalLocked: z.boolean().catch(false),
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
      agentName:
        typeof record.agentName === "string" && record.agentName
          ? record.agentName
          : "Unknown agent",
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

// ---------------------------------------------------------------------------
// Tool-result image blocks
// ---------------------------------------------------------------------------
// A tool that returns an image (`read_file` on a PNG) hands back content blocks.
// The agents service replaces the original base64 with a bounded thumbnail
// before emitting — the model still gets the full image — so what arrives here
// is `preview_base64` plus the original size, or `omitted` when it could not be
// shrunk. The raw `base64` key never reaches the client.
export const ToolResultImageSchema = z.object({
  type: z.literal("image"),
  mime_type: z.string().catch("image/png"),
  preview_base64: z.string().optional(),
  bytes: z.number().optional(),
  omitted: z.boolean().catch(false),
});
export type ToolResultImage = z.infer<typeof ToolResultImageSchema>;

/**
 * Pull image blocks out of a tool result, if it is one.
 *
 * Returns an empty array for every other shape, so the caller can fall back to
 * rendering the payload as JSON. Parsing is best-effort by design: a tool
 * result is semi-trusted content and a malformed one must not throw inside a
 * message render.
 */
export const parseToolResultImages = (output: unknown): ToolResultImage[] => {
  let blocks: unknown = output;
  if (typeof output === "string") {
    if (!output.includes('"image"')) return [];
    try {
      blocks = JSON.parse(output);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    const parsed = ToolResultImageSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
};

// ---------------------------------------------------------------------------
// Export my data (plan 27)
// ---------------------------------------------------------------------------
// Whether exports are on, and when this user may start the next one.
// `availableAt` is an ISO instant while the cooldown runs, null otherwise.
// The cooldown falls back to the server's default window, one week.
export const ExportStatusSchema = z.record(z.unknown()).transform((raw) => ({
  enabled: raw.enabled === true,
  availableAt: typeof raw.availableAt === "string" && raw.availableAt ? raw.availableAt : null,
  cooldownMinutes:
    typeof raw.cooldownMinutes === "number" && raw.cooldownMinutes > 0 ? raw.cooldownMinutes : 7 * 24 * 60,
}));
export type ExportStatus = z.infer<typeof ExportStatusSchema>;

// A one-time download token. Only the URL-safe alphabet is accepted, since the
// token is placed into a download URL.
export const ExportTokenSchema = z.record(z.unknown()).transform((raw) => ({
  token: typeof raw.token === "string" && /^[A-Za-z0-9_-]+$/.test(raw.token) ? raw.token : "",
  expiresInSeconds: typeof raw.expiresInSeconds === "number" ? raw.expiresInSeconds : 0,
}));
export type ExportToken = z.infer<typeof ExportTokenSchema>;
