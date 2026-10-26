/**
 * The `agent.yaml` shape, and the two functions that cross into and out of it.
 *
 * `buildAgentPayload` is the single place that knows the spec's structure, so
 * the builder's fields never encode YAML; `draftFromDetail` is its inverse.
 * They live apart from the builder's components because the pair has to
 * round-trip losslessly — an edit that quietly drops a field saves it away —
 * which is only checkable with both halves importable on their own.
 */
import type {
  AgentDraft,
  AgentDraftFile,
  AgentDraftSubAgent,
  CustomAgentDetail,
  CustomAgentImportResult,
  CustomAgentWritePayload,
} from "@/shared/lib/types";

/**
 * The models a user may pick when `/catalog/models` cannot be read (an older
 * bridge, a blip). The server's list wins whenever it loads, and re-validates
 * every save, so a drift here surfaces as an issue rather than a broken agent.
 */
export const MODEL_CHOICES = [
  { id: "openai:gpt-6-luna", label: "GPT-6 Luna" },
  { id: "openai:gpt-5", label: "GPT-5" },
  { id: "openai:gpt-4o", label: "GPT-4o" },
  { id: "openai:gpt-4o-mini", label: "GPT-4o mini" },
] as const;

/** The model a new agent starts on when the server has not said otherwise. */
export const FALLBACK_MODEL = MODEL_CHOICES[1].id;

/**
 * A model id as people read it: the server's label when one is given, else the
 * fallback list's, else the id without its provider prefix (`openai:gpt-x` →
 * `gpt-x`), so a model nobody has a label for still reads cleanly.
 */
export const modelLabel = (id: string, models?: ReadonlyArray<{ id: string; label: string }>) =>
  models?.find((m) => m.id === id)?.label ||
  MODEL_CHOICES.find((m) => m.id === id)?.label ||
  id.replace(/^[a-z0-9_-]+:/i, "");

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

/**
 * A sub-agent name as it is typed: the slug's alphabet, kept live so the field
 * never holds something the server would refuse. Unlike `slugify` it keeps a
 * trailing hyphen, so "fact-" can still become "fact-checker".
 */
export const toSubagentName = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48);

export const subagentPromptPath = (name: string) =>
  `${SUBAGENT_DIR}/${slugify(name) || "subagent"}.md`;

/**
 * A sub-agent's prompt file, named by its path of names
 * (`subagents/researcher--fact-checker.md`). A slug never holds `--`, so two
 * paths can never share a file; a top-level sub-agent keeps its plain name.
 */
export const nestedSubagentPromptPath = (names: string[]) =>
  `${SUBAGENT_DIR}/${names.map((name) => slugify(name) || "subagent").join("--")}.md`;

let uidCounter = 0;
/** A fresh node id — unique for the page's life, never saved. */
export const newUid = (): string => {
  uidCounter += 1;
  return `n${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
};

export const emptyDraft = (model: string = FALLBACK_MODEL): AgentDraft => ({
  slug: "",
  name: "",
  description: "",
  icon: "Bot",
  model,
  prompt: "",
  memory: true,
  tools: [],
  skills: [],
  subagents: [],
  files: [],
  hitl: {},
  approvals: {},
});

/** A new, empty sub-agent: inherits the model and every tool of the agent above it. */
export const emptySubagent = (): AgentDraftSubAgent => ({
  uid: newUid(),
  name: "",
  description: "",
  prompt: "",
  model: "",
  tools: [],
  subagents: [],
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

/**
 * A `server/tool` key in the spec's MCP form. The split is on the FIRST slash
 * only: a server id cannot contain one, a tool name can.
 */
const toolRef = (key: string) => {
  const slash = key.indexOf("/");
  return { server_id: key.slice(0, slash), tool_name: key.slice(slash + 1) };
};

/** The tool's own name in a `server/tool` key — what `hitl` is keyed by. */
export const toolNameOf = (key: string): string => {
  const slash = key.indexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
};

/**
 * The spec's tool list back to `server/tool` keys. Native refs are skipped:
 * built-ins are on for every agent, so listing one changes nothing.
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
 * Every sub-agent is written, in the draft's order, even one still missing its
 * name or instructions: the server's issue paths (`subagents.0.subagents.1.name`)
 * are indices into this list, and they must land on the node the user sees.
 * The server reports what is missing; nothing is dropped behind the user's back.
 *
 * A sub-agent's tools are clamped to what the agent above it may use — the
 * server refuses anything wider, and removing a tool higher up must not leave a
 * node below pointing at it. `version` is fixed at 1.0.0 and `id` is derived
 * from the slug — neither is a user concern.
 */
export const buildAgentPayload = (draft: AgentDraft): CustomAgentWritePayload => {
  // Files the builder owns, written from the draft's prompt fields.
  const generated = new Map<string, string>([[PROMPT_FILE, draft.prompt]]);
  const specsOf = (
    children: AgentDraftSubAgent[],
    above: string[],
    allowed: string[],
  ): Record<string, unknown>[] =>
    children.map((sa) => {
      const names = [...above, sa.name.trim()];
      const path = nestedSubagentPromptPath(names);
      // Two nodes that share a path share a name — an issue the checks
      // report on the name; the first keeps the file.
      if (!generated.has(path)) generated.set(path, sa.prompt);
      const tools = sa.tools.filter((key) => allowed.includes(key));
      const nested = specsOf(sa.subagents ?? [], names, tools.length ? tools : allowed);
      return {
        name: sa.name.trim(),
        description: sa.description.trim(),
        prompt: `./${path}`,
        // Omitted, not blank, to inherit: the runtime reads a missing model
        // and a missing tool list as "use the agent's above".
        ...(sa.model ? { model: sa.model } : {}),
        ...(tools.length ? { tools: tools.map(toolRef) } : {}),
        ...(nested.length ? { subagents: nested } : {}),
      };
    });
  const subagentSpecs = specsOf(draft.subagents, [], draft.tools);
  // Generated paths win: a reference file can never shadow a prompt the
  // builder is responsible for, however the draft got into that state.
  const extras = draft.files.filter((file) => !generated.has(file.path));
  const hitl = draft.hitl ?? {};
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
      // The definition's own defaults, only as they came (an import, a saved
      // spec). What the user picks in Approvals is saved as their preference.
      ...(Object.keys(hitl).length ? { hitl } : {}),
    },
    files: [
      ...[...generated].map(([path, content]) => ({ path, content })),
      ...extras,
    ].map((file) => ({ path: file.path, content: file.content, encoding: "utf-8" as const })),
  };
};

/**
 * Recover a draft from a saved definition so editing round-trips.
 *
 * Every file must be accounted for: the ones the builder generates are folded
 * back into their prompt fields, and everything else becomes a reference file.
 * A save rewrites the whole folder, so a file this function dropped would be
 * deleted by the next edit.
 *
 * An older spec names sub-agent models in `model.subagents{name}`; each node
 * now carries its own, so those are folded into the nodes they name (an
 * explicit `model` on the node still wins, as at runtime).
 */
export const draftFromDetail = (detail: CustomAgentDetail): AgentDraft => {
  const spec = (detail.spec ?? {}) as Record<string, unknown>;
  const model = (spec.model ?? {}) as { main?: unknown; subagents?: unknown };
  const legacyModels =
    model.subagents && typeof model.subagents === "object"
      ? (model.subagents as Record<string, unknown>)
      : {};
  const fileFor = (path: string) => detail.files.find((f) => f.path === path)?.content ?? "";
  // Paths the builder regenerates from prompt fields; the rest are the user's own.
  const claimed = new Set<string>([PROMPT_FILE, MANIFEST_FILE]);
  const readSubagents = (raw: unknown): AgentDraftSubAgent[] =>
    Array.isArray(raw)
      ? (raw as SpecSubAgent[]).map((sa) => {
          const path = String(sa?.prompt ?? "").replace(/^\.\//, "");
          claimed.add(path);
          const name = String(sa?.name ?? "");
          const legacy = legacyModels[name];
          return {
            uid: newUid(),
            name,
            description: String(sa?.description ?? ""),
            prompt: fileFor(path),
            model:
              typeof sa?.model === "string"
                ? sa.model
                : typeof legacy === "string"
                  ? legacy
                  : "",
            tools: toolKeys(sa?.tools),
            subagents: readSubagents(sa?.subagents),
          };
        })
      : [];
  const subagents = readSubagents(spec.subagents);
  const files: AgentDraftFile[] = detail.files
    .filter((file) => !claimed.has(file.path) && file.encoding !== "base64")
    .map((file) => ({ path: file.path, content: file.content }));
  const hitl =
    spec.hitl && typeof spec.hitl === "object"
      ? Object.fromEntries(
          Object.entries(spec.hitl as Record<string, unknown>).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        )
      : {};
  return {
    files,
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    icon: detail.icon || "Bot",
    model: typeof model.main === "string" && model.main ? model.main : FALLBACK_MODEL,
    prompt: fileFor(PROMPT_FILE),
    memory: spec.memory !== false,
    tools: toolKeys(spec.tools),
    skills: Array.isArray(spec.skills) ? spec.skills.map(String) : [],
    subagents,
    hitl,
    approvals: {},
  };
};

/**
 * An imported agent.yaml as a draft, for the import result's canvas and for
 * "Open in the builder". Null when the YAML did not parse into a spec.
 */
export const draftFromImport = (result: CustomAgentImportResult): AgentDraft | null => {
  const spec = result.spec;
  if (!spec) return null;
  const text = (key: string) => (typeof spec[key] === "string" ? (spec[key] as string) : "");
  return draftFromDetail({
    id: "",
    slug: text("slug"),
    name: text("name"),
    description: text("description"),
    icon: text("icon"),
    version: undefined,
    type: "deep agent",
    spec,
    files: result.files,
  });
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
