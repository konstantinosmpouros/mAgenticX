/**
 * The workflow view's URLs, in one place (plan 38, step 2).
 *
 *   /workflows/:workflowId                  a workflow, showing its latest run
 *   /workflows/:workflowId/runs/:runId      …showing that run
 *   /workflows/new                          the builder, a new workflow (step 3)
 *   /workflows/:workflowId/edit             the builder, editing one
 *   /workflows/:workflowId/edit?panel=history   …with its History panel open
 *
 * There is no "/workflows" index: workflows are listed (and created) on the
 * Automations page's Workflows area (`/automations?view=workflows`), with a
 * quick-access list in the sidebar. Prefix-matched, so the shell treats every
 * sub-route as the same page.
 */

export const WORKFLOWS_PATH = "/workflows";

/** `/workflows/new`'s segment: never a workflow id (ids are server-made UUIDs). */
const NEW_SEGMENT = "new";

/** Whether a pathname is the workflow view (any workflow, any run). */
export const isWorkflowsPath = (pathname: string): boolean =>
  pathname === WORKFLOWS_PATH || pathname.startsWith(`${WORKFLOWS_PATH}/`);

/** The workflow id in a workflow-view pathname, or null elsewhere. */
export const workflowIdFromPath = (pathname: string): string | null => {
  if (!pathname.startsWith(`${WORKFLOWS_PATH}/`)) return null;
  const segment = pathname.slice(WORKFLOWS_PATH.length + 1).split("/")[0];
  if (!segment || segment === NEW_SEGMENT) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const workflowPath = (workflowId: string): string =>
  `${WORKFLOWS_PATH}/${encodeURIComponent(workflowId)}`;

export const workflowRunPath = (workflowId: string, runId: string): string =>
  `${workflowPath(workflowId)}/runs/${encodeURIComponent(runId)}`;

/** The builder for a new workflow. */
export const newWorkflowPath = (): string => `${WORKFLOWS_PATH}/${NEW_SEGMENT}`;

/** The builder for an existing workflow. */
export const workflowEditPath = (workflowId: string): string => `${workflowPath(workflowId)}/edit`;

/** The builder's `?panel=` value that opens its History panel. */
export const HISTORY_PANEL_PARAM = "history";

/** The builder for an existing workflow, its History panel open. */
export const workflowHistoryPath = (workflowId: string): string =>
  `${workflowEditPath(workflowId)}?panel=${HISTORY_PANEL_PARAM}`;
