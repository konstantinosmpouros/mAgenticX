/**
 * The automation kind registry: how each kind of automation reads on the
 * Automations page (its card badge, icon and create action), and the page's
 * areas — one per kind.
 *
 * Why a registry: the page and its cards look a kind up here instead of
 * branching on it, so a new kind is one entry plus its card body — not a page
 * redesign. Only kinds that work today are registered; there are deliberately
 * no "coming soon" placeholders.
 */
import { CalendarClock, Workflow } from "lucide-react";

import type {
  AutomationItem,
  AutomationKind,
  AutomationKindMeta,
  AutomationsArea,
} from "@/shared/lib/types";

export const AUTOMATION_KINDS: Record<AutomationKind, AutomationKindMeta> = {
  schedule: {
    id: "schedule",
    label: "Schedule",
    icon: CalendarClock,
    badgeTone: "bg-primary/10 text-primary",
    createLabel: "New schedule",
  },
  workflow: {
    id: "workflow",
    label: "Workflow",
    icon: Workflow,
    badgeTone: "bg-info/10 text-info",
    createLabel: "New workflow",
  },
};

/** A kind's registry entry. */
export const automationKind = (kind: AutomationKind): AutomationKindMeta => AUTOMATION_KINDS[kind];

/** A stable id for a list item, unique across kinds (React keys, scroll targets). */
export const automationItemId = (item: AutomationItem): string => {
  switch (item.kind) {
    case "schedule":
      return `schedule:${item.task.id}`;
    case "workflow":
      return `workflow:${item.workflow.id}`;
  }
};

/** The page's areas, in switch order, each with the kind it holds. */
export const AUTOMATION_AREAS: { id: AutomationsArea; label: string; kind: AutomationKind }[] = [
  { id: "schedules", label: "Schedules", kind: "schedule" },
  { id: "workflows", label: "Workflows", kind: "workflow" },
];

/** The area shown when the URL names none (or one that does not exist). */
export const DEFAULT_AUTOMATIONS_AREA: AutomationsArea = "schedules";

/** The kind an area holds. */
export const areaKind = (area: AutomationsArea): AutomationKind =>
  AUTOMATION_AREAS.find((entry) => entry.id === area)?.kind ?? "schedule";
