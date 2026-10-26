import { AlertCircle, AlertTriangle, ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { FIELD_LABELS, ROOT_UID, type PlacedIssue } from "@/features/agents/lib/agentIssues";

/**
 * The top bar's issue count, and the list behind it — shown only when there is
 * something to fix. Picking an issue takes the user to it: its node is
 * selected, the main agent's tab opened, the field focused (the builder does
 * that through `onPick`).
 */
export function IssuesMenu({
  issues,
  nodeName,
  onPick,
}: {
  issues: PlacedIssue[];
  /** A node's display name by uid. */
  nodeName: (uid: string) => string;
  onPick: (issue: PlacedIssue) => void;
}) {
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.length - errors;
  if (!issues.length) return null;
  const label = errors
    ? `${errors} issue${errors === 1 ? "" : "s"}`
    : `${warnings} note${warnings === 1 ? "" : "s"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            errors
              ? "border-destructive/35 bg-destructive/[0.08] text-destructive hover:bg-destructive/[0.13]"
              : "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.13)]",
          )}
          aria-label={`${label}${warnings && errors ? ` and ${warnings} note${warnings === 1 ? "" : "s"}` : ""}: show them`}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">{label}</span>
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="scrollbar-muted max-h-[min(26rem,70vh)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-1.5"
      >
        <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {errors ? "To fix before saving" : "Worth a look"}
        </DropdownMenuLabel>
        {issues.map((item) => {
          const error = item.severity === "error";
          const Icon = error ? AlertCircle : AlertTriangle;
          const where =
            item.target.uid === ROOT_UID
              ? FIELD_LABELS[item.target.field]
              : `${nodeName(item.target.uid)} · ${FIELD_LABELS[item.target.field]}`;
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => onPick(item)}
              className="items-start gap-2.5 rounded-xl px-2.5 py-2"
            >
              <Icon
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 flex-shrink-0",
                  error ? "text-destructive" : "text-[hsl(var(--warning))]",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-medium text-muted-foreground">
                  {where}
                </span>
                <span className="block text-[12.5px] leading-snug text-foreground">
                  {item.message}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
