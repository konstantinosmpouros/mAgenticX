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
  { id: "openai:gpt-6-luna", label: "GPT-6 Luna", hint: "Newest, efficient" },
  { id: "openai:gpt-5", label: "GPT-5", hint: "Most capable" },
  { id: "openai:gpt-4o", label: "GPT-4o", hint: "Balanced" },
  { id: "openai:gpt-4o-mini", label: "GPT-4o mini", hint: "Fastest" },
] as const;

/**
 * A model id as people read it: its label when it is one of the choices above,
 * otherwise the id without its provider prefix (`openai:gpt-x` → `gpt-x`), so a
 * model the server allows but this list does not know yet still reads cleanly.
 */
export const modelLabel = (id: string): string =>
  MODEL_CHOICES.find((m) => m.id === id)?.label ?? id.replace(/^[a-z0-9_-]+:/i, "");

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

/**
 * Derive an agent's identifier from its display name.
 *
 * NFKD-normalised first so accented Latin survives as its base letter —
 * without it "Café" slugged to "caf", silently dropping the last character.
 * A name in a non-Latin script (Greek, Cyrillic, CJK) still has no ASCII to
 * recover and yields "", which callers must treat as "ask the user", not as
 * "the name is missing".
 */
export const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const subagentPromptPath = (name: string) =>
  `${SUBAGENT_DIR}/${slugify(name) || "subagent"}.md`;

/**
 * A nested sub-agent's prompt file, named by its path of names
 * (`subagents/researcher--fact-checker.md`). A slug never holds `--`, so two
 * paths can never share a file; a top-level sub-agent keeps its plain name.
 */
export const nestedSubagentPromptPath = (names: string[]) =>
  `${SUBAGENT_DIR}/${names.map((name) => slugify(name) || "subagent").join("--")}.md`;

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
type SpecSubAgent = {
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
  model?: unknown;
  tools?: unknown;
  subagents?: unknown;
};

/** A new, empty sub-agent: inherits the agent's model and all of its tools. */
export const emptySubagent = (): AgentDraftSubAgent => ({
  name: "",
  description: "",
  prompt: "",
  model: "",
  tools: [],
});

/**
 * A `server/tool` key in the spec's MCP form. The split is on the FIRST slash
 * only: a server id cannot contain one, a tool name can.
 */
const toolRef = (key: string) => {
  const slash = key.indexOf("/");
  return { server_id: key.slice(0, slash), tool_name: key.slice(slash + 1) };
};

/**
 * The spec's tool list back to `server/tool` keys. Native refs are skipped: the
 * form does not manage them, so round-tripping one would drop it on save.
 */
const toolKeys = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? (raw as SpecToolRef[])
        .filter((ref) => ref?.server_id && ref?.tool_name)
        .map((ref) => `${String(ref.server_id)}/${String(ref.tool_name)}`)
    : [];

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
  // A sub-agent's own sub-agents, kept from the definition (the form does not
  // edit them yet): their prompts are written back, and their tools stay
  // inside what the sub-agent above them may use.
  const nestedSpecs = (
    children: AgentDraftSubAgent[] | undefined,
    above: string[],
    allowed: string[],
  ): Record<string, unknown>[] =>
    (children ?? [])
      .filter((sa) => sa.name.trim() && sa.prompt.trim())
      .map((sa) => {
        const names = [...above, sa.name];
        const path = nestedSubagentPromptPath(names);
        generated.push({ path, content: sa.prompt });
        const tools = sa.tools.filter((key) => allowed.includes(key));
        const nested = nestedSpecs(sa.subagents, names, tools.length ? tools : allowed);
        return {
          name: slugify(sa.name),
          description: sa.description.trim() || sa.name.trim(),
          prompt: `./${path}`,
          ...(sa.model ? { model: sa.model } : {}),
          ...(tools.length ? { tools: tools.map(toolRef) } : {}),
          ...(nested.length ? { subagents: nested } : {}),
        };
      });
  const subagentSpecs = named.map((sa) => {
    // Only tools the agent still declares: the server refuses a sub-agent
    // tool its agent lacks, and removing a tool from the agent must not
    // leave a sub-agent pointing at it.
    const tools = sa.tools.filter((key) => draft.tools.includes(key));
    const nested = nestedSpecs(sa.subagents, [sa.name], tools.length ? tools : draft.tools);
    return {
      name: slugify(sa.name),
      description: sa.description.trim() || sa.name.trim(),
      prompt: `./${subagentPromptPath(sa.name)}`,
      // Omitted, not blank, to inherit: the runtime reads a missing model
      // and a missing tool list as "use the agent's".
      ...(sa.model ? { model: sa.model } : {}),
      ...(tools.length ? { tools: tools.map(toolRef) } : {}),
      ...(nested.length ? { subagents: nested } : {}),
    };
  });
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
      tools: draft.tools.map(toolRef),
      skills: draft.skills,
      subagents: subagentSpecs,
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
  // At every depth: a nested sub-agent's prompt is claimed too, and the
  // sub-agent is kept under its parent.
  const readSubagents = (raw: unknown): AgentDraftSubAgent[] =>
    Array.isArray(raw)
      ? (raw as SpecSubAgent[]).map((sa) => {
          const path = String(sa?.prompt ?? "").replace(/^\.\//, "");
          claimed.add(path);
          const nested = readSubagents(sa?.subagents);
          return {
            name: String(sa?.name ?? ""),
            description: String(sa?.description ?? ""),
            prompt: fileFor(path),
            model: typeof sa?.model === "string" ? sa.model : "",
            tools: toolKeys(sa?.tools),
            ...(nested.length ? { subagents: nested } : {}),
          };
        })
      : [];
  const subagents = readSubagents(spec.subagents);
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
    tools: toolKeys(spec.tools),
    skills: Array.isArray(spec.skills) ? spec.skills.map(String) : [],
    subagents,
  };
};

/**
 * A copy of a definition to open the builder on in CREATE mode: a fresh name
 * and slug. The slug must differ — the server rejects a create whose slug
 * collides — and `-copy` is the least surprising suffix.
 */
export function duplicateDefinition(detail: CustomAgentDetail): CustomAgentDetail {
  const spec = detail.spec as Record<string, unknown>;
  const baseSlug = typeof spec.slug === "string" ? spec.slug : detail.slug;
  return {
    ...detail,
    id: "",
    name: `${detail.name} copy`,
    slug: `${baseSlug}-copy`,
    spec: { ...spec, slug: `${baseSlug}-copy`, name: `${detail.name} copy` },
  };
}
