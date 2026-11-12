import * as React from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, AlertTriangle, ChevronDown, Info, SlidersHorizontal } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { REVEAL, REVEAL_REDUCED } from "@/features/workflows/lib/builder/consts";
import type { WorkflowBuilderIssue } from "@/shared/lib/types";

/**
 * The inspector's field chrome — the agent builder's (label, control, its
 * issues under it), so a workflow step's form and an agent's read as the same
 * tool. A field's explanation sits behind an (i) beside its label instead of
 * under every control: the form stays quiet, and the help is one tap away
 * (a toggle rather than a tooltip, so it works on touch too).
 */



/** A field's issues, each on its own line, errors before warnings. */
export function FieldIssues({ issues, id }: { issues: readonly WorkflowBuilderIssue[]; id?: string }) {
  if (!issues.length) return null;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return (
    <ul id={id} className="mt-1.5 space-y-1">
      {sorted.map((item) => {
        const error = item.severity === "error";
        const Icon = error ? AlertCircle : AlertTriangle;
        return (
          <li
            key={item.id}
            className={cn(
              "flex items-start gap-1.5 text-xs leading-snug",
              error ? "text-destructive" : "text-[hsl(var(--warning))]",
            )}
          >
            <Icon className="mt-[1px] h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            <span>{item.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  aside,
  issues = [],
  issuesId,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  /** The field's explanation, shown on demand from the (i) beside the label. */
  hint?: ReactNode;
  /** Right of the label: the template helper, a counter. */
  aside?: ReactNode;
  issues?: readonly WorkflowBuilderIssue[];
  issuesId?: string;
  children: ReactNode;
  className?: string;
}) {
  const [showHint, setShowHint] = React.useState(false);
  const reduceMotion = useReducedMotion();
  const hintId = React.useId();
  return (
    <div className={cn("flex flex-col", className)}>
      {label || hint || aside ? (
        <div className="mb-1.5 flex min-h-[1.25rem] items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1">
            {/* The id names a control that is no labelable element (a template field) via aria-labelledby. */}
            <label
              htmlFor={htmlFor}
              id={htmlFor ? `${htmlFor}-label` : undefined}
              className="text-xs font-medium text-muted-foreground"
            >
              {label}
              {required ? (
                <>
                  <span className="ml-0.5 text-destructive/80" aria-hidden>
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </>
              ) : null}
            </label>
            {hint ? (
              <button
                type="button"
                onClick={() => setShowHint((value) => !value)}
                aria-expanded={showHint}
                aria-controls={hintId}
                aria-label={typeof label === "string" && label ? `About ${label}` : "About this setting"}
                className={cn(
                  "relative flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  showHint && "text-primary",
                )}
              >
                <Info className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
          {aside}
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {hint && showHint ? (
          <motion.p
            key="hint"
            id={hintId}
            {...(reduceMotion ? REVEAL_REDUCED : REVEAL)}
            className="mb-2 text-xs leading-relaxed text-muted-foreground"
          >
            {hint}
          </motion.p>
        ) : null}
      </AnimatePresence>
      {children}
      <FieldIssues issues={issues} id={issuesId} />
    </div>
  );
}

/** A quiet heading for a group of fields. */
export function SectionHeading({
  title,
  description,
  aside,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {aside ? <div className="flex-shrink-0">{aside}</div> : null}
    </div>
  );
}

/** A soft, empty-state panel with one line of advice. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/** An on/off switch (no shadcn switch in the design system yet). */
export function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-background shadow transition-transform motion-reduce:transition-none",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
        aria-hidden
      />
    </button>
  );
}

/**
 * A quiet fold for settings most steps never need (a step's "More options"):
 * a full-width row with a chevron, how many of its settings differ from their
 * defaults, and the count of issues inside while folded (a problem is never
 * hidden silently). No box around it — a hairline above sets it apart, so it
 * never nests a container inside the inspector's own.
 */
export function Disclosure({
  id,
  title,
  defaultOpen = false,
  issueCount = 0,
  setCount = 0,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  /** Issues inside, shown on the header while it is folded. */
  issueCount?: number;
  /** Settings inside that differ from their defaults. */
  setCount?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const reduceMotion = useReducedMotion();
  const panelId = `${id}-panel`;
  // An issue appearing inside (a save's check) opens the fold, so it is seen.
  React.useEffect(() => {
    if (issueCount > 0) setOpen(true);
  }, [issueCount]);
  return (
    <section className="border-t border-border/50 pt-2">
      <button
        type="button"
        id={id}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex min-h-[44px] w-[calc(100%+1rem)] items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</span>
        {!open && issueCount ? (
          <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            <AlertCircle className="h-3 w-3" aria-hidden />
            {issueCount}
            <span className="sr-only"> {issueCount === 1 ? "issue" : "issues"} inside</span>
          </span>
        ) : !open && setCount ? (
          <span className="flex-shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-primary">
            {setCount} set
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="panel"
            id={panelId}
            role="region"
            aria-labelledby={id}
            {...(reduceMotion ? REVEAL_REDUCED : REVEAL)}
            className="space-y-5 pb-1 pt-3"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
