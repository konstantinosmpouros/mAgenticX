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

import { avatarPathFor } from "./api/paths";

// ---------------------------------------------------------------------------
// Loose gates — assert the container shape only. The camel-mapping for these
// domain objects stays in consts/transforms/ (transformMessage, transformConversation…).
// ---------------------------------------------------------------------------
export const WireObjectSchema = z.record(z.unknown());
export const WireObjectArraySchema = z.array(z.record(z.unknown())).catch([]);

// A compaction request's reply (plan 34): the status, and the answer it was
// recorded on — a raw message object, mapped by transformMessage.
export const CompactConversationResponseSchema = z.object({
  status: z.enum(["compacted", "nothing_to_compact"]),
  message: z.record(z.unknown()).nullable().catch(null),
});

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
// Where an agent in the catalog comes from: the platform's own, or one the user
// built. Sent on every row of `/catalog/agents` and `/custom`; the Agents pages
// and the chat picker split on it instead of cross-checking the `/custom` list.
export const AgentKindSchema = z.enum(["platform", "custom"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

// What `/custom?include=summary` adds to each row, for the gallery's cards. Every
// field is nullable and caught: an older bridge sends none of them, and a card
// simply leaves out what it was not told rather than showing a wrong zero.
const nullableCount = z.number().int().nonnegative().nullable().catch(null);
export const CustomAgentSummarySchema = z.object({
  model: z.string().min(1).nullable().catch(null),
  toolCount: nullableCount,
  skillCount: nullableCount,
  subagentCount: nullableCount,
});
export type CustomAgentSummary = z.infer<typeof CustomAgentSummarySchema>;

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

// ---------------------------------------------------------------------------
// agent.yaml — a user-authored agent's spec, as the UI reads it. Mirrors
// `AgentSpec` / `SubAgentSpec` / `ToolRef` / `ModelSpec` in
// agents/harness/abstractions/agent_spec.py, but deliberately looser: the
// server is the validator (it reports issues by path), this only types the
// reads so a malformed field cannot crash a page.
//
//   * Every field is optional and fails open to "absent" (`.catch(undefined)`):
//     a missing field stays missing, so a spec passed back to the server (an
//     import, a duplicate) is not given defaults it never had. The optional
//     keys are intended here, so the `.catch`-makes-it-optional gotcha above
//     does not apply.
//   * `.passthrough()` everywhere: a key the UI does not know (a newer server
//     field) survives the parse and goes back out on a save that sends the spec.
//   * Lists keep the items that parse. A sub-agent that is not an object becomes
//     `{}` rather than being dropped: the server's issue paths
//     (`subagents.0.subagents.1.name`) are indices, and must stay aligned.
// ---------------------------------------------------------------------------
const specText = z.string().optional().catch(undefined);

/** A list of `item`s with the unparseable rows left out; a non-list is absent. */
const specList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(z.unknown())
    .transform((rows) =>
      rows.flatMap((row) => {
        const parsed = item.safeParse(row);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    )
    .optional()
    .catch(undefined);

/** A `{key: value}` map keeping only the entries whose value is a `T`. */
const specMap = <T extends z.ZodTypeAny>(value: T) =>
  z
    .record(z.unknown())
    .transform((raw) =>
      Object.fromEntries(
        Object.entries(raw).flatMap(([key, v]) => {
          const parsed = value.safeParse(v);
          return parsed.success ? [[key, parsed.data as z.output<T>] as const] : [];
        }),
      ),
    )
    .optional()
    .catch(undefined);

// One entry of a `tools` list: an MCP tool (`server_id` + `tool_name`) or a
// native one (`native`). Which form it is stays the server's check.
export const AgentToolRefSchema = z
  .object({ server_id: specText, tool_name: specText, native: specText })
  .passthrough();
export type AgentToolRef = z.infer<typeof AgentToolRefSchema>;

// `model`: the main model plus an older spec's per-sub-agent overrides by name.
export const AgentModelSpecSchema = z
  .object({ main: specText, subagents: specMap(z.string()) })
  .passthrough();
export type AgentModelSpec = z.infer<typeof AgentModelSpecSchema>;

// A sub-agent, recursively. Declared by hand because a `z.lazy` self-reference
// cannot be inferred; the index signature is what `.passthrough()` keeps.
export type AgentSubAgentSpec = {
  name?: string;
  description?: string;
  prompt?: string;
  model?: string;
  tools?: AgentToolRef[];
  subagents?: AgentSubAgentSpec[];
  [key: string]: unknown;
};
export const AgentSubAgentSpecSchema: z.ZodType<AgentSubAgentSpec, z.ZodTypeDef, unknown> = z
  .object({
    name: specText,
    description: specText,
    prompt: specText,
    model: specText,
    tools: specList(AgentToolRefSchema),
    subagents: z.lazy(() => specList(AgentSubAgentSpecSchema)),
  })
  .passthrough()
  .catch({});

// The whole document. Without the final `.catch` so the import result can tell
// "no spec" (null) from "an empty one"; `AgentSpecSchema` is the caught form.
const AgentSpecObjectSchema = z
  .object({
    id: specText,
    slug: specText,
    name: specText,
    version: specText,
    type: specText,
    description: specText,
    icon: specText,
    prompt: specText,
    // An object per the server's ModelSpec; a bare id string is still read.
    model: z.union([z.string(), AgentModelSpecSchema]).optional().catch(undefined),
    memory: z.boolean().optional().catch(undefined),
    tools: specList(AgentToolRefSchema),
    skills: specList(z.string()),
    subagents: specList(AgentSubAgentSpecSchema),
    // Tools gated behind approval by default, e.g. `{write_file: true}`.
    hitl: specMap(z.boolean()),
  })
  .passthrough();

// A spec that is not an object at all reads as an empty one.
export const AgentSpecSchema = AgentSpecObjectSchema.catch({});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

// A user-authored agent's full definition. `spec` is the agent.yaml document,
// typed by `AgentSpecSchema` (fail-open, unknown keys kept).
export const CustomAgentDetailSchema = z.record(z.unknown()).transform((raw) => ({
  id: typeof raw.id === "string" ? raw.id : "",
  slug: typeof raw.slug === "string" ? raw.slug : "",
  name: typeof raw.name === "string" ? raw.name : "",
  description: typeof raw.description === "string" ? raw.description : "",
  icon: typeof raw.icon === "string" ? raw.icon : "",
  version: typeof raw.version === "string" ? raw.version : undefined,
  type: typeof raw.type === "string" ? raw.type : "deep agent",
  spec: AgentSpecSchema.parse(raw.spec),
  files: Array.isArray(raw.files)
    ? raw.files.map((f) => toAgentFile(f as Record<string, unknown>)).filter((f) => f.path)
    : [],
}));
export type CustomAgentDetail = z.infer<typeof CustomAgentDetailSchema>;

// One saved version of a user-authored agent (`/custom/{id}/versions`). `kind`
// is how it came to be: the first save, a later save, a restore of an older
// version (`restoredFrom`), or `baseline` — the agent as it was before history
// began. `changes` names the areas that save touched (details, instructions,
// model, tools, skills, team, files, settings). A row without a number is
// dropped: it could be neither shown in order nor opened.
export const AGENT_VERSION_KINDS = ["created", "saved", "restored", "baseline"] as const;
export type AgentVersionKind = (typeof AGENT_VERSION_KINDS)[number];

const toAgentVersionSummary = (raw: Record<string, unknown>) => {
  const no = raw.versionNo ?? raw.version_no;
  const from = raw.restoredFrom ?? raw.restored_from;
  const base = raw.basedOn ?? raw.based_on;
  const created = raw.createdAt ?? raw.created_at;
  return {
    versionNo: typeof no === "number" && Number.isInteger(no) ? no : 0,
    kind: ((AGENT_VERSION_KINDS as readonly string[]).includes(String(raw.kind))
      ? raw.kind
      : "saved") as AgentVersionKind,
    changes: Array.isArray(raw.changes)
      ? raw.changes.filter((c): c is string => typeof c === "string")
      : [],
    restoredFrom: typeof from === "number" ? from : null,
    basedOn: typeof base === "number" ? base : null,
    current: raw.current === true,
    createdAt: typeof created === "string" ? created : null,
  };
};
export type AgentVersionSummary = ReturnType<typeof toAgentVersionSummary>;

// The kept versions, newest first. `current` marks the agent as it is now: the
// newest, unless an older one was restored (a restore adds no version).
export const AgentVersionListSchema = z
  .array(z.unknown())
  .transform((rows) =>
    rows
      .map((row) => toAgentVersionSummary((row ?? {}) as Record<string, unknown>))
      .filter((row) => row.versionNo > 0),
  );

// One version in full: the summary plus that version's agent.yaml (`spec`,
// typed like CustomAgentDetail's) and every file it carried.
export const AgentVersionDetailSchema = z.record(z.unknown()).transform((raw) => ({
  ...toAgentVersionSummary(raw),
  spec: AgentSpecSchema.parse(raw.spec),
  files: Array.isArray(raw.files)
    ? raw.files.map((f) => toAgentFile((f ?? {}) as Record<string, unknown>)).filter((f) => f.path)
    : [],
}));
export type AgentVersionDetail = z.infer<typeof AgentVersionDetailSchema>;

// One problem with a definition, pinned to where it is: a dotted path into the
// spec (`subagents.0.subagents.1.name`), a file (`files[AGENT.md]`), or "" for
// the definition as a whole. A warning never blocks a save.
export const AgentIssueSchema = z.object({
  path: z.string().catch(""),
  message: z.string().catch(""),
  severity: z.enum(["error", "warning"]).catch("error"),
});
export type AgentIssue = z.infer<typeof AgentIssueSchema>;

// Dry-run result. `valid` defaults false so a malformed response fails closed —
// the builder must never enable Save because validation returned nonsense.
// `issues` is absent from an older bridge; `errors` alone still reads.
export const CustomAgentValidationSchema = z.object({
  valid: z.boolean().catch(false),
  errors: z.array(z.string()).catch([]),
  issues: z.array(AgentIssueSchema).catch([]),
});
export type CustomAgentValidation = z.infer<typeof CustomAgentValidationSchema>;

// An uploaded agent.yaml, parsed and checked but never saved. `spec` is what
// the YAML became — set whenever it parsed, valid or not, so the builder can
// open it to fix — and `files` the prompt files to send with it.
export const CustomAgentImportResultSchema = CustomAgentValidationSchema.extend({
  spec: AgentSpecObjectSchema.nullable().catch(null),
  files: z
    .array(z.unknown())
    .catch([])
    .transform((rows) =>
      rows.map((f) => toAgentFile((f ?? {}) as Record<string, unknown>)).filter((f) => f.path),
    ),
});
export type CustomAgentImportResult = z.infer<typeof CustomAgentImportResultSchema>;

// A draft rendered as agent.yaml text (the builder's YAML view).
export const RenderedAgentYamlSchema = z.object({ yaml: z.string().catch("") });

// The models a user agent may run on, in the server's order, with the one the
// builder preselects. Replaces the UI's own copy of the allowlist.
export const AgentModelOptionSchema = z.object({
  id: z.string(),
  label: z.string().catch(""),
  default: z.boolean().catch(false),
});
export const AgentModelOptionListSchema = z.array(AgentModelOptionSchema).catch([]);
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>;

// The built-in tools every agent has, with how each one's approval behaves:
// `hitlDefault` (asks before anyone chooses), `locked` (can't be changed:
// `execute`), `gateable` (false for `ask_user`, itself a question), `mainOnly`
// (only the top-level agent has it).
export const BuiltinToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().catch(""),
  group: z.string().catch(""),
  hitlDefault: z.boolean().catch(false),
  locked: z.boolean().catch(false),
  gateable: z.boolean().catch(true),
  mainOnly: z.boolean().catch(false),
});
export const BuiltinToolInfoListSchema = z.array(BuiltinToolInfoSchema).catch([]);
export type BuiltinToolInfo = z.infer<typeof BuiltinToolInfoSchema>;

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
// Per-agent tools (an agent's page) — GET/POST /v1/agents/{user}/{slug}/tools
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
// Usage (Settings → Usage tab, plan 33) — camelCase wire, defaulted per field
// ---------------------------------------------------------------------------
// Every page of the tab: the Overview, the conversation list and one
// conversation, the agent list and one agent. Transform-style like the rest of
// this file: a missing or malformed field becomes a safe default (0, null, [])
// rather than failing the page, and enums fall back to their neutral value.
export type UsageWindow = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiMessages: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  modelMs: number;
  modelCalls: number;
  toolCalls: number;
  /** Answers that recorded call counts and model time — the ratio denominators. */
  detailedAnswers: number;
  detailedInputTokens: number;
  /** Estimated cost in micro-USD of the priced calls (plan 41); 0 before pricing. */
  costMicros: number;
  /** Calls whose model has no price — their cost is missing, not zero. */
  unpricedCalls: number;
  /** Calls the model ended at its output limit (finish_reason "length"). */
  truncatedCalls: number;
  /** Sum of each answer's wait to its first words, over `firstTokenAnswers`. */
  firstTokenMs: number;
  /** Answers that measured a first token — the denominator for `firstTokenMs`. */
  firstTokenAnswers: number;
};

const toCount = (value: unknown): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;

const toOptionalCount = (value: unknown): number | null =>
  Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : null;

const toText = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const toUsageRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

const toUsageList = (raw: unknown): Record<string, unknown>[] =>
  Array.isArray(raw) ? raw.map(toUsageRecord) : [];

const toUsageWindow = (raw: unknown): UsageWindow => {
  const record = toUsageRecord(raw);
  return {
    inputTokens: toCount(record.inputTokens),
    outputTokens: toCount(record.outputTokens),
    totalTokens: toCount(record.totalTokens),
    aiMessages: toCount(record.aiMessages),
    cachedInputTokens: toCount(record.cachedInputTokens),
    reasoningTokens: toCount(record.reasoningTokens),
    modelMs: toCount(record.modelMs),
    modelCalls: toCount(record.modelCalls),
    toolCalls: toCount(record.toolCalls),
    detailedAnswers: toCount(record.detailedAnswers),
    detailedInputTokens: toCount(record.detailedInputTokens),
    costMicros: toCount(record.costMicros),
    unpricedCalls: toCount(record.unpricedCalls),
    truncatedCalls: toCount(record.truncatedCalls),
    firstTokenMs: toCount(record.firstTokenMs),
    firstTokenAnswers: toCount(record.firstTokenAnswers),
  };
};

// Per model and per agent × model (plan 41): cost, cut-off calls, and speed.
// `ttftCalls` and `genMs` are the denominators for the averages — only calls
// that streamed report them, so older calls never drag a speed down.
const toUsageCallMetrics = (record: Record<string, unknown>) => ({
  costMicros: toCount(record.costMicros),
  unpricedCalls: toCount(record.unpricedCalls),
  truncatedCalls: toCount(record.truncatedCalls),
  ttftMs: toCount(record.ttftMs),
  ttftCalls: toCount(record.ttftCalls),
  genMs: toCount(record.genMs),
  genOutputTokens: toCount(record.genOutputTokens),
});

// One tool's settled calls (plan 41). Metrics only — never arguments or output.
// A row without a name cannot be keyed or labelled, so it is dropped.
const toUsageToolBreakdown = (record: Record<string, unknown>) => ({
  toolName: toText(record.toolName) ?? "",
  calls: toCount(record.calls),
  errors: toCount(record.errors),
  durationMs: toCount(record.durationMs),
  outputChars: toCount(record.outputChars),
});
export type UsageToolBreakdown = ReturnType<typeof toUsageToolBreakdown>;

const toUsageTools = (raw: unknown): UsageToolBreakdown[] =>
  toUsageList(raw)
    .map(toUsageToolBreakdown)
    .filter((tool) => tool.toolName);

const toUsageSummary = (raw: Record<string, unknown>) => ({
  totals: toUsageWindow(raw.totals),
  conversations: toCount(raw.conversations),
  today: toUsageWindow(raw.today),
  last7Days: toUsageWindow(raw.last7Days),
  previous7Days: toUsageWindow(raw.previous7Days),
  last30Days: toUsageWindow(raw.last30Days),
  perAgent: toUsageList(raw.perAgent).map((record) => ({
    ...toUsageWindow(record),
    agentName: toText(record.agentName) ?? "Unknown agent",
  })),
  perModel: toUsageList(raw.perModel).map((record) => ({
    model: toText(record.model) ?? "Unknown model",
    calls: toCount(record.calls),
    inputTokens: toCount(record.inputTokens),
    cachedInputTokens: toCount(record.cachedInputTokens),
    outputTokens: toCount(record.outputTokens),
    modelMs: toCount(record.modelMs),
    ...toUsageCallMetrics(record),
  })),
  daily: toUsageList(raw.daily).map((record) => ({
    ...toUsageWindow(record),
    date: typeof record.date === "string" ? record.date : "",
  })),
  perTool: toUsageTools(raw.perTool),
  agentCount: toCount(raw.agentCount),
  nearCompactionCount: toCount(raw.nearCompactionCount),
});

export const UsageSummarySchema = z.record(z.unknown()).transform(toUsageSummary);
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
export type UsageAgentBreakdown = UsageSummary["perAgent"][number];
export type UsageModelBreakdown = UsageSummary["perModel"][number];
export type UsageDailyPoint = UsageSummary["daily"][number];

const toUsageConversationRow = (record: Record<string, unknown>) => ({
  id: toText(record.id) ?? "",
  title: toText(record.title),
  agentId: toText(record.agentId),
  agentName: toText(record.agentName),
  agentIcon: toText(record.agentIcon),
  isArchived: record.isArchived === true,
  answers: toCount(record.answers),
  inputTokens: toCount(record.inputTokens),
  cachedInputTokens: toCount(record.cachedInputTokens),
  outputTokens: toCount(record.outputTokens),
  totalTokens: toCount(record.totalTokens),
  modelCalls: toCount(record.modelCalls),
  toolCalls: toCount(record.toolCalls),
  modelMs: toCount(record.modelMs),
  contextTokens: toOptionalCount(record.contextTokens),
  contextWindow: toOptionalCount(record.contextWindow),
  updatedAt: toText(record.updatedAt),
  costMicros: toCount(record.costMicros),
  truncatedCalls: toCount(record.truncatedCalls),
});

export const UsageConversationPageSchema = z.record(z.unknown()).transform((raw) => {
  const priv = raw.private ? toUsageRecord(raw.private) : null;
  return {
    items: toUsageList(raw.items).map(toUsageConversationRow).filter((row) => row.id),
    nextCursor: toText(raw.nextCursor),
    private: priv
      ? {
          conversations: toCount(priv.conversations),
          answers: toCount(priv.answers),
          totalTokens: toCount(priv.totalTokens),
        }
      : null,
  };
});
export type UsageConversationPage = z.infer<typeof UsageConversationPageSchema>;
export type UsageConversationRow = UsageConversationPage["items"][number];

const toUsageAgentGroup = (record: Record<string, unknown>) => ({
  // "compaction": the summary calls that compacted a conversation (plan 34).
  scope:
    record.scope === "subagent" || record.scope === "compaction"
      ? (record.scope as "subagent" | "compaction")
      : ("main" as const),
  agentId: toText(record.agentId),
  agentName: toText(record.agentName) ?? "Agent",
  model: toText(record.model),
  calls: toCount(record.calls),
  inputTokens: toCount(record.inputTokens),
  cachedInputTokens: toCount(record.cachedInputTokens),
  outputTokens: toCount(record.outputTokens),
  reasoningTokens: toCount(record.reasoningTokens),
  modelMs: toCount(record.modelMs),
  ...toUsageCallMetrics(record),
});
export type UsageAgentGroup = ReturnType<typeof toUsageAgentGroup>;

export const UsageConversationDetailSchema = z.record(z.unknown()).transform((raw) => ({
  id: toText(raw.id) ?? "",
  title: toText(raw.title),
  isArchived: raw.isArchived === true,
  answers: toCount(raw.answers),
  replaced: toCount(raw.replaced),
  inputTokens: toCount(raw.inputTokens),
  cachedInputTokens: toCount(raw.cachedInputTokens),
  outputTokens: toCount(raw.outputTokens),
  totalTokens: toCount(raw.totalTokens),
  modelCalls: toCount(raw.modelCalls),
  toolCalls: toCount(raw.toolCalls),
  modelMs: toCount(raw.modelMs),
  detailedAnswers: toCount(raw.detailedAnswers),
  detailedInputTokens: toCount(raw.detailedInputTokens),
  callsComplete: raw.callsComplete !== false,
  costMicros: toCount(raw.costMicros),
  unpricedCalls: toCount(raw.unpricedCalls),
  truncatedCalls: toCount(raw.truncatedCalls),
  groups: toUsageList(raw.groups).map(toUsageAgentGroup),
  tools: toUsageTools(raw.tools),
  branch: toUsageList(raw.branch).map((record) => ({
    id: toText(record.id) ?? "",
    createdAt: toText(record.createdAt),
    agentName: toText(record.agentName),
    model: toText(record.model),
    inputTokens: toCount(record.inputTokens),
    outputTokens: toCount(record.outputTokens),
    cachedInputTokens: toCount(record.cachedInputTokens),
    modelCalls: toOptionalCount(record.modelCalls),
    toolCalls: toOptionalCount(record.toolCalls),
    modelMs: toOptionalCount(record.modelMs),
    contextTokens: toOptionalCount(record.contextTokens),
    contextWindow: toOptionalCount(record.contextWindow),
    compactionPercent: Number.isFinite(record.compactionPercent) ? Number(record.compactionPercent) : null,
    // Null for an answer from before plan 41 (or one that spent nothing), so
    // the row can leave the figure out instead of claiming "$0.00".
    costMicros: toOptionalCount(record.costMicros),
    unpricedCalls: toOptionalCount(record.unpricedCalls),
    truncatedCalls: toOptionalCount(record.truncatedCalls),
    firstTokenMs: toOptionalCount(record.firstTokenMs),
  })),
  branchTruncated: raw.branchTruncated === true,
}));
export type UsageConversationDetail = z.infer<typeof UsageConversationDetailSchema>;
export type UsageAnswerPoint = UsageConversationDetail["branch"][number];

const USAGE_AGENT_KINDS = ["platform", "custom", "deleted"] as const;
export type UsageAgentKind = (typeof USAGE_AGENT_KINDS)[number];

const toUsageAgentEntity = (record: Record<string, unknown>) => ({
  key: toText(record.key) ?? "",
  agentId: toText(record.agentId),
  name: toText(record.name) ?? "Unknown agent",
  icon: toText(record.icon),
  kind: (USAGE_AGENT_KINDS as readonly string[]).includes(String(record.kind))
    ? (record.kind as UsageAgentKind)
    : ("deleted" as UsageAgentKind),
  engine: toText(record.engine),
  version: toText(record.version),
  isActive: record.isActive !== false,
  createdAt: toText(record.createdAt),
  answers: toCount(record.answers),
  conversations: toCount(record.conversations),
  inputTokens: toCount(record.inputTokens),
  cachedInputTokens: toCount(record.cachedInputTokens),
  outputTokens: toCount(record.outputTokens),
  totalTokens: toCount(record.totalTokens),
  modelMs: toCount(record.modelMs),
  modelCalls: toCount(record.modelCalls),
  toolCalls: toCount(record.toolCalls),
  detailedAnswers: toCount(record.detailedAnswers),
  detailedInputTokens: toCount(record.detailedInputTokens),
  costMicros: toCount(record.costMicros),
  truncatedCalls: toCount(record.truncatedCalls),
  lastUsedAt: toText(record.lastUsedAt),
  subagents: (Array.isArray(record.subagents) ? record.subagents : []).filter(
    (name): name is string => typeof name === "string",
  ),
  models: (Array.isArray(record.models) ? record.models : []).filter(
    (name): name is string => typeof name === "string",
  ),
});
export type UsageAgentEntity = ReturnType<typeof toUsageAgentEntity>;

export const UsageAgentListSchema = z.record(z.unknown()).transform((raw) => ({
  items: toUsageList(raw.items).map(toUsageAgentEntity).filter((agent) => agent.key),
}));
export type UsageAgentList = z.infer<typeof UsageAgentListSchema>;

export const UsageAgentDetailSchema = z.record(z.unknown()).transform((raw) => ({
  agent: toUsageAgentEntity(toUsageRecord(raw.agent)),
  groups: toUsageList(raw.groups).map(toUsageAgentGroup),
  tools: toUsageTools(raw.tools),
  daily: toUsageList(raw.daily).map((record) => ({
    ...toUsageWindow(record),
    date: typeof record.date === "string" ? record.date : "",
  })),
  topConversations: toUsageList(raw.topConversations)
    .map((record) => ({
      id: toText(record.id) ?? "",
      title: toText(record.title),
      totalTokens: toCount(record.totalTokens),
      answers: toCount(record.answers),
    }))
    .filter((conversation) => conversation.id),
}));
export type UsageAgentDetail = z.infer<typeof UsageAgentDetailSchema>;

// One account this browser is signed in to. The backend never sends a token —
// the parked credential stays server-side — so there is nothing sensitive here.
// `current` marks the active account; `expired` a parked session whose refresh
// token aged out (still listed, because vanishing silently reads as a bug).
export const AccountSummarySchema = z.record(z.unknown()).transform((raw) => ({
  id: typeof raw.id === "string" ? raw.id : "",
  username: typeof raw.username === "string" ? raw.username : "",
  email: typeof raw.email === "string" ? raw.email : undefined,
  displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
  // The user's own photo wins over a provider URL.
  avatarUrl:
    avatarPathFor(typeof raw.id === "string" ? raw.id : "", raw.avatarUpdatedAt) ??
    (typeof raw.avatarUrl === "string" ? raw.avatarUrl : undefined),
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

// ---------------------------------------------------------------------------
// Delete account (plan 32)
// ---------------------------------------------------------------------------
const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : null;

// An account scheduled for deletion, as `/auth/session` reports it. Null unless
// both dates are present and valid — a half-formed value must never put the
// user on the pending-deletion screen.
export const PendingDeletionSchema = z.unknown().transform((raw) => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const requestedAt = isoOrNull(record.requestedAt);
  const scheduledFor = isoOrNull(record.scheduledFor);
  if (!requestedAt || !scheduledFor) return null;
  return { requestedAt, scheduledFor, inProgress: record.inProgress === true };
});
export type PendingDeletion = NonNullable<z.infer<typeof PendingDeletionSchema>>;

// Everything the Delete account card and the pending screen need. Fails safe:
// a missing flag reads as "re-authentication required" and "not enabled".
export const AccountDeletionStatusSchema = z.record(z.unknown()).transform((raw) => ({
  enabled: raw.enabled === true,
  pending: raw.pending === true,
  requestedAt: isoOrNull(raw.requestedAt),
  scheduledFor: isoOrNull(raw.scheduledFor),
  inProgress: raw.inProgress === true,
  graceDays: typeof raw.graceDays === "number" && raw.graceDays > 0 ? raw.graceDays : 14,
  reauthRequired: raw.reauthRequired !== false,
  confirmWith: typeof raw.confirmWith === "string" ? raw.confirmWith : "",
}));
export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatusSchema>;

// One slash command in the composer's "/" menu (plan 35). Fails safe: a row
// without a usable name or kind is dropped, and anything unclear reads as
// unavailable — the server refuses an unavailable command anyway.
const SlashCommandSchema = z.record(z.unknown()).transform((raw) => {
  const name = typeof raw.name === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(raw.name) ? raw.name : null;
  const kind = raw.kind === "action" || raw.kind === "prompt" ? raw.kind : null;
  if (!name || !kind) return null;
  return {
    name,
    kind,
    description: typeof raw.description === "string" ? raw.description : "",
    argumentHint: typeof raw.argumentHint === "string" ? raw.argumentHint : "",
    readOnly: raw.readOnly === true,
    source: typeof raw.source === "string" ? raw.source : "builtin",
    available: raw.available === true,
    unavailableReason: typeof raw.unavailableReason === "string" ? raw.unavailableReason : null,
  };
});
export type SlashCommand = NonNullable<z.infer<typeof SlashCommandSchema>>;

export const SlashCommandListSchema = z
  .record(z.unknown())
  .transform((raw) =>
    (Array.isArray(raw.commands) ? raw.commands : [])
      .map((row) => SlashCommandSchema.safeParse(row))
      .flatMap((parsed) => (parsed.success && parsed.data ? [parsed.data] : [])),
  )
  .catch([]);

// ---------------------------------------------------------------------------
// Workflows (plan 38): definitions, the node catalogue, runs and their events.
//
// The bridge already camelCases every field; these mappers default each one so
// a field-level mismatch degrades instead of rejecting the response, and they
// keep the hand-written view types in `types/workflows.ts` honest — the API
// module annotates its return types with those, so a mapper that drifts from
// them fails the typecheck. `.transform` (not per-field `.catch`) on purpose:
// it keeps every output key required.
// ---------------------------------------------------------------------------
const WORKFLOW_RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
const WORKFLOW_FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;

const wfRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const wfRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)).map(wfRecord) : [];
const wfString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const wfNullableString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;
const wfNullableInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;
const wfOneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const wfFieldType = (value: unknown) => wfOneOf(WORKFLOW_FIELD_TYPES, value, "string");

const toWorkflowSpec = (raw: unknown) => {
  const spec = wfRecord(raw);
  return {
    version: 1 as const,
    name: wfString(spec.name),
    ...(typeof spec.description === "string" ? { description: spec.description } : {}),
    inputs: wfRecords(spec.inputs).map((input) => ({
      name: wfString(input.name),
      type: wfFieldType(input.type),
      ...(typeof input.required === "boolean" ? { required: input.required } : {}),
      ...("default" in input ? { default: input.default } : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
    })),
    // No `state` (variables are the names Set steps write) and no node `assign`:
    // a spec stored before that still reads, without them.
    nodes: wfRecords(spec.nodes).map((node) => {
      const position = wfRecord(node.position);
      const { assign: _assign, ...config } = wfRecord(node.config);
      return {
        id: wfString(node.id),
        kind: wfString(node.kind),
        label: wfNullableString(node.label),
        config,
        position: {
          x: typeof position.x === "number" ? position.x : 0,
          y: typeof position.y === "number" ? position.y : 0,
        },
      };
    }),
    edges: wfRecords(spec.edges).map((edge) => ({
      id: wfString(edge.id),
      source: wfString(edge.source),
      target: wfString(edge.target),
      branch: wfNullableString(edge.branch),
    })),
  };
};

const WORKFLOW_SCHEDULE_STATUSES = ["active", "paused", "finished"] as const;

// A workflow's schedule, from its `trigger.schedule` start node — absent (or
// null) for a workflow that is only started by hand. Read leniently: an older
// bridge sends no `schedule` at all.
const readWorkflowSchedule = (schedule: Record<string, unknown>) => ({
  status: wfOneOf(WORKFLOW_SCHEDULE_STATUSES, schedule.status, "active"),
  kind: wfString(schedule.kind),
  spec: wfRecord(schedule.spec),
  timezone: wfNullableString(schedule.timezone),
  nextRunAt: wfNullableString(schedule.nextRunAt),
  lastRunAt: wfNullableString(schedule.lastRunAt),
  lastRunStatus: wfNullableString(schedule.lastRunStatus),
});
const toWorkflowSchedule = (raw: unknown) =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? readWorkflowSchedule(wfRecord(raw)) : null;
/** `POST …/schedule/pause|resume`: the schedule as it now stands (`WorkflowScheduleOut`). */
export const WorkflowScheduleSchema = z.record(z.unknown()).transform(readWorkflowSchedule);

const toWorkflow = (raw: Record<string, unknown>) => ({
  id: wfString(raw.id),
  name: wfString(raw.name, "Untitled workflow"),
  description: wfNullableString(raw.description),
  spec: raw.spec && typeof raw.spec === "object" ? toWorkflowSpec(raw.spec) : null,
  latestVersionNo: wfNullableInt(raw.latestVersionNo),
  createdAt: wfNullableString(raw.createdAt),
  updatedAt: wfNullableString(raw.updatedAt),
  // Only when the bridge sends one, so a summary without it reads as before.
  ...("schedule" in raw ? { schedule: toWorkflowSchedule(raw.schedule) } : {}),
});
export const WorkflowSchema = z.record(z.unknown()).transform(toWorkflow);
export const WorkflowListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) => wfRecords(rows).map(toWorkflow).filter((workflow) => workflow.id));

// A workflow's history (kept versions). Every field is read here, or the
// panel never sees it: a new one must be added to these mappers.
const wfInt = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isInteger(value) ? value : fallback;
const toWorkflowVersionSummary = (raw: Record<string, unknown>) => ({
  versionNo: wfInt(raw.versionNo),
  createdAt: wfNullableString(raw.createdAt),
  createdBy: wfString(raw.createdBy),
  restoredFrom: wfNullableInt(raw.restoredFrom),
  name: wfString(raw.name),
  description: wfString(raw.description),
  nodeCount: wfInt(raw.nodeCount),
  edgeCount: wfInt(raw.edgeCount),
});
/** `GET …/versions`: newest first; rows without a usable number are dropped. */
export const WorkflowVersionPageSchema = z.record(z.unknown()).transform((raw) => ({
  items: wfRecords(raw.items)
    .map(toWorkflowVersionSummary)
    .filter((version) => version.versionNo > 0),
  nextBefore: wfNullableInt(raw.nextBefore),
}));
/** `GET …/versions/{n}`: one version with its spec. */
export const WorkflowVersionDetailSchema = z.record(z.unknown()).transform((raw) => ({
  versionNo: wfInt(raw.versionNo),
  createdAt: wfNullableString(raw.createdAt),
  createdBy: wfString(raw.createdBy),
  restoredFrom: wfNullableInt(raw.restoredFrom),
  spec: toWorkflowSpec(raw.spec),
}));

const toWorkflowNodeKind = (raw: Record<string, unknown>) => ({
  kind: wfString(raw.kind),
  label: wfString(raw.label, wfString(raw.kind)),
  group: wfString(raw.group, "other"),
  description: wfString(raw.description),
  branches: Array.isArray(raw.branches) ? raw.branches.filter((b): b is string => typeof b === "string") : [],
  dynamicBranches: raw.dynamicBranches === true,
  isTrigger: raw.isTrigger === true,
  configSchema: wfRecord(raw.configSchema),
  // Absent on an older catalogue: every kind it lists is runnable.
  available: raw.available !== false,
  unavailableReason: raw.available === false ? wfNullableString(raw.unavailableReason) : null,
});
// The catalogue is passed through from the engine: a bare list of kinds, or an
// object holding it under `kinds` / `nodes` — either is accepted.
export const WorkflowCatalogSchema = z
  .unknown()
  .transform((raw) => {
    const rows = Array.isArray(raw) ? raw : wfRecord(raw).kinds ?? wfRecord(raw).nodes;
    return wfRecords(rows).map(toWorkflowNodeKind).filter((kind) => kind.kind);
  });

// `GET /v1/workflows/tools`: the tools a tool step may call. A tool's
// `inputSchema` is the MCP server's own JSON Schema: kept as a record and read
// defensively where it is used (`lib/builder/toolArgs`); rows without a name
// are dropped.
const WORKFLOW_TOOL_SOURCES = ["native", "mcp"] as const;
const toWorkflowTool = (raw: Record<string, unknown>) => ({
  source: wfOneOf(WORKFLOW_TOOL_SOURCES, raw.source, "mcp"),
  name: wfString(raw.name),
  server: wfNullableString(raw.server),
  description: wfString(raw.description),
  inputSchema: wfRecord(raw.inputSchema),
});
export const WorkflowToolCatalogSchema = z.record(z.unknown()).transform((raw) => ({
  mcpAvailable: raw.mcpAvailable !== false,
  tools: wfRecords(raw.tools)
    .map(toWorkflowTool)
    .filter((tool) => tool.name),
}));

const toWorkflowRun = (raw: Record<string, unknown>) => ({
  id: wfString(raw.id),
  workflowId: wfString(raw.workflowId),
  workflowName: wfString(raw.workflowName),
  versionNo: wfNullableInt(raw.versionNo),
  triggerKind: wfString(raw.triggerKind, "manual"),
  status: wfOneOf(WORKFLOW_RUN_STATUSES, raw.status, "failed"),
  error: wfNullableString(raw.error),
  eventCount: typeof raw.eventCount === "number" ? raw.eventCount : 0,
  startedAt: wfString(raw.startedAt),
  finishedAt: wfNullableString(raw.finishedAt),
  createdAt: wfString(raw.createdAt),
  updatedAt: wfString(raw.updatedAt),
});
export const WorkflowRunSchema = z.record(z.unknown()).transform(toWorkflowRun);

export const WorkflowRunPageSchema = z.record(z.unknown()).transform((raw) => ({
  items: wfRecords(raw.items).map(toWorkflowRun).filter((run) => run.id),
  nextCursor: wfNullableString(raw.nextCursor),
}));

/** One persisted run event; null when it has no usable `seq` (dropped by callers). */
export const toWorkflowRunEvent = (raw: unknown) => {
  const event = wfRecord(raw);
  if (typeof event.seq !== "number" || !Number.isInteger(event.seq)) return null;
  return {
    seq: event.seq,
    type: wfString(event.type),
    nodeId: wfNullableString(event.nodeId),
    executionId: wfNullableString(event.executionId),
    parentExecutionId: wfNullableString(event.parentExecutionId),
    payload: wfRecord(event.payload),
    createdAt: wfString(event.createdAt),
  };
};
const toWorkflowRunEvents = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((row) => {
    const event = toWorkflowRunEvent(row);
    return event ? [event] : [];
  });

export const WorkflowRunDetailSchema = z.record(z.unknown()).transform((raw) => ({
  run: toWorkflowRun(wfRecord(raw.run)),
  inputs: wfRecord(raw.inputs),
  events: toWorkflowRunEvents(raw.events),
  hasMoreEvents: raw.hasMoreEvents === true,
}));

export const WorkflowRunStartedSchema = z.record(z.unknown()).transform((raw) => ({
  runId: wfString(raw.runId),
}));

/**
 * A spec's issues, from `POST /v1/workflows/validate` or the `detail.errors`
 * of a 422 on create/update. Rows without a message are dropped.
 */
export const toWorkflowValidationIssues = (value: unknown) =>
  wfRecords(value)
    .map((issue) => ({
      nodeId: wfNullableString(issue.nodeId ?? issue.node_id),
      path: wfString(issue.path),
      message: wfString(issue.message),
    }))
    .filter((issue) => issue.message);

export const WorkflowValidationSchema = z.record(z.unknown()).transform((raw) => {
  const errors = toWorkflowValidationIssues(raw.errors);
  return { ok: raw.ok === true && errors.length === 0, errors };
});

/** One `data:` frame of the run event stream; null for anything unrecognised. */
export const toWorkflowRunStreamFrame = (raw: unknown) => {
  const frame = wfRecord(raw);
  if (frame.type === "status") {
    const run = toWorkflowRun(wfRecord(frame.run));
    return run.id ? { type: "status" as const, run } : null;
  }
  if (frame.type === "event") {
    const event = toWorkflowRunEvent(frame.event);
    return event ? { type: "event" as const, event } : null;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Async sub-agent tasks (plan 41 §14) — every sub-agent runs as a background
// task with its own lifecycle, outliving the run that started it. The bridge
// sends these over REST (`GET …/tasks`, cancel, resume) and over two sockets:
// the conversation channel (tree changes, runs the client did not start, the
// composer queue) and one socket per task (that node's live AG-UI events).
// Read leniently and in either casing — the bridge's DTOs mix snake_case and
// camelCase — and `.transform`, so every output key stays required.
// ---------------------------------------------------------------------------
export const ASYNC_TASK_STATUSES = [
  "pending",
  "running",
  "waiting_children",
  "waiting",
  "success",
  "error",
  "cancelled",
] as const;
export type AsyncTaskStatus = (typeof ASYNC_TASK_STATUSES)[number];
/** The three statuses a task can rest in; anything else is still working. */
export const SETTLED_ASYNC_TASK_STATUSES: readonly AsyncTaskStatus[] = [
  "success",
  "error",
  "cancelled",
];
export const ASYNC_TASK_FRAME_EVENTS = ["TASK_STARTED", "TASK_STATUS", "TASK_SETTLED"] as const;
export type AsyncTaskFrameEvent = (typeof ASYNC_TASK_FRAME_EVENTS)[number];

// The first of `keys` the object carries (snake first, camel second).
const atField = (raw: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
};
// An ISO timestamp (or epoch ms) as epoch ms; null when absent or unparseable.
const atEpochMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const atCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
// The bridge caps `result_preview` at 2000 characters (§14.1); the UI holds the
// same bound so an over-long body never reaches the DOM whole.
const RESULT_PREVIEW_MAX = 2000;

const toAsyncTask = (raw: Record<string, unknown>) => {
  const usage = wfRecord(raw.usage);
  const preview = wfNullableString(atField(raw, "result_preview", "resultPreview"));
  const depth = atField(raw, "depth");
  return {
    taskId: wfString(atField(raw, "task_id", "taskId")),
    conversationId: wfString(atField(raw, "conversation_id", "conversationId")),
    parentTaskId: wfNullableString(atField(raw, "parent_task_id", "parentTaskId")),
    rootRunId: wfString(atField(raw, "root_run_id", "rootRunId")),
    branchThreadId: wfString(atField(raw, "branch_thread_id", "branchThreadId")),
    spawnedByMessageId: wfNullableString(
      atField(raw, "spawned_by_message_id", "spawnedByMessageId"),
    ),
    depth: typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 1,
    name: wfString(raw.name, "sub-agent") || "sub-agent",
    subagentPath: wfString(atField(raw, "subagent_path", "subagentPath")),
    description: wfString(raw.description),
    model: wfNullableString(raw.model),
    // An unknown status reads as working, never as settled: a task the UI
    // wrongly believed finished would lose its Stop button.
    status: wfOneOf(ASYNC_TASK_STATUSES, raw.status, "running"),
    resultPreview: preview ? preview.slice(0, RESULT_PREVIEW_MAX) : null,
    error: wfNullableString(raw.error),
    usage: {
      inputTokens: atCount(atField(usage, "input_tokens", "inputTokens")),
      outputTokens: atCount(atField(usage, "output_tokens", "outputTokens")),
    },
    startedAt: atEpochMs(atField(raw, "started_at", "startedAt")),
    settledAt: atEpochMs(atField(raw, "settled_at", "settledAt")),
  };
};
/** One `TaskOut` (cancel / resume answers). */
export const AsyncTaskSchema = z.record(z.unknown()).transform(toAsyncTask);
/** `GET …/tasks`: the conversation's tree, flat; rows without an id are dropped. */
export const AsyncTaskListSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows) =>
    wfRecords(rows)
      .map(toAsyncTask)
      .filter((task) => task.taskId),
  );
export type AsyncTask = z.infer<typeof AsyncTaskSchema>;

/**
 * The one queued composer message (plan 41 §3.6). §14 leaves its shape open
 * (`{...}`); the UI reads only what the chip shows — the text, how many files
 * ride with it, its slash command — and tolerates anything else.
 */
const toQueuedMessageFields = (raw: Record<string, unknown>) => ({
  id: wfNullableString(raw.id),
  content: wfString(raw.content),
  attachmentCount: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
  commandName: wfNullableString(wfRecord(raw.command).name),
  queuedAt: atEpochMs(atField(raw, "queued_at", "queuedAt", "created_at", "createdAt")),
});
export const toQueuedMessage = (raw: unknown) =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? toQueuedMessageFields(raw as Record<string, unknown>)
    : null;
export type QueuedMessage = NonNullable<ReturnType<typeof toQueuedMessage>>;

/**
 * `POST /runs/{user}/start` with `queue_if_busy`: either a started run (the
 * usual body, mapped by the api layer) or the 202 `{queued, queued_message}`.
 */
export const InferenceStartOrQueueSchema = z.record(z.unknown()).transform((raw) =>
  raw.queued === true
    ? {
        queued: true as const,
        queuedMessage: toQueuedMessage(atField(raw, "queued_message", "queuedMessage")),
      }
    : { queued: false as const, body: raw },
);

/**
 * `messages.task_notice` (plan 41 §14.4): what the notice row of a wake-up
 * says — which task, how it ended, how long it took. Null for anything else.
 */
export const toTaskNotice = (raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const taskId = wfString(atField(record, "task_id", "taskId"));
  if (!taskId) return null;
  const duration = atField(record, "duration_ms", "durationMs");
  return {
    taskId,
    name: wfString(record.name, "sub-agent") || "sub-agent",
    status: wfOneOf(ASYNC_TASK_STATUSES, record.status, "success"),
    durationMs: typeof duration === "number" && duration >= 0 ? duration : null,
  };
};
export type TaskNotice = NonNullable<ReturnType<typeof toTaskNotice>>;

/**
 * One frame of the conversation channel, or null for anything unrecognised.
 * A `run_started` run stays a raw record here: it is a `RunOut`, mapped by the
 * same transform as every other run (in the api layer — this module imports
 * nothing app-level).
 */
export const toConversationChannelFrame = (raw: unknown) => {
  const frame = wfRecord(raw);
  if (frame.type === "task") {
    const task = toAsyncTask(wfRecord(frame.task));
    if (!task.taskId) return null;
    return {
      type: "task" as const,
      event: wfOneOf(ASYNC_TASK_FRAME_EVENTS, frame.event, "TASK_STATUS"),
      task,
    };
  }
  if (frame.type === "run_started") {
    const run = wfRecord(frame.run);
    if (typeof run.id !== "string" || !run.id) return null;
    // Extension to §14.4: whether this run is the queued message going out, so
    // the queued chip can clear on it. Optional — the `queue: null` frame
    // clears the chip either way.
    const fromQueue = frame.from_queue === true || frame.fromQueue === true;
    return { type: "run_started" as const, run, fromQueue };
  }
  if (frame.type === "queue") {
    return {
      type: "queue" as const,
      queuedMessage: toQueuedMessage(atField(frame, "queued_message", "queuedMessage")),
    };
  }
  return null;
};

/**
 * One frame of a task's own socket (the drill-down), or null. `snapshot` may
 * carry the task and its event log so far; `event` carries one AG-UI event,
 * exactly as the normalizer emits it for a top-level run, with the stream id
 * the client resumes from.
 */
export const toTaskSocketFrame = (raw: unknown) => {
  const frame = wfRecord(raw);
  const embeddedTask = () => {
    const task = toAsyncTask(wfRecord(frame.task));
    return task.taskId ? task : null;
  };
  if (frame.type === "snapshot") {
    // `events` is the whole log so far when present (a settled task, read from
    // the mirror). A live task's snapshot may carry only the task, its events
    // following as `event` frames: null then, so the node is not wiped on a
    // reconnect that resumes after `since`.
    const events = atField(frame, "events", "raw_events", "rawEvents");
    return {
      type: "snapshot" as const,
      task: embeddedTask(),
      events: Array.isArray(events)
        ? wfRecords(events).filter((event) => typeof event.type === "string")
        : null,
    };
  }
  if (frame.type === "event") {
    const event = wfRecord(frame.event);
    if (typeof event.type !== "string") return null;
    const seq = frame.seq;
    return {
      type: "event" as const,
      seq: typeof seq === "string" || typeof seq === "number" ? String(seq) : null,
      event,
    };
  }
  if (frame.type === "terminal") {
    return {
      type: "terminal" as const,
      status: ASYNC_TASK_STATUSES.includes(frame.status as AsyncTaskStatus)
        ? (frame.status as AsyncTaskStatus)
        : null,
      task: embeddedTask(),
    };
  }
  return null;
};
export type TaskSocketFrame = NonNullable<ReturnType<typeof toTaskSocketFrame>>;
