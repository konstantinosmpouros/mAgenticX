import type {
  AgentSubAgentSpec,
  AgentToolRef,
  AgentVersionDetail,
  AgentVersionSummary,
} from "@/shared/lib/types";
import { modelLabel, PROMPT_FILE, SUBAGENT_DIR } from "@/features/agents/lib/agentSpec";

/**
 * What one saved version of an agent changed, for its History tab: the
 * definition's fields side by side, the lists (tools, skills, sub-agents) as
 * what was added and removed, and every file as added, removed or changed —
 * the line diff itself is `textDiff`'s, computed when a file is shown.
 *
 * Read straight off two versions' `spec` + `files` rather than through
 * `draftFromDetail`: that one is for editing (it invents uids, defaults a
 * missing model) and a history must show what was saved, not a builder's view
 * of it.
 */

/** Friendly names for a version's `changes` values; an unknown one shows as is. */
export const CHANGE_LABELS: Record<string, string> = {
  details: "Details",
  instructions: "Instructions",
  model: "Model",
  tools: "Tools",
  skills: "Skills",
  team: "Sub-agents",
  files: "Files",
  settings: "Settings",
};

export const changeLabel = (change: string): string =>
  CHANGE_LABELS[change] ?? change.charAt(0).toUpperCase() + change.slice(1);

/** How a version came to be, in a sentence fragment ("Restored from version 3"). */
export const versionKindLabel = (version: AgentVersionSummary): string => {
  switch (version.kind) {
    case "created":
      return "Created";
    case "restored":
      return version.restoredFrom !== null
        ? `Restored from version ${version.restoredFrom}`
        : "Restored";
    case "baseline":
      return "Before history began";
    default:
      // A save made after restoring an older version builds on that one.
      return version.basedOn !== null && version.basedOn !== version.versionNo - 1
        ? `Saved on top of version ${version.basedOn}`
        : "Saved";
  }
};

/** What a version did, as one plain sentence for the collapsed History row. */
export const versionSummary = (version: AgentVersionSummary): string => {
  if (version.kind === "baseline") return "The agent as it was before its history began.";
  if (version.kind === "created") return "The agent as it was first created.";
  const parts = version.changes.map((c) => changeLabel(c).toLowerCase());
  if (!parts.length) return "No changes to the definition.";
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Changed ${list}.`;
};

/** The version the agent is now: the flagged one, else the newest. */
export const currentVersion = (
  versions: AgentVersionSummary[] | null,
): AgentVersionSummary | null => versions?.find((v) => v.current) ?? versions?.[0] ?? null;

/** A version's date and time in the viewer's locale, or null when unreadable. */
export const formatVersionTime = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/** One item of a list field, keyed for comparison and labelled for display. */
export type ListItem = { key: string; label: string };

export type FieldChange = { label: string; before: string; after: string };
export type ListChange = { label: string; added: ListItem[]; removed: ListItem[] };
export type FileChange = {
  path: string;
  status: "added" | "removed" | "changed";
  before: string;
  after: string;
  /** A base64 file: compared, but never diffed line by line. */
  binary: boolean;
};

export type VersionComparison = {
  fields: FieldChange[];
  lists: ListChange[];
  files: FileChange[];
};

type VersionFacts = {
  name: string;
  description: string;
  model: string;
  icon: string;
  memory: string;
  approvals: string;
  tools: ListItem[];
  skills: ListItem[];
  subagents: ListItem[];
  files: Map<string, { content: string; binary: boolean }>;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toolItem = (ref: AgentToolRef): ListItem | null => {
  const name = text(ref.tool_name) || text(ref.name);
  if (!name) return null;
  const server = text(ref.server_id);
  return { key: server ? `${server}/${name}` : name, label: name };
};

/** Every sub-agent in the tree, as "Parent › Child" so a nested one is placeable. */
const subagentItems = (specs: AgentSubAgentSpec[] = [], above: string[] = []): ListItem[] =>
  specs.flatMap((sa) => {
    const name = text(sa.name);
    if (!name) return [];
    const path = [...above, name];
    const label = path.join(" › ");
    return [{ key: label, label }, ...subagentItems(sa.subagents, path)];
  });

/** The definition's own approval defaults (`hitl`), as one readable line. */
const approvalDefaults = (hitl: Record<string, boolean> = {}): string =>
  Object.entries(hitl)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, ask]) => `${tool}: ${ask ? "asks first" : "runs without asking"}`)
    .join(", ");

const facts = (version: AgentVersionDetail): VersionFacts => {
  const spec = version.spec;
  const main = text(typeof spec.model === "string" ? spec.model : spec.model?.main);
  return {
    name: text(spec.name),
    description: text(spec.description),
    model: main ? modelLabel(main) : "",
    icon: text(spec.icon),
    memory: typeof spec.memory === "boolean" ? (spec.memory ? "On" : "Off") : "",
    approvals: approvalDefaults(spec.hitl),
    tools: (spec.tools ?? []).map(toolItem).filter((t): t is ListItem => t !== null),
    skills: (spec.skills ?? []).filter(Boolean).map((s) => ({ key: s, label: s })),
    subagents: subagentItems(spec.subagents),
    files: new Map(
      version.files.map((f) => [f.path, { content: f.content, binary: f.encoding === "base64" }]),
    ),
  };
};

const listChange = (label: string, before: ListItem[], after: ListItem[]): ListChange => {
  const had = new Set(before.map((i) => i.key));
  const has = new Set(after.map((i) => i.key));
  return {
    label,
    added: after.filter((i) => !had.has(i.key)),
    removed: before.filter((i) => !has.has(i.key)),
  };
};

/** AGENT.md first, then the sub-agents' prompts, then everything else, by path. */
const fileRank = (path: string) =>
  path === PROMPT_FILE ? 0 : path.startsWith(`${SUBAGENT_DIR}/`) ? 1 : 2;

export const compareFilePaths = (a: string, b: string) =>
  fileRank(a) - fileRank(b) || a.localeCompare(b);

/** What `after` changed relative to `before` (the version kept just before it). */
export function compareVersions(
  before: AgentVersionDetail,
  after: AgentVersionDetail,
): VersionComparison {
  const was = facts(before);
  const now = facts(after);

  const fields: FieldChange[] = (
    [
      ["Name", was.name, now.name],
      ["Description", was.description, now.description],
      ["Model", was.model, now.model],
      ["Icon", was.icon, now.icon],
      ["Memory", was.memory, now.memory],
      ["Approval defaults", was.approvals, now.approvals],
    ] as const
  )
    .filter(([, b, a]) => b !== a)
    .map(([label, b, a]) => ({ label, before: b, after: a }));

  const lists = [
    listChange("Tools", was.tools, now.tools),
    listChange("Skills", was.skills, now.skills),
    listChange("Sub-agents", was.subagents, now.subagents),
  ].filter((l) => l.added.length || l.removed.length);

  const paths = [...new Set([...was.files.keys(), ...now.files.keys()])].sort(compareFilePaths);
  const files: FileChange[] = [];
  for (const path of paths) {
    const b = was.files.get(path);
    const a = now.files.get(path);
    if (b && a && b.content === a.content) continue;
    files.push({
      path,
      status: !b ? "added" : !a ? "removed" : "changed",
      before: b?.content ?? "",
      after: a?.content ?? "",
      binary: Boolean(b?.binary || a?.binary),
    });
  }

  return { fields, lists, files };
}

export const isEmptyComparison = (c: VersionComparison) =>
  !c.fields.length && !c.lists.length && !c.files.length;
