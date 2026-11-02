import type { AgentDraft, AgentDraftFile, AgentDraftSubAgent } from "@/shared/lib/types";
import { emptyDraft, emptySubagent, slugify } from "@/features/agents/lib/agentSpec";

/**
 * What every starter template is built from: the template's shape, the
 * builders for its draft, and the rules every lead follows.
 *
 * A template is a lead with a team of specialists (nested where a specialist
 * needs help of its own), instructions for each, and reference guides the
 * whole team reads from `/reference/` — a custom agent's own files, mounted
 * read-only at run time. Nothing is stored server-side: a template is only a
 * filled-in draft, so every field stays editable and the usual checks run on
 * Create.
 *
 * Tools are left empty on purpose: MCP tools depend on what each account has
 * connected, and every agent has the built-in tools anyway. The instructions
 * say what to do when a tool a step wants is missing.
 */

export type AgentTemplate = {
  id: string;
  name: string;
  /** One line for the start screen card. */
  blurb: string;
  icon: string;
  /** The lead's name: the agent's own. */
  lead: string;
  draft: (model: string) => AgentDraft;
};

export const lines = (...text: string[]) => text.join("\n");

/** The empty draft with its name, and the identifier the builder builds from it. */
export const named = (model: string, name: string): AgentDraft => ({
  ...emptyDraft(model),
  name,
  slug: slugify(name),
});

export const subagent = (
  name: string,
  description: string,
  prompt: string,
  subagents: AgentDraftSubAgent[] = [],
): AgentDraftSubAgent => ({
  ...emptySubagent(),
  name,
  description,
  prompt,
  subagents,
});

export const file = (path: string, ...content: string[]): AgentDraftFile => ({
  path,
  content: lines(...content),
});

/** How every lead runs its team; appended to each lead's own instructions. */
export const LEAD_RULES = lines(
  "## How you run the team",
  "- **Size the job first.** A quick question gets a direct answer from you, with no delegation. Anything with several steps gets a plan written as a todo list, kept current as you go.",
  "- **Delegate with the `task` tool**, one specialist per brief. A sub-agent sees nothing of this conversation, so every brief is self-contained:",
  "  - **Goal**: what to find out or produce, and why it matters.",
  "  - **Input**: the material itself (pasted or quoted), plus any constraints.",
  "  - **Output**: exactly what to return, in what shape and length.",
  "  - **Done when**: the bar the result must clear.",
  "- **Run independent briefs in parallel**; wait only where one step needs another's result.",
  "- **You own the result.** Read what comes back critically. Send it back with specific notes when it falls short, at most twice, then fix it yourself. Never pass on a claim you have not checked.",
  "- **Ask only when it matters.** If the request is ambiguous in a way that changes the outcome, ask one short question. Otherwise state your assumptions in a line and proceed.",
  "- **Be honest about limits.** If a step needs a tool you do not have (web search, a file, a repository), say so plainly, do what you can without it, and say what the user could provide.",
  "- **Keep the user informed** on long jobs: a one-line status at each phase, not a running commentary.",
  "",
  "## Your reply",
  "- Lead with the answer or the deliverable, not with what you did.",
  "- Then, briefly: the assumptions you made, what you could not do, and the obvious next step.",
);

/** Every sub-agent at every depth: what the card counts. */
export const teamSize = (draft: AgentDraft): number => {
  const count = (nodes: AgentDraftSubAgent[]): number =>
    nodes.reduce((sum, node) => sum + 1 + count(node.subagents), 0);
  return count(draft.subagents);
};
