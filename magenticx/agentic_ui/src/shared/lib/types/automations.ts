// ------------------------------------------------------
// Automations — the UI's name for something that runs without you: a trigger
// plus a target. Two kinds: `schedule` (an agent + prompt on a clock, stored
// as a scheduled task) and `workflow` (a saved workflow; it is scheduled
// through its own start node, never from the Schedules area). The page has one
// area per kind; the union shapes below keep every `switch` on the kind checked.
// ------------------------------------------------------
import type { LucideIcon } from "lucide-react";

import type { ScheduleKind, ScheduledTask, TaskTargetMode } from "./tasks";
import type { Workflow } from "./workflows";

/** The kinds of automation the UI knows. */
export type AutomationKind = "schedule" | "workflow";

/** A schedule on the Automations page (Schedules area). */
export type ScheduleAutomationItem = { kind: "schedule"; task: ScheduledTask };

/** A workflow on the Automations page (Workflows area). */
export type WorkflowAutomationItem = { kind: "workflow"; workflow: Workflow };

/**
 * One card on the Automations page. A discriminated union on `kind`, so a new
 * kind adds a member (with its own payload) and every `switch` on `kind` is
 * checked for it by the compiler.
 */
export type AutomationItem = ScheduleAutomationItem | WorkflowAutomationItem;

/** The Automations page's two areas (`?view=`): schedules and workflows. */
export type AutomationsArea = "schedules" | "workflows";

/** What "Run now" on a workflow card did: started a run, or the workflow needs inputs first. */
export type WorkflowQuickRunResult = { started: true; runId: string } | { started: false };

/** A kind's entry in the kind registry: how its badge, icon and create button read. */
export type AutomationKindMeta = {
  id: AutomationKind;
  /** Badge text on a card ("Schedule", "Workflow"). */
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the badge's colours (semantic tokens only). */
  badgeTone: string;
  /** The create action for this kind ("New schedule", "New workflow"). */
  createLabel: string;
};

/**
 * Pre-fill values for the schedule form — shared by editing a task, a
 * template, and an agent's "Schedule it". Tools are agent-declared, not
 * carried per task.
 */
export type ScheduleFormInitial = {
  agentId?: string | null;
  title?: string | null;
  prompt?: string;
  targetMode?: TaskTargetMode | string;
  scheduleKind?: ScheduleKind | string;
  scheduleSpec?: Record<string, unknown>;
  timezone?: string | null;
  isPrivate?: boolean;
};

/** The Automations page's status filter (its toolbar's filter menu). */
export type AutomationStatusFilter = "all" | "running" | "active" | "paused" | "finished";

/** The Automations page's sort (its toolbar's sort menu). */
export type AutomationSort = "next_run" | "newest" | "name";

/**
 * A starter automation the user can create from the "Start from a template"
 * section. `instructions` becomes the task prompt; the schedule fields pre-fill
 * the create form. The agent is chosen in the form (templates don't pin an
 * agent or model). Times are clock-local — the form applies the user's timezone
 * to the cron expression.
 */
export type AutomationTemplate = {
  id: string;
  kind: AutomationKind;
  icon: LucideIcon;
  label: string;
  /** One-liner for the card. */
  description: string;
  /** The full prompt; becomes the task's instruction. */
  instructions: string;
  scheduleKind: ScheduleKind;
  scheduleSpec: Record<string, unknown>;
  /** Human cadence, e.g. "Daily at 8:00 AM". */
  scheduleLabel: string;
  targetMode: TaskTargetMode;
  category: string;
};
