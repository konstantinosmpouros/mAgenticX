import * as React from "react";
import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowBuilderIssue } from "@/shared/lib/types";

/**
 * The inspector's field chrome — the agent builder's (label, control, its
 * issues under it, a quiet hint), so a workflow step's form and an agent's
 * read as the same tool.
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
  hint?: ReactNode;
  /** Right of the label: the template helper, a counter. */
  aside?: ReactNode;
  issues?: readonly WorkflowBuilderIssue[];
  issuesId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="mb-1.5 flex min-h-[1.25rem] items-center justify-between gap-3">
        {/* The id names a control that is no labelable element (a template field) via aria-labelledby. */}
        <label
          htmlFor={htmlFor}
          id={htmlFor ? `${htmlFor}-label` : undefined}
          className="text-xs font-semibold text-foreground/85"
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
        {aside}
      </div>
      {children}
      <FieldIssues issues={issues} id={issuesId} />
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
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
 * A quiet fold for settings most steps never need (a step's "Advanced"): a
 * header button with a chevron, the count of issues inside when folded (so a
 * problem is never hidden silently).
 */
export function Disclosure({
  id,
  title,
  defaultOpen = false,
  issueCount = 0,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  /** Issues inside, shown on the header while it is folded. */
  issueCount?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = `${id}-panel`;
  return (
    <section className="rounded-2xl border border-border/60 bg-muted/10">
      <button
        type="button"
        id={id}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{title}</span>
        {!open && issueCount ? (
          <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            <AlertCircle className="h-3 w-3" aria-hidden />
            {issueCount}
            <span className="sr-only"> {issueCount === 1 ? "issue" : "issues"} inside</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={panelId} role="region" aria-labelledby={id} className="space-y-4 border-t border-border/50 px-3.5 pb-3.5 pt-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}
