/**
 * Where an issue belongs: which node of the canvas, which field, which of the
 * main agent's tabs.
 *
 * Both checkers — the builder's (`agentRules.ts`) and the server's validate —
 * speak the spec's paths: `name`, `model.main`, `tools.2`, `hitl.write_file`,
 * `subagents.0.subagents.1.name`, `files[AGENT.md]`. Indices are positions in
 * the payload `buildAgentPayload` wrote, which keeps every node in the draft's
 * order, so a path resolves against the draft it was checked on. It is
 * resolved to a node's `uid` straight away: a later rename, add or delete then
 * can't re-point an answer that arrived for the earlier draft.
 */
import type { AgentDraft, AgentDraftSubAgent } from "@/shared/lib/types";
import { PROMPT_FILE, nestedSubagentPromptPath } from "./agentSpec";
import { walkSubagents, type DraftIssue } from "./agentRules";
import type { BuilderSection } from "./routes";

/** The main agent's node id on the canvas; every sub-agent has its own `uid`. */
export const ROOT_UID = "root";

/** The fields an issue can point at. `general` is the node as a whole. */
export type IssueField =
  | "general"
  | "name"
  | "description"
  | "icon"
  | "model"
  | "prompt"
  | "memory"
  | "tools"
  | "skills"
  | "files"
  | "approvals"
  | "subagents";

export type IssueTarget = {
  uid: string;
  field: IssueField;
  /** The main agent's tab that holds the field; null on a sub-agent (one form). */
  section: BuilderSection | null;
  /** The reference file an issue names, for the Files tab to open it. */
  file?: string;
};

export type PlacedIssue = DraftIssue & { target: IssueTarget; id: string };

const SECTION_OF: Record<IssueField, BuilderSection> = {
  general: "identity",
  name: "identity",
  description: "identity",
  icon: "identity",
  model: "identity",
  prompt: "instructions",
  memory: "instructions",
  tools: "tools",
  skills: "skills",
  files: "files",
  approvals: "approvals",
  subagents: "identity",
};

const SUB_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "prompt",
  "model",
  "tools",
  "subagents",
]);

const root = (field: IssueField, file?: string): IssueTarget => ({
  uid: ROOT_UID,
  field,
  section: SECTION_OF[field],
  ...(file ? { file } : {}),
});

/** The node at an index path into the draft's tree (`[0, 1]` → second child of the first). */
const nodeAtIndices = (draft: AgentDraft, indices: number[]): AgentDraftSubAgent | null => {
  let list = draft.subagents;
  let node: AgentDraftSubAgent | null = null;
  for (const index of indices) {
    node = list[index] ?? null;
    if (!node) return null;
    list = node.subagents ?? [];
  }
  return node;
};

/** The node whose prompt a generated file holds, if it is one. */
const promptOwner = (draft: AgentDraft, file: string): string | null => {
  if (file === PROMPT_FILE) return ROOT_UID;
  for (const { node, names } of walkSubagents(draft.subagents)) {
    if (nestedSubagentPromptPath(names) === file) return node.uid;
  }
  return null;
};

/** Resolve one spec path against the draft it was checked on. */
export function targetOf(path: string, draft: AgentDraft): IssueTarget {
  const file = /^files\[(.+)\]$/.exec(path)?.[1];
  if (file !== undefined) {
    const owner = promptOwner(draft, file);
    if (owner === ROOT_UID) return root("prompt");
    if (owner) return { uid: owner, field: "prompt", section: null };
    return root("files", file);
  }
  const parts = path.split(".").filter(Boolean);
  const head = parts[0] ?? "";
  if (head === "subagents" && parts.length > 1) {
    // subagents.0.subagents.1.name → indices [0, 1], field "name".
    const indices: number[] = [];
    let at = 0;
    while (parts[at] === "subagents" && /^\d+$/.test(parts[at + 1] ?? "")) {
      indices.push(Number(parts[at + 1]));
      at += 2;
    }
    // Deeper than the draft goes (an over-deep import): the deepest node it has.
    let node = nodeAtIndices(draft, indices);
    while (!node && indices.length) {
      indices.pop();
      node = nodeAtIndices(draft, indices);
    }
    if (!node) return root("subagents");
    const rest = parts[at] ?? "";
    const field = (SUB_FIELDS.has(rest) ? rest : "general") as IssueField;
    return { uid: node.uid, field, section: null };
  }
  if (head === "model" && parts[1] === "subagents" && parts[2]) {
    // An older spec's `model.subagents.<name>`: the first node of that name.
    for (const { node } of walkSubagents(draft.subagents)) {
      if (node.name.trim() === parts[2]) return { uid: node.uid, field: "model", section: null };
    }
    return root("model");
  }
  switch (head) {
    case "name":
    case "slug":
    case "id":
      return root("name");
    case "description":
      return root("description");
    case "icon":
      return root("icon");
    case "model":
      return root("model");
    case "prompt":
      return root("prompt");
    case "memory":
      return root("memory");
    case "tools":
      return root("tools");
    case "skills":
      return root("skills");
    case "files":
      return root("files");
    case "hitl":
      return root("approvals");
    case "subagents":
      return root("subagents");
    default:
      return root("general");
  }
}

/** Issues resolved to their nodes, each with an id stable enough to key a list on. */
export function placeIssues(issues: DraftIssue[], draft: AgentDraft): PlacedIssue[] {
  return issues.map((item, index) => ({
    ...item,
    target: targetOf(item.path, draft),
    id: `${item.source}:${item.path}:${index}`,
  }));
}

/**
 * The server's issues, minus those the builder already reports on the same
 * spot: both mirror one rule, and saying it twice in two wordings reads as two
 * problems. A server issue on a field the builder is silent about always stays.
 */
export function mergeIssues(client: PlacedIssue[], server: PlacedIssue[]): PlacedIssue[] {
  const spot = (item: PlacedIssue) => `${item.target.uid}:${item.target.field}`;
  const local = new Set(client.map(spot));
  return [...client, ...server.filter((item) => !local.has(spot(item)))];
}

/** How many issues each node carries, for the canvas's badges. */
export function countByNode(issues: PlacedIssue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of issues) counts.set(item.target.uid, (counts.get(item.target.uid) ?? 0) + 1);
  return counts;
}

/** A field's DOM id, so an issue can move the focus to it. */
export const fieldId = (uid: string, field: IssueField) => `agent-field-${uid}-${field}`;

/** How a field is named in the issues list. */
export const FIELD_LABELS: Record<IssueField, string> = {
  general: "Definition",
  name: "Name",
  description: "Description",
  icon: "Icon",
  model: "Model",
  prompt: "Instructions",
  memory: "Memory",
  tools: "Tools",
  skills: "Skills",
  files: "Files",
  approvals: "Approvals",
  subagents: "Team",
};
