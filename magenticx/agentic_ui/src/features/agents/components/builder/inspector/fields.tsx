import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { PlacedIssue } from "@/features/agents/lib/agentIssues";

/**
 * The inspector's field chrome: a label, the control, its issues under it and a
 * quiet hint. One look for every field of every node, so a sub-agent's form and
 * the main agent's tabs read as the same tool.
 */

export const INPUT =
  "w-full rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.02)] transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-border focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:focus-visible:ring-destructive/25";

export const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50";

export const ICON_BUTTON =
  "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/** A field's issues, each on its own line, errors before warnings. */
export function FieldIssues({ issues, id }: { issues: PlacedIssue[]; id?: string }) {
  if (!issues.length) return null;
  return (
    <ul id={id} className="mt-1.5 space-y-1">
      {issues.map((item) => {
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
  /** Right of the label: a counter, a toggle. */
  aside?: ReactNode;
  issues?: PlacedIssue[];
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

/** A quiet heading inside a tab, for a group of fields. */
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

/** A soft, empty-state panel with its own one line of advice. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
