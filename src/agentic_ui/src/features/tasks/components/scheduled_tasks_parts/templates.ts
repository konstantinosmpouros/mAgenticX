import type { LucideIcon } from "lucide-react";
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

import type { ScheduleKind, TaskTargetMode } from "@/shared/lib/types";

/**
 * A starter scheduled-task definition the user can import from the Templates tab.
 * `instructions` becomes the task prompt; the schedule fields pre-fill the create
 * form. The agent + tools are chosen by the user at import time (templates are
 * platform-agnostic, so they don't pin an agent/model). Times are clock-local —
 * the import applies the user's timezone to the cron expression.
 */
export type ScheduledTaskTemplate = {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string; // one-liner for the card
  instructions: string; // full prompt, shown in detail + used as the task prompt
  scheduleKind: ScheduleKind;
  scheduleSpec: Record<string, unknown>;
  scheduleLabel: string; // human cadence, e.g. "Daily at 8:00 AM"
  targetMode: TaskTargetMode;
  category: string;
};

export const TASK_TEMPLATES: ScheduledTaskTemplate[] = [
  {
    id: "daily-briefing",
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
