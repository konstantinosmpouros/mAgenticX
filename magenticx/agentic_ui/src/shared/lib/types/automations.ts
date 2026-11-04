// ------------------------------------------------------
// Automations — the UI's name for something that runs without you: a trigger
// plus a target. Phase 1 has one kind, `schedule` (an agent + prompt on a
// clock), stored as a scheduled task. The union shapes below are what let a
// later kind (a `workflow`) slot in as one more member instead of a redesign.
// ------------------------------------------------------
import type { LucideIcon } from "lucide-react";

import type { ScheduleKind, ScheduledTask, TaskTargetMode } from "./tasks";

/** The kinds of automation the UI knows. Phase 1: schedules only. */
export type AutomationKind = "schedule";

/**
 * One row of the Automations list. A discriminated union on `kind`, so a new
 * kind adds a member (with its own payload) and every `switch` on `kind` is
 * checked for it by the compiler.
 */
export type AutomationItem = { kind: "schedule"; task: ScheduledTask };

/** A kind's entry in the kind registry: how its badge, icon and create button read. */
export type AutomationKindMeta = {
  id: AutomationKind;
  /** Badge text on a card ("Schedule"). */
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the badge's colours (semantic tokens only). */
  badgeTone: string;
  /** The create action for this kind ("Schedule an agent"). */
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

/** The Automations page's status filter chips. */
export type AutomationStatusFilter = "all" | "running" | "active" | "paused" | "finished";

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
