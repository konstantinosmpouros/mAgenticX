import {
  Activity,
  BookOpen,
  ClipboardList,
  Moon,
  Newspaper,
  Sunrise,
  Telescope,
  TrendingUp,
} from "lucide-react";

import type { AutomationTemplate } from "@/shared/lib/types";

/**
 * The starter automations shown under "Start from a template" (and as the
 * empty state's main content). Choosing one opens the create dialog filled in
 * with these fields — the dialog is the preview, so there is no separate detail
 * view. Order matters: the compact section shows the first few, in this order.
 */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-briefing",
    kind: "schedule",
    icon: Sunrise,
    label: "Daily briefing",
    description: "A concise morning briefing to start the day.",
    instructions:
      "Give me a concise morning briefing for today.\n\n" +
      "Cover, in short bullets:\n" +
      "- The most important things to be aware of right now.\n" +
      "- Anything that changed since the last briefing.\n" +
      "- Suggested priorities for the day.\n\n" +
      "Keep it skimmable — no preamble.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 8 * * *" },
    scheduleLabel: "Daily at 8:00 AM",
    targetMode: "bound",
    category: "System",
  },
  {
    id: "weekday-standup",
    kind: "schedule",
    icon: ClipboardList,
    label: "Weekday standup",
    description: "Summarize yesterday and tee up today, every weekday.",
    instructions:
      "Prepare a short standup update.\n\n" +
      "- What progressed since yesterday.\n" +
      "- What's planned for today.\n" +
      "- Any blockers or risks worth flagging.\n\n" +
      "Three tight sections, bullets only.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 9 * * 1-5" },
    scheduleLabel: "Weekdays at 9:00 AM",
    targetMode: "bound",
    category: "System",
  },
  {
    id: "end-of-day-recap",
    kind: "schedule",
    icon: Moon,
    label: "End-of-day recap",
    description: "Wrap up what happened and what's still open.",
    instructions:
      "Recap the day.\n\n" +
      "- What got done.\n" +
      "- What's still open or carried over.\n" +
      "- One thing to prepare for tomorrow.\n\n" +
      "Keep it brief and grounded — don't invent activity; if there's nothing notable, say so.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 18 * * 1-5" },
    scheduleLabel: "Weekdays at 6:00 PM",
    targetMode: "fresh",
    category: "System",
  },
  {
    id: "research-watch",
    kind: "schedule",
    icon: Telescope,
    label: "Research watch",
    description: "Track the latest developments on a topic you care about.",
    instructions:
      "Find and summarize the latest notable developments on: <replace with your topic>.\n\n" +
      "Grounding rules:\n" +
      "- Prefer primary and reputable sources; include links when available.\n" +
      "- Only report concrete, verifiable items; if evidence is weak, skip it and say so.\n" +
      "- Note what is genuinely new since the last run.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 9 * * *" },
    scheduleLabel: "Daily at 9:00 AM",
    targetMode: "fresh",
    category: "System",
  },
  {
    id: "news-digest",
    kind: "schedule",
    icon: Newspaper,
    label: "News digest",
    description: "A curated digest on the subjects you follow.",
    instructions:
      "Compile a short digest of the most important news on: <replace with your subjects>.\n\n" +
      "- Group by theme.\n" +
      "- One line per item with a source link when available.\n" +
      "- Lead with what matters most.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 7 * * *" },
    scheduleLabel: "Daily at 7:00 AM",
    targetMode: "fresh",
    category: "System",
  },
  {
    id: "weekly-report",
    kind: "schedule",
    icon: TrendingUp,
    label: "Weekly report",
    description: "A status report compiled at the start of the week.",
    instructions:
      "Compile a weekly status report.\n\n" +
      "- Highlights and progress from the past week.\n" +
      "- Open items and their status.\n" +
      "- Priorities and risks for the coming week.\n\n" +
      "Structure it as an executive summary followed by sections.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 9 * * 1" },
    scheduleLabel: "Mondays at 9:00 AM",
    targetMode: "bound",
    category: "System",
  },
  {
    id: "knowledge-refresh",
    kind: "schedule",
    icon: BookOpen,
    label: "Knowledge refresh",
    description: "Periodically review and summarize a knowledge area.",
    instructions:
      "Review and summarize what's new or worth re-learning in: <replace with your area>.\n\n" +
      "- A few key takeaways.\n" +
      "- Anything that supersedes earlier understanding.\n" +
      "- One suggested next thing to look into.",
    scheduleKind: "cron",
    scheduleSpec: { cron_expr: "0 10 * * 5" },
    scheduleLabel: "Fridays at 10:00 AM",
    targetMode: "fresh",
    category: "System",
  },
  {
    id: "periodic-monitor",
    kind: "schedule",
    icon: Activity,
    label: "Periodic monitor",
    description: "Check on something regularly and flag changes.",
    instructions:
      "Check the current state of: <replace with what to monitor>.\n\n" +
      "- Report only what changed since the last check.\n" +
      "- If nothing material changed, say so in one line.\n" +
      "- Flag anything that needs attention.",
    scheduleKind: "interval",
    scheduleSpec: { interval_seconds: 21600 },
    scheduleLabel: "Every 6 hours",
    targetMode: "bound",
    category: "System",
  },
];

/** A template by id (the `?template=` deep link), or null when there is none. */
export const findTemplate = (id: string): AutomationTemplate | null =>
  AUTOMATION_TEMPLATES.find((template) => template.id === id) ?? null;
