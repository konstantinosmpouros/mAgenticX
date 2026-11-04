/**
 * The Automations page's status filter chips and search: which items each chip
 * keeps, the chips' counts, and the free-text match.
 *
 * The chips replace the old My tasks / Templates tabs, and their counts replace
 * the header's "N running · M active" line. Kept pure (no React) so the
 * predicates are tested on their own.
 */
import type { AutomationItem, AutomationStatusFilter } from "@/shared/lib/types";
import { isRunningTask } from "@/features/automations/lib/schedule";

/** The chips, in display order. */
export const STATUS_FILTERS: { id: AutomationStatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "finished", label: "Finished" },
];

/** The search box appears once the list is long enough to need it. */
export const SEARCH_MIN_ITEMS = 8;

/**
 * Whether an item belongs under a chip. "Running" is a live run (whatever the
 * stored status); "Finished" is a task that will not run again — completed, or
 * stopped by a failure.
 */
export function matchesStatusFilter(item: AutomationItem, filter: AutomationStatusFilter): boolean {
  const { task } = item;
  switch (filter) {
    case "all":
      return true;
    case "running":
      return isRunningTask(task);
    case "active":
      return task.status === "active";
    case "paused":
      return task.status === "paused";
    case "finished":
      return task.status === "completed" || task.status === "failed";
  }
}

/** Case-insensitive match on what a card shows: title, instruction, agent. */
export function matchesQuery(item: AutomationItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { task } = item;
  return [task.title, task.prompt, task.agentName].some((field) =>
    String(field ?? "")
      .toLowerCase()
      .includes(q),
  );
}

/** Each chip's count, for the labels. */
export function statusFilterCounts(
  items: AutomationItem[],
): Record<AutomationStatusFilter, number> {
  const counts: Record<AutomationStatusFilter, number> = {
    all: 0,
    running: 0,
    active: 0,
    paused: 0,
    finished: 0,
  };
  for (const item of items) {
    for (const { id } of STATUS_FILTERS) if (matchesStatusFilter(item, id)) counts[id] += 1;
  }
  return counts;
}

/** The items a chip and a query leave visible, in list order. */
export const filterAutomations = (
  items: AutomationItem[],
  filter: AutomationStatusFilter,
  query: string,
): AutomationItem[] =>
  items.filter((item) => matchesStatusFilter(item, filter) && matchesQuery(item, query));
