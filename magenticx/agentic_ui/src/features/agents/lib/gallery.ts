import type { Agent, CustomAgentSummary, MyAgent } from "@/shared/lib/types";
import { modelLabel } from "./agentSpec";

/**
 * The gallery's data: which cards exist, which a scope and a search keep, and
 * the one-line facts each card shows. Pure, so the filtering is testable
 * without rendering the page.
 */

export type GalleryScope = "all" | "mine" | "platform";

export const GALLERY_SCOPES: { id: GalleryScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "platform", label: "Platform" },
];

export type AgentCard = {
  agent: Agent;
  /** Built by this user — from the catalog's `kind`, not a cross-check. */
  custom: boolean;
  /** A custom agent's model and counts; null when the list did not carry them. */
  summary: CustomAgentSummary | null;
};

/**
 * One card per catalog agent, in catalog order. The catalog decides what exists
 * (and `kind` whose it is); the user's own list only lends its summary, so a
 * card never appears or disappears because that second list is late.
 */
export function buildAgentCards(agents: Agent[], myAgents: MyAgent[]): AgentCard[] {
  const summaries = new Map(myAgents.map((a) => [a.id, a]));
  return agents.map((agent) => {
    const custom = agent.kind === "custom";
    const mine = custom ? summaries.get(agent.id) : undefined;
    return {
      agent,
      custom,
      summary: mine
        ? {
            model: mine.model,
            toolCount: mine.toolCount,
            skillCount: mine.skillCount,
            subagentCount: mine.subagentCount,
          }
        : null,
    };
  });
}

/** The cards a scope and a search keep. The search matches name and description. */
export function filterAgentCards(
  cards: AgentCard[],
  scope: GalleryScope,
  query: string,
): AgentCard[] {
  const q = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (scope === "mine" && !card.custom) return false;
    if (scope === "platform" && card.custom) return false;
    if (!q) return true;
    return (
      card.agent.name.toLowerCase().includes(q) ||
      card.agent.description.toLowerCase().includes(q)
    );
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A custom card's facts, dropping anything the summary did not supply: a
 * missing count is left out rather than shown as a zero it may not be. Zero
 * tools is worth saying; zero skills or sub-agents is the default and is not.
 */
export function cardFacts(summary: CustomAgentSummary | null): string[] {
  if (!summary) return [];
  const facts: string[] = [];
  if (summary.model) facts.push(modelLabel(summary.model));
  if (typeof summary.toolCount === "number") {
    facts.push(plural(summary.toolCount, "tool", "tools"));
  }
  if (typeof summary.skillCount === "number" && summary.skillCount > 0) {
    facts.push(plural(summary.skillCount, "skill", "skills"));
  }
  if (typeof summary.subagentCount === "number" && summary.subagentCount > 0) {
    facts.push(plural(summary.subagentCount, "sub-agent", "sub-agents"));
  }
  return facts;
}
