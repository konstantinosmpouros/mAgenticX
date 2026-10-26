/**
 * The Agents section's URLs, in one place.
 *
 *   /agents                     the gallery
 *   /agents/new                 create: a start screen (the canvas, or import a YAML);
 *                               `?from=<agentId>` duplicates that agent on the canvas
 *   /agents/:agentId            an agent's page (`?section=overview|tools|approvals`)
 *   /agents/:agentId/edit       edit (`?section=identity|…`)
 *
 * The id is the catalog id (`chat_db.agents.id`), as every bridge route uses:
 * slugs are only unique per user, so they would make poor URLs.
 */

export const AGENTS_PATH = "/agents";

/** Whether a pathname is one of the Agents pages (not merely starts with the word). */
export const isAgentsPath = (pathname: string): boolean =>
  pathname === AGENTS_PATH || pathname.startsWith(`${AGENTS_PATH}/`);

const withSection = (path: string, section?: string | null) =>
  section ? `${path}?section=${encodeURIComponent(section)}` : path;

export const agentPath = (agentId: string, section?: DetailSection | null) =>
  withSection(`${AGENTS_PATH}/${encodeURIComponent(agentId)}`, section);

export const agentEditPath = (agentId: string, section?: BuilderSection | null) =>
  withSection(`${AGENTS_PATH}/${encodeURIComponent(agentId)}/edit`, section);

export const newAgentPath = (fromAgentId?: string | null) =>
  fromAgentId
    ? `${AGENTS_PATH}/new?from=${encodeURIComponent(fromAgentId)}`
    : `${AGENTS_PATH}/new`;

/**
 * How a new agent is being started (`/agents/new?via=`): on the canvas, or
 * from an imported YAML. Absent, the page shows the start screen.
 */
export const START_VIAS = ["canvas", "import"] as const;
export type StartVia = (typeof START_VIAS)[number];

/** The sections of an agent's page, in tab order. */
export const DETAIL_SECTIONS = ["overview", "tools", "approvals"] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/**
 * The main agent's tabs in the builder's inspector, in order. The team is the
 * canvas itself, so it is not one of them.
 */
export const BUILDER_SECTIONS = [
  "identity",
  "instructions",
  "tools",
  "skills",
  "files",
  "approvals",
] as const;
export type BuilderSection = (typeof BUILDER_SECTIONS)[number];

/**
 * Read `?section=` against the sections a page has. Anything else — missing,
 * misspelt, a section of the other page — falls back to the page's first stop,
 * so an old or hand-edited link still opens the page instead of failing.
 */
export function parseSection<T extends string>(
  raw: string | null,
  sections: readonly T[],
  fallback: T,
): T {
  return raw && (sections as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
