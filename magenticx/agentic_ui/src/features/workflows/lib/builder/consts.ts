import { CalendarDays, Repeat, Timer, type LucideIcon } from "lucide-react";

import type { ScheduleKind, WorkflowContextConfig, WorkflowContextMode, WorkflowMemoryMode, WorkflowSchemaFieldType, WorkflowSchemaItemType } from "@/shared/lib/types";

/**
 * The workflow builder's constants: its controls' classes (the agent
 * builder's inspector look, so the two builders read as one tool), the
 * palette's groups, and the drag-and-drop type a palette item carries.
 */

/** A text field / select trigger, as in the agent builder's inspector. */
export const INPUT =
  "w-full rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.02)] transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-border focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:focus-visible:ring-destructive/25";

/** A compact field inside a row (a rule, a map entry). */
export const INPUT_SM =
  "w-full min-w-0 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-[13px] text-foreground transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 aria-[invalid=true]:border-destructive/60";

export const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * "Add rule", "Add case", "Add entry": a quiet text action in the accent, not
 * another bordered box in a form that is already made of fields.
 */
export const ADD_BUTTON =
  "-ml-1.5 inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40";

export const ICON_BUTTON =
  "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40";

/** The top bar's pills (the agent builder's sizes). */
export const BAR_PRIMARY =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

export const BAR_SECONDARY =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--hover-surface))] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A kind's icon tile (palette and drag ghost): its accent comes from
 * `--wf-accent` (set per item from `kindMeta`), a theme token, so it follows
 * light and dark.
 */
export const PALETTE_TILE =
  "flex flex-shrink-0 items-center justify-center rounded-[0.65rem] bg-[hsl(var(--wf-accent)/0.12)] text-[hsl(var(--wf-accent))] shadow-[inset_0_0_0_1px_hsl(var(--wf-accent)/0.16)] transition-[background-color,box-shadow,transform] duration-200";

/** A palette row: a quiet card that lifts on hover and focus. */
export const PALETTE_ROW =
  "group/item relative flex w-full cursor-grab items-center gap-3 overflow-hidden rounded-xl border border-transparent pl-2 pr-2 text-left outline-none transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out hover:-translate-y-px hover:border-border/70 hover:bg-background hover:shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_10px_22px_-14px_hsl(var(--foreground)/0.4)] focus-visible:border-primary/50 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/25 active:translate-y-0 active:cursor-grabbing motion-reduce:transition-none motion-reduce:hover:translate-y-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:translate-y-0 aria-disabled:hover:border-transparent aria-disabled:hover:bg-transparent aria-disabled:hover:shadow-none";

/** The palette's motion: a group folding, the panel sliding in. */
export const PALETTE_MOTION = {
  durationMs: 240,
  ease: [0.22, 1, 0.36, 1] as const,
  cssEase: "cubic-bezier(0.22, 1, 0.36, 1)",
};

/** A palette row's height (px): tile, name and description. */
export const PALETTE_ROW_HEIGHT = 52;

/** The palette's groups, in order, with their headings (a group the catalogue grows later goes last). */
export const PALETTE_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "trigger", label: "Start" },
  { id: "ai", label: "AI" },
  { id: "data", label: "Data" },
  { id: "tools", label: "Tools" },
  { id: "flow", label: "Flow" },
  { id: "output", label: "Finish" },
  { id: "developer", label: "For developers" },
];

/** Where the palette's open / shut choice is remembered on this device. */
export const PALETTE_OPEN_STORAGE_KEY = "magenticx:workflow-builder:palette-open";

/** Where the palette's folded groups (their ids) are remembered on this device. */
export const PALETTE_GROUPS_STORAGE_KEY = "magenticx:workflow-builder:palette-groups-collapsed";

/** The palette panel's width over the canvas's left edge (rem). */
export const PALETTE_WIDTH_REM = 17;

/** The inspector drawer's width over the canvas (px), short of the canvas's own width. */
export const INSPECTOR_DRAWER_WIDTH = 420;

/** The drag type a palette item carries onto the canvas; its value is the kind. */
export const PALETTE_DRAG_TYPE = "application/x-magenticx-workflow-kind";

/** The value types a run input may have. */
export const VALUE_TYPES = ["string", "number", "boolean", "object", "array"] as const;

/** The schedule trigger's kind tabs, in the order people reach for them. */
export const SCHEDULE_KIND_TABS: ReadonlyArray<{ id: ScheduleKind; label: string; icon: LucideIcon }> = [
  { id: "one_off", label: "Once", icon: Timer },
  { id: "interval", label: "Every…", icon: Repeat },
  { id: "cron", label: "Cron", icon: CalendarDays },
];

/** One-click cron expressions for the schedule trigger's Custom tab. */
export const SCHEDULE_CRON_PRESETS: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "Weekdays at 09:00", expr: "0 9 * * 1-5" },
  { label: "Daily at 08:00", expr: "0 8 * * *" },
  { label: "Hourly", expr: "0 * * * *" },
];

/** An llm / code step's `context` when the config has none: the engine's default. */
export const DEFAULT_CONTEXT: WorkflowContextConfig = { mode: "previous", count: 3, steps: [] };

/** The context widget's choices, in the order people reach for them. */
export const CONTEXT_MODES: ReadonlyArray<{ value: WorkflowContextMode; label: string }> = [
  { value: "previous", label: "Previous step" },
  { value: "last", label: "Last steps" },
  { value: "steps", label: "Pick steps" },
  { value: "none", label: "None" },
];

/** "Last steps": how many (the engine's bounds). */
export const CONTEXT_COUNT_MIN = 1;
export const CONTEXT_COUNT_MAX = 10;
/** "Pick steps": at most this many. */
export const CONTEXT_STEPS_MAX = 20;

/** The `inputs` key a code step's context arrives under in input.json (so `inputs` may not use it). */
export const CODE_CONTEXT_KEY = "steps";

/** The llm step's memory choices, as radio cards. */
export const MEMORY_CHOICES: ReadonlyArray<{ value: WorkflowMemoryMode; label: string; hint: string }> = [
  { value: "continue", label: "Remember earlier turns", hint: "In a loop, the model sees its previous iterations." },
  { value: "fresh", label: "Start fresh every time", hint: "Each run of this step is a new conversation." },
];

/** "Share with: This step only" — a select can't hold an empty value, so the empty thread goes by this. */
export const OWN_THREAD = "__own__";

/** A conversation id (`thread`): the engine's pattern and length. */
export const THREAD_PATTERN = /^[A-Za-z0-9_-]*$/;
export const THREAD_MAX = 64;

/** The structured-output builder's property types. */
export const SCHEMA_FIELD_TYPES: ReadonlyArray<WorkflowSchemaFieldType> = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
];

/** What a reply's list field may hold, item by item. */
export const SCHEMA_ITEM_TYPES: ReadonlyArray<WorkflowSchemaItemType> = ["string", "number", "integer", "boolean"];

/**
 * The reply builder's one "Type" choice, in words: a JSON type, a text field
 * with set values ("Choice"), or a list of one kind of value. `parse` splits
 * it back into the field's `type` / `itemType`.
 */
export const SCHEMA_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "string", label: "Text" },
  { value: "choice", label: "Choice" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Whole number" },
  { value: "boolean", label: "Yes / no" },
  { value: "array:string", label: "List of text" },
  { value: "array:number", label: "List of numbers" },
  { value: "array:integer", label: "List of whole numbers" },
  { value: "array:boolean", label: "List of yes / no" },
  { value: "array", label: "List (anything)" },
  { value: "object", label: "Object (anything)" },
];

/** A structured-output property name: an identifier. */
export const SCHEMA_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * A `{{path}}` chip in a template field: a quiet inline token that reads as
 * `Source › Field`, truncated so a long step name never widens the field.
 */
export const TEMPLATE_CHIP =
  "mx-px inline-flex max-w-[min(15rem,100%)] select-none items-center gap-1 whitespace-nowrap rounded-md bg-primary/[0.09] px-1.5 py-px align-baseline font-sans text-[12px] font-medium leading-[18px] text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.14)]";

/** A chip whose path the field cannot read: its raw path, in the error colour. */
export const TEMPLATE_CHIP_INVALID =
  "mx-px inline-block max-w-[min(15rem,100%)] select-none truncate whitespace-nowrap rounded-md bg-destructive/10 px-1.5 py-px align-middle font-mono text-[11.5px] leading-[18px] text-destructive underline decoration-destructive/50 decoration-wavy underline-offset-2 shadow-[inset_0_0_0_1px_hsl(var(--destructive)/0.25)]";

/** A chip's source (the step's name): muted, and the first part to give way. */
export const TEMPLATE_CHIP_SOURCE = "min-w-0 max-w-[7rem] flex-shrink truncate text-primary/70";
export const TEMPLATE_CHIP_SEP = "flex-shrink-0 text-primary/40";


/** How long the tool step's tool list (`GET /v1/workflows/tools`) is reused before it is asked for again (ms). */
export const WORKFLOW_TOOLS_STALE_MS = 5 * 60 * 1000;

/** The tool picker's group for the agents' own tools. */
export const TOOL_GROUP_BUILTIN = "Built-in";

/** The tool picker's group for a gateway tool whose server is not known. */
export const TOOL_GROUP_MCP = "MCP";

/** Enter / exit for the small things a field reveals (its hint, a folded section). */
export const REVEAL = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, y: -2, transition: { duration: 0.13, ease: "easeIn" } },
} as const;
export const REVEAL_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.01 } },
  exit: { opacity: 0, transition: { duration: 0.01 } },
} as const;
