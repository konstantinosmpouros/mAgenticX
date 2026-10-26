/**
 * The builder's own checks, a mirror of the agents service's write rules
 * (`harness/abstractions/user_agents.py`: `_tree_issues`, `_top_level_issues`,
 * `_file_issues`; the tree limits in `agent_spec.py`).
 *
 * They run on every change, so a problem shows on its node while the user is
 * still looking at it; the server's validate runs too (debounced) and stays the
 * authority — anything only it can know (the model allowlist, the MCP gateway's
 * catalog, reserved slugs) comes from there. Issues use the server's paths
 * (`subagents.0.subagents.1.name`, `files[notes.md]`), so both kinds land on
 * nodes and fields through one mapping (`agentIssues.ts`).
 *
 * The limits are the server's numbers. Changing one here without the server
 * makes the builder either nag about something the server accepts or wave
 * through something it refuses.
 */
import type { AgentDraft, AgentDraftSubAgent, AgentIssue } from "@/shared/lib/types";
import { PROMPT_FILE, nestedSubagentPromptPath } from "./agentSpec";

export const MAX_SUBAGENT_DEPTH = 3;
export const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_SUBAGENT_NAME_CHARS = 48;
export const MAX_SUBAGENT_DESCRIPTION_CHARS = 1000;
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
export const MAX_PATH_DEPTH = 3;
export const FILE_EXTENSIONS = [".md", ".txt", ".yaml", ".yml"] as const;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One problem, from either checker. `required` marks a field that is merely
 * still empty — shown once the user has touched that field or tried to save, so
 * a blank new agent reads as unfinished rather than wrong.
 */
export type DraftIssue = AgentIssue & {
  source: "client" | "server";
  required?: boolean;
};

export type RuleContext = {
  /** Create or edit: the slug can only collide (and must follow the name) on create. */
  mode: "create" | "edit";
  /** Slugs of the agents this user already has, the one being edited excluded. */
  takenSlugs?: ReadonlySet<string>;
  /** The user's skill pool, when known; null skips the check (the server makes it). */
  skillPool?: ReadonlySet<string> | null;
};

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Whether a node at this depth (the main agent is 0) may have sub-agents of its own. */
export const canAddChild = (depth: number): boolean => depth < MAX_SUBAGENT_DEPTH;

/** Every sub-agent at every depth, depth first, with its spec path and names above. */
export function* walkSubagents(
  nodes: AgentDraftSubAgent[],
  prefix = "subagents",
  above: string[] = [],
): Generator<{ node: AgentDraftSubAgent; path: string; names: string[]; depth: number }> {
  for (const [index, node] of nodes.entries()) {
    const path = `${prefix}.${index}`;
    const names = [...above, node.name.trim()];
    yield { node, path, names, depth: names.length };
    yield* walkSubagents(node.subagents ?? [], `${path}.subagents`, names);
  }
}

/** Every file a save writes: the generated prompts, at every depth, then the user's own. */
export const draftFiles = (draft: AgentDraft): Array<{ path: string; content: string; owner: string }> => {
  const files = [{ path: PROMPT_FILE, content: draft.prompt, owner: "prompt" }];
  const seen = new Set([PROMPT_FILE]);
  for (const { node, path, names } of walkSubagents(draft.subagents)) {
    const file = nestedSubagentPromptPath(names);
    if (seen.has(file)) continue;
    seen.add(file);
    files.push({ path: file, content: node.prompt, owner: `${path}.prompt` });
  }
  for (const file of draft.files) {
    if (seen.has(file.path)) continue;
    files.push({ ...file, owner: `files[${file.path}]` });
  }
  return files;
};

/** The definition's size against the server's quotas, for the Files section's meter. */
export const draftUsage = (draft: AgentDraft) => {
  const files = draftFiles(draft);
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + byteLength(file.content), 0),
  };
};

const issue = (
  path: string,
  message: string,
  extra: Partial<DraftIssue> = {},
): DraftIssue => ({ path, message, severity: "error", source: "client", ...extra });

/** The checks on the agent itself: name (and the slug built from it), description, instructions. */
function topLevelIssues(draft: AgentDraft, ctx: RuleContext): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (!name) {
    issues.push(issue("name", "Give the agent a name.", { required: true }));
  } else if (name.length > MAX_NAME_CHARS) {
    issues.push(issue("name", `Keep the name under ${MAX_NAME_CHARS} characters.`));
  } else if (!draft.slug) {
    // A name in a non-Latin script leaves nothing to build an identifier from.
    issues.push(
      issue(
        "name",
        "The agent's identifier is built from its name, so it needs at least one Latin letter (a–z) or digit.",
      ),
    );
  } else if (!SLUG_RE.test(draft.slug)) {
    issues.push(issue("name", "The identifier may only hold lowercase letters, digits and hyphens."));
  } else if (ctx.mode === "create" && ctx.takenSlugs?.has(draft.slug)) {
    issues.push(issue("name", "You already have an agent with this name. Pick another."));
  }
  if (draft.description.length > MAX_DESCRIPTION_CHARS) {
    issues.push(
      issue("description", `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.`),
    );
  }
  if (!draft.prompt.trim()) {
    issues.push(
      issue("prompt", "Write the agent's instructions: what it does and how.", { required: true }),
    );
  }
  return issues;
}

/**
 * The team's rules, per node: at most three levels, a name in the slug's shape,
 * unique among its siblings and not repeated down its branch, a description
 * (how the agent above decides to use it), instructions, and tools only
 * narrowing what the agent above it has.
 */
function treeIssues(draft: AgentDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const check = (
    nodes: AgentDraftSubAgent[],
    prefix: string,
    allowed: string[],
    above: string[],
    parentLabel: string,
  ) => {
    const depth = above.length + 1;
    const names = nodes.map((node) => node.name.trim());
    nodes.forEach((node, index) => {
      const here = `${prefix}.${index}`;
      const name = names[index];
      if (depth > MAX_SUBAGENT_DEPTH) {
        issues.push(
          issue(
            here,
            `This sub-agent is ${depth} levels below the agent; at most ${MAX_SUBAGENT_DEPTH} are allowed.`,
          ),
        );
        return;
      }
      if (!name) {
        issues.push(issue(`${here}.name`, "Give this sub-agent a name.", { required: true }));
      } else if (name.length > MAX_SUBAGENT_NAME_CHARS || !SLUG_RE.test(name)) {
        issues.push(
          issue(
            `${here}.name`,
            `Use lowercase words joined by hyphens (e.g. fact-checker), at most ${MAX_SUBAGENT_NAME_CHARS} characters.`,
          ),
        );
      } else if (names.filter((other) => other === name).length > 1) {
        issues.push(issue(`${here}.name`, `Two sub-agents of ${parentLabel} are named “${name}”.`));
      } else if (above.includes(name)) {
        issues.push(
          issue(
            `${here}.name`,
            `“${name}” is already used above it in this branch; sub-agents can't loop.`,
          ),
        );
      }
      const description = node.description.trim();
      if (!description) {
        issues.push(
          issue(
            `${here}.description`,
            "Describe this sub-agent: it is how its agent decides when to use it.",
            { required: true },
          ),
        );
      } else if (description.length > MAX_SUBAGENT_DESCRIPTION_CHARS) {
        issues.push(
          issue(
            `${here}.description`,
            `Keep a sub-agent's description under ${MAX_SUBAGENT_DESCRIPTION_CHARS} characters.`,
          ),
        );
      }
      if (!node.prompt.trim()) {
        issues.push(
          issue(`${here}.prompt`, "Write this sub-agent's instructions.", { required: true }),
        );
      }
      const extra = node.tools.filter((key) => !allowed.includes(key));
      if (extra.length) {
        issues.push(
          issue(
            `${here}.tools`,
            `Uses tools ${parentLabel} doesn't have: ${extra.join(", ")}. A sub-agent can only use some of the tools of the agent above it.`,
          ),
        );
      }
      check(
        node.subagents ?? [],
        `${here}.subagents`,
        node.tools.length ? node.tools : allowed,
        [...above, name],
        name ? `“${name}”` : "this sub-agent",
      );
    });
  };
  check(draft.subagents, "subagents", draft.tools, [], "the agent");
  return issues;
}

/**
 * The file quotas, counted over everything a save writes — the main prompt,
 * every sub-agent's prompt at every depth, and the reference files — exactly as
 * the server counts them.
 */
function fileIssues(draft: AgentDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const files = draftFiles(draft);
  if (files.length > MAX_FILES) {
    issues.push(
      issue(
        "files",
        `An agent may have at most ${MAX_FILES} files, its prompts included; this one has ${files.length}.`,
      ),
    );
  }
  let total = 0;
  for (const file of files) {
    const size = byteLength(file.content);
    total += size;
    if (size > MAX_FILE_BYTES) {
      issues.push(
        issue(file.owner, `${file.path} is ${formatBytes(size)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file.`),
      );
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    issues.push(
      issue(
        "files",
        `The agent's files come to ${formatBytes(total)}; the limit is ${formatBytes(MAX_TOTAL_BYTES)} in all.`,
      ),
    );
  }
  return issues;
}

function skillIssues(draft: AgentDraft, ctx: RuleContext): DraftIssue[] {
  const pool = ctx.skillPool;
  if (!pool) return [];
  return draft.skills.flatMap((name, index) =>
    pool.has(name)
      ? []
      : [issue(`skills.${index}`, `“${name}” is no longer in your skill pool. Remove it, or add the skill again.`)],
  );
}

/** Every problem the builder can see on its own, in the order the page reads. */
export function checkDraft(draft: AgentDraft, ctx: RuleContext): DraftIssue[] {
  return [
    ...topLevelIssues(draft, ctx),
    ...skillIssues(draft, ctx),
    ...fileIssues(draft),
    ...treeIssues(draft),
  ];
}

/**
 * Normalise a user-typed or uploaded reference-file path, or return null if it
 * can't be one. The server's `_validate_relpath` rules: relative, no traversal
 * or dot-segments, at most three folders deep.
 */
export const normaliseFilePath = (raw: string): string | null => {
  const parts = raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== ".");
  if (!parts.length || parts.length > MAX_PATH_DEPTH) return null;
  if (parts.some((seg) => seg === ".." || seg.startsWith("."))) return null;
  return parts.join("/");
};

export const extensionOf = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
};

export const isAllowedFile = (path: string): boolean =>
  (FILE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
