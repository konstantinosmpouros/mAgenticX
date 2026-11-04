/**
 * The automation kind registry: how each kind of automation reads on the
 * Automations page (its card badge, icon and create action).
 *
 * Why a registry: the page and its cards look a kind up here instead of
 * branching on it, so a new kind (a `workflow`, later) is one entry plus its
 * card body — not a page redesign. Only kinds that work today are registered;
 * there are deliberately no "coming soon" placeholders.
 */
import { CalendarClock } from "lucide-react";

import type { AutomationItem, AutomationKind, AutomationKindMeta } from "@/shared/lib/types";

export const AUTOMATION_KINDS: Record<AutomationKind, AutomationKindMeta> = {
  schedule: {
    id: "schedule",
    label: "Schedule",
    icon: CalendarClock,
    badgeTone: "bg-primary/10 text-primary",
    createLabel: "Schedule an agent",
  },
};

/** A kind's registry entry. */
export const automationKind = (kind: AutomationKind): AutomationKindMeta => AUTOMATION_KINDS[kind];

/** A stable id for a list item, unique across kinds (React keys, scroll targets). */
export const automationItemId = (item: AutomationItem): string => `${item.kind}:${item.task.id}`;
