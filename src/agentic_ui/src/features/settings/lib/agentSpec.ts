/**
 * The `agent.yaml` shape, and the two functions that cross into and out of it.
 *
 * `buildAgentPayload` is the single place that knows the spec's structure, so
 * the builder's form fields never encode YAML; `draftFromDetail` is its inverse.
 * They live here rather than inside the builder component for two reasons: a
 * `*_parts/` file holds components only, and the pair has to round-trip
 * losslessly — an edit that quietly drops a field saves it away — which is only
 * checkable with both halves importable on their own.
 */
import type {
  AgentDraft,
  AgentDraftFile,
  AgentDraftSubAgent,
  CustomAgentDetail,
  CustomAgentWritePayload,
} from "@/shared/lib/types";

/**
 * Models a user may pick. Mirrors the agents service's ALLOWED_AGENT_MODELS;
 * the server re-validates, so a drift here surfaces as a validation error
 * rather than a broken agent.
 */
export const MODEL_CHOICES = [
  { id: "openai:gpt-5", label: "GPT-5", hint: "Most capable" },
  { id: "openai:gpt-4o", label: "GPT-4o", hint: "Balanced" },
  { id: "openai:gpt-4o-mini", label: "GPT-4o mini", hint: "Fastest" },
] as const;

/**
 * Approval gates the platform mandates, written into every spec this builder
 * saves. MUST mirror `_HITL_FLOOR` in the agents service: a gate present there
 * but missing here makes *every* save fail validation.
 *
 * These are the floor, not the whole story — which tools ask for approval
 * beyond it is a per-account choice made under Agents → Approvals, not part of
 * the definition, so that it works the same for an agent you built and one you
 * did not.
 */
export const REQUIRED_GATES = [
  "write_file",
  "edit_file",
  "execute",
  "task",
  "create_skill",
] as const;

export const PROMPT_FILE = "AGENT.md";
export const MANIFEST_FILE = "agent.yaml";
export const SUBAGENT_DIR = "subagents";

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const subagentPromptPath = (name: string) =>
  `${SUBAGENT_DIR}/${slugify(name) || "subagent"}.md`;

export const emptyDraft = (): AgentDraft => ({
  slug: "",
  name: "",
  description: "",
  icon: "Bot",
  model: MODEL_CHOICES[1].id,
  prompt: "",
  memory: true,
  tools: [],
  skills: [],
  subagents: [],
  files: [],
});

/** One MCP entry in the spec's `tools` list. A native ref has neither field. */
type SpecToolRef = { server_id?: unknown; tool_name?: unknown; native?: unknown };
type SpecSubAgent = { name?: unknown; description?: unknown; prompt?: unknown };

/**
 * Assemble the agent.yaml document + its prompt files from the draft.
 *
 * `version` is fixed at 1.0.0 for a first release and `id` is derived from the
 * slug — neither is a user concern.
 */
export const buildAgentPayload = (draft: AgentDraft): CustomAgentWritePayload => {
  const named = draft.subagents.filter((sa) => sa.name.trim() && sa.prompt.trim());
  // Files the form owns, written from the draft's prompt fields.
  const generated: AgentDraftFile[] = [
    { path: PROMPT_FILE, content: draft.prompt },
    ...named.map((sa) => ({ path: subagentPromptPath(sa.name), content: sa.prompt })),
  ];
  // Generated paths win: a reference file can never shadow a prompt the form is
  // responsible for, however the draft got into that state.
  const owned = new Set(generated.map((file) => file.path));
  const extras = draft.files.filter((file) => !owned.has(file.path));
  return {
    spec: {
      id: `${draft.slug}-v1`,
      slug: draft.slug,
      name: draft.name.trim() || draft.slug,
      version: "1.0.0",
      type: "deep_agent",
      description: draft.description.trim(),
      icon: draft.icon,
      prompt: `./${PROMPT_FILE}`,
      model: { main: draft.model },
      memory: draft.memory,
      // `server_id` + `tool_name` is the spec's MCP form. The split is on the
      // FIRST slash only: a server id cannot contain one, a tool name can.
      tools: draft.tools.map((key) => {
        const slash = key.indexOf("/");
        return { server_id: key.slice(0, slash), tool_name: key.slice(slash + 1) };
      }),
      skills: draft.skills,
      subagents: named.map((sa) => ({
        name: slugify(sa.name),
        description: sa.description.trim() || sa.name.trim(),
        prompt: `./${subagentPromptPath(sa.name)}`,
      })),
      hitl: Object.fromEntries(REQUIRED_GATES.map((gate) => [gate, true])),
    },
    files: [...generated, ...extras].map((file) => ({
      path: file.path,
      content: file.content,
      encoding: "utf-8" as const,
    })),
  };
};

/**
 * Recover a draft from a saved definition so editing round-trips.
 *
 * Every file must be accounted for: the ones the form generates are folded back
 * into their prompt fields, and everything else becomes a reference file. A save
 * rewrites the whole folder, so a file this function dropped would be deleted by
 * the next edit.
 */
export const draftFromDetail = (detail: CustomAgentDetail): AgentDraft => {
  const spec = (detail.spec ?? {}) as Record<string, unknown>;
  const model = spec.model as { main?: unknown } | undefined;
  const fileFor = (path: string) => detail.files.find((f) => f.path === path)?.content ?? "";
  // Paths the form regenerates from prompt fields; the rest are the user's own.
  const claimed = new Set<string>([PROMPT_FILE, MANIFEST_FILE]);
  const subagents: AgentDraftSubAgent[] = Array.isArray(spec.subagents)
    ? (spec.subagents as SpecSubAgent[]).map((sa) => {
        const path = String(sa?.prompt ?? "").replace(/^\.\//, "");
        claimed.add(path);
        return {
          name: String(sa?.name ?? ""),
          description: String(sa?.description ?? ""),
          prompt: fileFor(path),
        };
      })
    : [];
  const files: AgentDraftFile[] = detail.files
    .filter((file) => !claimed.has(file.path) && file.encoding !== "base64")
    .map((file) => ({ path: file.path, content: file.content }));
  return {
    files,
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    icon: detail.icon || "Bot",
    model: String(model?.main ?? MODEL_CHOICES[1].id),
    prompt: fileFor(PROMPT_FILE),
    memory: spec.memory !== false,
    // Native refs are skipped: this form does not manage them, so round-tripping
    // one through it would silently drop it on the next save.
    tools: Array.isArray(spec.tools)
      ? (spec.tools as SpecToolRef[])
          .filter((ref) => ref?.server_id && ref?.tool_name)
          .map((ref) => `${String(ref.server_id)}/${String(ref.tool_name)}`)
      : [],
    skills: Array.isArray(spec.skills) ? spec.skills.map(String) : [],
    subagents,
  };
};
