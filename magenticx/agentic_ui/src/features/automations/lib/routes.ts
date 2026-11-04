/**
 * The Automations section's URLs, in one place.
 *
 *   /automations                   the Automations page
 *   /automations?agent=<id>        …with the create form open on that agent ("Schedule it")
 *   /automations?template=<id>     …with the create form filled in from that template
 *   /tasks                         the old Schedules URL: redirects here, query kept
 *                                  (kept one release for bookmarks, then removed)
 *
 * Prefix-matched, so the later sub-routes (`/automations/:id`) count as the
 * same page for the shell.
 */

export const AUTOMATIONS_PATH = "/automations";
/** The pre-Automations URL; only the redirect route uses it. */
export const LEGACY_TASKS_PATH = "/tasks";

/** The deep-link query parameters that open the create form. */
export const AGENT_PARAM = "agent";
export const TEMPLATE_PARAM = "template";

/** Whether a pathname is the Automations page or one of its sub-routes. */
export const isAutomationsPath = (pathname: string): boolean =>
  pathname === AUTOMATIONS_PATH || pathname.startsWith(`${AUTOMATIONS_PATH}/`);

/** The Automations page with the create form open on an agent. */
export const automationsForAgentPath = (agentId: string): string =>
  `${AUTOMATIONS_PATH}?${AGENT_PARAM}=${encodeURIComponent(agentId)}`;
