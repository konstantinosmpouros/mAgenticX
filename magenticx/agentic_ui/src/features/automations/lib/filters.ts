/**
 * The Automations page's status filter chips and search: which items each chip
 * keeps, the chips' counts, and the free-text match (schedules and workflows).
 *
 * The chips replace the old My tasks / Templates tabs, and their counts replace
 * the header's "N running · M active" line. Kept pure (no React) so the
 * predicates are tested on their own.
 */
import type {
  AutomationSort,
  AutomationStatusFilter,
  ScheduleAutomationItem,
  WorkflowAutomationItem,
} from "@/shared/lib/types";
import { isRunningTask } from "@/features/automations/lib/schedule";

/**
 * The status filters, in display order, each with its dot's colour (a theme
 * token, so it follows light and dark). "All" has no dot.
 */
export const STATUS_FILTERS: { id: AutomationStatusFilter; label: string; dot: string | null }[] = [
  { id: "all", label: "All", dot: null },
  { id: "running", label: "Running", dot: "bg-[hsl(var(--success))]" },
  { id: "active", label: "Active", dot: "bg-primary" },
  { id: "paused", label: "Paused", dot: "bg-[hsl(var(--warning))]" },
  { id: "finished", label: "Finished", dot: "bg-muted-foreground/60" },
];

/** The sort menu's options, in display order; the first is the default. */
export const SORT_OPTIONS: { id: AutomationSort; label: string; hint: string }[] = [
  { id: "next_run", label: "Next run", hint: "Soonest first" },
  { id: "newest", label: "Newest", hint: "Last created first" },
  { id: "name", label: "Name", hint: "A to Z" },
];

export const DEFAULT_SORT: AutomationSort = "next_run";

const time = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/** Ascending by a time that may be missing: the missing ones last. */
const bySoonest = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * The schedules in the chosen order. Next run: soonest first (nothing coming
 * — paused, finished — last); newest: last created first; name: A to Z. Ties
 * keep the list's order.
 */
export function sortAutomations(items: ScheduleAutomationItem[], sort: AutomationSort): ScheduleAutomationItem[] {
  const sorted = [...items];
  if (sort === "next_run") sorted.sort((a, b) => bySoonest(time(a.task.nextRunAt), time(b.task.nextRunAt)));
  else if (sort === "newest") sorted.sort((a, b) => (time(b.task.createdAt) ?? 0) - (time(a.task.createdAt) ?? 0));
  else sorted.sort((a, b) => byName(a.task.title || a.task.prompt || "", b.task.title || b.task.prompt || ""));
  return sorted;
}

/** The workflows in the chosen order (next run: their start step's schedule; by hand last). */
export function sortWorkflowItems(items: WorkflowAutomationItem[], sort: AutomationSort): WorkflowAutomationItem[] {
  const sorted = [...items];
  if (sort === "next_run") {
    sorted.sort((a, b) => bySoonest(time(a.workflow.schedule?.nextRunAt), time(b.workflow.schedule?.nextRunAt)));
  } else if (sort === "newest") {
    sorted.sort((a, b) => (time(b.workflow.createdAt) ?? 0) - (time(a.workflow.createdAt) ?? 0));
  } else {
    sorted.sort((a, b) => byName(a.workflow.name, b.workflow.name));
  }
  return sorted;
}

/**
 * Whether an item belongs under a chip. "Running" is a live run (whatever the
 * stored status); "Finished" is a task that will not run again — completed, or
 * stopped by a failure.
 */
export function matchesStatusFilter(
  item: ScheduleAutomationItem,
  filter: AutomationStatusFilter,
): boolean {
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
export function matchesQuery(item: ScheduleAutomationItem, query: string): boolean {
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
  items: ScheduleAutomationItem[],
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
  items: ScheduleAutomationItem[],
  filter: AutomationStatusFilter,
  query: string,
): ScheduleAutomationItem[] =>
  items.filter((item) => matchesStatusFilter(item, filter) && matchesQuery(item, query));

/** Case-insensitive match on what a workflow card shows: name and description. */
export function matchesWorkflowQuery(item: WorkflowAutomationItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { workflow } = item;
  return [workflow.name, workflow.description].some((field) =>
    String(field ?? "")
      .toLowerCase()
      .includes(q),
  );
}

/** The workflows a query leaves visible, in list order. */
export const filterWorkflowItems = (
  items: WorkflowAutomationItem[],
  query: string,
): WorkflowAutomationItem[] => items.filter((item) => matchesWorkflowQuery(item, query));
