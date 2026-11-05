import { ArrowDownRight, Minus, Plus } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowContextConfig, WorkflowSpec, WorkflowStepOption } from "@/shared/lib/types";
import { kindMeta } from "@/features/workflows/lib/kinds";
import {
  CODE_CONTEXT_KEY,
  CONTEXT_COUNT_MAX,
  CONTEXT_COUNT_MIN,
  CONTEXT_MODES,
  CONTEXT_STEPS_MAX,
  ICON_BUTTON,
} from "@/features/workflows/lib/builder/consts";
import { CODE_KIND } from "@/features/workflows/lib/builder/graph";
import { asContext, contextPreview, contextStepOptions } from "@/features/workflows/lib/builder/stepData";
import { EmptyNote } from "./FieldShell";

/** One step in the "Pick steps" list: its kind's glyph, its label, its id; its place in the order when picked. */
function StepRow({
  option,
  order,
  disabled,
  note,
  onToggle,
}: {
  option: WorkflowStepOption;
  /** 1-based position among the picked steps; 0 when not picked. */
  order: number;
  disabled: boolean;
  /** Why a picked id is odd (missing, not before this step). */
  note?: string;
  onToggle: () => void;
}) {
  const meta = kindMeta(option.kind);
  const Glyph = meta.icon;
  const picked = order > 0;
  return (
    <li>
      <label
        className={cn(
          "flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[hsl(var(--hover-surface))]",
          picked && "bg-primary/[0.06]",
          disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        <input
          type="checkbox"
          checked={picked}
          disabled={disabled}
          onChange={onToggle}
          className="h-4 w-4 flex-shrink-0 accent-[hsl(var(--primary))]"
        />
        <span
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
          style={{ background: `hsl(${meta.accent} / 0.12)`, color: `hsl(${meta.accent})` }}
          aria-hidden
        >
          <Glyph className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">{option.label}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {option.id}
            {note ? <span className="font-sans text-destructive"> · {note}</span> : null}
          </span>
        </span>
        {picked ? (
          <span className="flex h-5 min-w-[1.25rem] flex-shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[11px] font-semibold tabular-nums text-primary">
            <span className="sr-only">order </span>
            {order}
          </span>
        ) : null}
      </label>
    </li>
  );
}

/**
 * "Data from earlier steps" (`"x-widget": "context"`): which earlier steps'
 * outputs this step is sent when it runs — the one just before, the last N
 * that ran, steps picked from those upstream (kept in the order picked), or
 * none — and a line saying what that will be. A code step is told where it
 * arrives (`steps` in input.json).
 */
export function ContextField({
  id,
  value,
  onChange,
  spec,
  nodeId,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (value: WorkflowContextConfig) => void;
  /** The workflow, to offer upstream steps and preview; absent, the widget still edits the value. */
  spec?: WorkflowSpec;
  nodeId: string;
  describedBy?: string;
}) {
  const context = asContext(value);
  const set = (patch: Partial<WorkflowContextConfig>) => onChange({ ...context, ...patch });
  const options = spec ? contextStepOptions(spec, nodeId) : [];
  const kind = spec?.nodes.find((node) => node.id === nodeId)?.kind;
  const offered = new Set(options.map((option) => option.id));
  // Picked ids the list doesn't offer (deleted, or no longer upstream): shown so they can be unpicked.
  const strays: Array<{ option: WorkflowStepOption; note: string }> = context.steps
    .filter((step) => !offered.has(step))
    .map((step) => {
      const node = spec?.nodes.find((other) => other.id === step);
      return node
        ? { option: { id: step, label: node.label?.trim() || step, kind: node.kind }, note: "not before this step" }
        : { option: { id: step, label: step, kind: "" }, note: "missing" };
    });
  const toggle = (step: string) =>
    set({
      steps: context.steps.includes(step) ? context.steps.filter((other) => other !== step) : [...context.steps, step],
    });
  const full = context.steps.length >= CONTEXT_STEPS_MAX;

  return (
    // `${id}_steps` is where an issue on `context.steps` (the engine's path) moves focus.
    <div id={`${id}_steps`} tabIndex={-1} className="space-y-2.5 outline-none" aria-describedby={describedBy}>
      <div id={id} role="radiogroup" aria-label="Data from earlier steps" className="grid grid-cols-2 gap-1 rounded-xl border border-border/60 bg-muted/30 p-1">
        {CONTEXT_MODES.map((mode) => {
          const active = context.mode === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => set({ mode: mode.value })}
              className={cn(
                "min-h-[36px] truncate rounded-lg px-2 py-1.5 text-xs font-medium transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                active
                  ? "bg-background text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08)]"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              {mode.label}
            </button>
          );
        })}
      </div>

      {context.mode === "last" ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/50 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">How many steps</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => set({ count: context.count - 1 })}
              disabled={context.count <= CONTEXT_COUNT_MIN}
              aria-label="Fewer steps"
            >
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </button>
            <output aria-live="polite" aria-label="Steps to send" className="w-6 text-center text-sm font-semibold tabular-nums text-foreground">
              {context.count}
            </output>
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => set({ count: context.count + 1 })}
              disabled={context.count >= CONTEXT_COUNT_MAX}
              aria-label="More steps"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      {context.mode === "steps" ? (
        options.length || strays.length ? (
          <ul className="max-h-60 space-y-0.5 overflow-y-auto rounded-xl border border-border/60 bg-background/50 p-1" aria-label="Steps to send">
            {options.map((option) => {
              const order = context.steps.indexOf(option.id) + 1;
              return (
                <StepRow
                  key={option.id}
                  option={option}
                  order={order}
                  disabled={!order && full}
                  onToggle={() => toggle(option.id)}
                />
              );
            })}
            {strays.map(({ option, note }) => (
              <StepRow
                key={`stray-${option.id}`}
                option={option}
                order={context.steps.indexOf(option.id) + 1}
                disabled={false}
                note={note}
                onToggle={() => toggle(option.id)}
              />
            ))}
          </ul>
        ) : (
          <EmptyNote>No steps come before this one yet. Connect one into it to pick it here.</EmptyNote>
        )
      ) : null}

      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
        <ArrowDownRight className="mt-[2px] h-3.5 w-3.5 flex-shrink-0 text-primary/70" aria-hidden />
        <span className="min-w-0 break-words">{contextPreview(spec, nodeId, context)}</span>
      </p>
      {kind === CODE_KIND && context.mode !== "none" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your code reads it as <span className="font-mono text-foreground/80">{CODE_CONTEXT_KEY}</span> in input.json.
        </p>
      ) : null}
    </div>
  );
}
