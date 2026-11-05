import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";

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
        <label htmlFor={htmlFor} className="text-xs font-semibold text-foreground/85">
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
