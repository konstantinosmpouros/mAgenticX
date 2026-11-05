import {
  Bell,
  Bot,
  Box,
  Braces,
  CalendarClock,
  CodeXml,
  Flag,
  GitBranch,
  Globe,
  Play,
  Repeat,
  ShieldCheck,
  Sparkles,
  Split,
  Timer,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { WorkflowNodeDef, WorkflowNodeKindInfo } from "@/shared/lib/types";

/**
 * A node kind as the workflow canvas shows it: an icon, an accent, a label and
 * its group. The catalogue (`GET /v1/workflows/catalog`) is the source of the
 * label and group; the icon and accent are ours, picked by the kind's name, so
 * a kind the catalogue grows later still gets a sensible look (and the generic
 * box otherwise).
 */

/** The families a node kind falls into on the canvas (icon + accent colour). */
export type WorkflowKindCategory =
  | "trigger"
  | "schedule"
  | "fetch"
  | "tool"
  | "agent"
  | "llm"
  | "code"
  | "condition"
  | "router"
  | "loop"
  | "approval"
  | "wait"
  | "notify"
  | "transform"
  | "end"
  | "unknown";

/**
 * A kind's look on the canvas: its glyph and its accent — an HSL triplet
 * expression from the theme's tokens (`var(--info)`), used as
 * `hsl(var(--wf-accent) / α)` so it follows every theme, light or dark.
 */
export type WorkflowKindMeta = {
  category: WorkflowKindCategory;
  icon: LucideIcon;
  accent: string;
};

/** Icon + accent per family. Tokens only, so a theme change recolours the canvas. */
export const KIND_META: Record<WorkflowKindCategory, Omit<WorkflowKindMeta, "category">> = {
  trigger: { icon: Play, accent: "var(--primary)" },
  // The schedule trigger: a calendar clock in the info accent, so a workflow
  // that runs on its own reads apart from a manual start at a glance.
  schedule: { icon: CalendarClock, accent: "var(--info)" },
  fetch: { icon: Globe, accent: "var(--info)" },
  tool: { icon: Wrench, accent: "var(--primary-glow)" },
  agent: { icon: Bot, accent: "var(--primary)" },
  // A single model call: sparkles in the glow accent, apart from a full agent.
  llm: { icon: Sparkles, accent: "var(--primary-glow)" },
  // Python in the sandbox: a code glyph in the info accent.
  code: { icon: CodeXml, accent: "var(--info)" },
  condition: { icon: GitBranch, accent: "var(--warning)" },
  router: { icon: Split, accent: "var(--warning)" },
  loop: { icon: Repeat, accent: "var(--info)" },
  approval: { icon: ShieldCheck, accent: "var(--primary-glow)" },
  wait: { icon: Timer, accent: "var(--muted-foreground)" },
  notify: { icon: Bell, accent: "var(--primary-glow)" },
  transform: { icon: Braces, accent: "var(--info)" },
  end: { icon: Flag, accent: "var(--muted-foreground)" },
  unknown: { icon: Box, accent: "var(--muted-foreground)" },
};

/** First match wins: `[test on the kind id, family]`. */
const KIND_MATCHERS: Array<[RegExp, WorkflowKindCategory]> = [
  [/^trigger\.schedule|cron|schedule/, "schedule"],
  [/^trigger\./, "trigger"],
  [/approval|approve|human/, "approval"],
  [/condition|if$|^if\./, "condition"],
  [/router|switch/, "router"],
  [/loop|foreach|repeat|while/, "loop"],
  [/wait|delay|sleep/, "wait"],
  [/fetch|http|request|webhook/, "fetch"],
  // `llm` (and a prompt-shaped kind) is one model call, not an agent run.
  [/llm|prompt/, "llm"],
  [/agent/, "agent"],
  [/^code$|^code\.|python|script/, "code"],
  [/tool|mcp/, "tool"],
  [/notify|email|slack|message/, "notify"],
  [/end|output|finish|return/, "end"],
  [/set|transform|map|json|state/, "transform"],
];

/** A kind's family; a kind the catalogue grows later still lands somewhere sensible. */
export const kindCategory = (kind: string): WorkflowKindCategory =>
  KIND_MATCHERS.find(([test]) => test.test(kind.toLowerCase()))?.[1] ?? "unknown";

/** A kind's family, glyph and accent (the generic box for an unknown kind). */
export const kindMeta = (kind: string): WorkflowKindMeta => {
  const category = kindCategory(kind);
  return { category, ...KIND_META[category] };
};

export const kindIcon = (kind: string): LucideIcon => kindMeta(kind).icon;

/**
 * A few words per kind for the palette row. The catalogue's description is
 * the full contract (limits, branches) and belongs in the tooltip; a row has
 * room for one short line.
 */
const KIND_BLURBS: Record<string, string> = {
  "trigger.manual": "Starts when you run it",
  "trigger.schedule": "Starts on a schedule",
  fetch: "Call an HTTP endpoint",
  tool: "Run an MCP or native tool",
  condition: "Branch on true / false",
  router: "Pick a branch by rules",
  loop: "Repeat a branch",
  approval: "Wait for a human decision",
  end: "Finish and return a result",
  llm: "Ask a model, get text or JSON",
  set: "Write values into state",
  wait: "Pause for a while",
  code: "Run Python in the sandbox",
};

/** The palette's one-line blurb for a kind; the catalogue description otherwise. */
export const kindBlurb = (kind: string, fallback = ""): string => KIND_BLURBS[kind] ?? fallback;

/** `trigger.manual` → "Trigger manual" when the catalogue does not know it. */
export const humanizeKind = (kind: string): string => {
  const words = kind.replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Node";
};

export type WorkflowKindView = { label: string; group: string; icon: LucideIcon };

/** A kind's label, group and icon, from the catalogue when it lists it. */
export function kindView(catalog: WorkflowNodeKindInfo[], kind: string): WorkflowKindView {
  const info = catalog.find((entry) => entry.kind === kind);
  return {
    label: info?.label ?? humanizeKind(kind),
    group: info?.group ?? kind.split(".")[0] ?? "",
    icon: kindIcon(kind),
  };
}

/** What a node is called on screen: its label, else its id. */
export const nodeLabel = (
  node: Pick<WorkflowNodeDef, "id" | "label"> | undefined,
  fallback = "",
): string => node?.label?.trim() || node?.id || fallback;
