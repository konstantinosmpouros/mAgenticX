import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, Archive, ArrowDownRight, ArrowUpRight, ChevronRight, Info, Layers, Minus, Shrink, Wand2 } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import type { UsageRange } from "@/shared/lib/api";
import type { UsageAgentGroup, UsageAgentKind } from "@/shared/lib/types";
import { RANGE_OPTIONS, contextFill, formatPercent, ratio } from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";

// The pieces every page of the Usage tab is built from, so the Overview, the
// lists and the two drill-downs read as one design: tiles, ranking bars, the
// agent × model table, the context fill bar, and the loading / empty / error
// states. Same surfaces as the rest of settings (SoftPanel, eyebrow labels).

const EYEBROW = "text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground";

export function KpiTile({
  label,
  value,
  hint,
  change,
}: {
  label: string;
  value: string;
  hint?: string;
  change?: { label: string; direction: "up" | "down" | "flat" } | null;
}) {
  const ChangeIcon = change?.direction === "up" ? ArrowUpRight : change?.direction === "down" ? ArrowDownRight : Minus;
  return (
    <SoftPanel className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <p className={EYEBROW}>{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
      <div className="flex min-h-[1.25rem] items-center gap-2 text-xs text-muted-foreground">
        {change ? (
          <span className="inline-flex items-center gap-0.5 rounded-md bg-background/70 px-1.5 py-0.5 font-medium tabular-nums text-foreground">
            <ChangeIcon className="h-3 w-3" aria-hidden />
            {change.label}
          </span>
        ) : null}
        {hint ? <span className="truncate">{hint}</span> : null}
      </div>
    </SoftPanel>
  );
}

export function RangeSelect({ value, onChange }: { value: UsageRange; onChange: (range: UsageRange) => void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as UsageRange)}>
      <SelectTrigger
        aria-label="Time range"
        className="h-9 w-auto min-w-[9.5rem] gap-2 rounded-xl border-border/60 bg-background/60 px-3 text-xs font-medium"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
        {RANGE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value} className="rounded-lg text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A row that opens a deeper page: icon, title, a one-line detail, a chevron. */
export function DrillCard({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full min-w-0 items-center gap-3 rounded-[1.4rem] bg-muted/30 px-4 py-4 text-left transition-[background-color,transform] duration-150 hover:bg-muted/50 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden
      />
    </button>
  );
}

/** A share of the largest value, drawn with transform so it never reflows. */
export function ShareBar({ fraction, className }: { fraction: number; className?: string }) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-background/70", className)} aria-hidden>
      <div
        className="h-full w-full origin-left rounded-full bg-primary/70 transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${Math.max(clamped, 0.02)})` }}
      />
    </div>
  );
}

/** How full a conversation's context window was on its last answer. */
export function FillBar({ tokens, window }: { tokens: number | null; window: number | null }) {
  const fill = contextFill(tokens, window);
  if (fill === null) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = fill >= 0.87 ? "bg-destructive" : fill >= 0.7 ? "bg-warning" : "bg-primary";
  return (
    <span className="flex items-center gap-2" title={`${formatCompactTokens(tokens ?? 0)} of ${formatCompactTokens(window ?? 0)}`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-background/70" aria-hidden>
        <span className={cn("block h-full w-full origin-left rounded-full", tone)} style={{ transform: `scaleX(${fill})` }} />
      </span>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Math.round(fill * 100)}%</span>
    </span>
  );
}

const KIND_META: Record<UsageAgentKind, { label: string; icon: LucideIcon; tone: string }> = {
  platform: { label: "Platform", icon: Layers, tone: "bg-primary/10 text-primary" },
  custom: { label: "Custom", icon: Wand2, tone: "bg-accent text-accent-foreground" },
  deleted: { label: "Deleted", icon: Archive, tone: "bg-muted text-muted-foreground" },
};

export function AgentKindBadge({ kind }: { kind: UsageAgentKind }) {
  const meta = KIND_META[kind];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.68rem] font-medium", meta.tone)}>
      <meta.icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * Where tokens went: main agent and each sub-agent, by model. Used by one
 * conversation and by one agent. On a phone the numbers wrap under the name.
 */
export function AgentGroupTable({
  groups,
  onOpenAgent,
}: {
  groups: UsageAgentGroup[];
  onOpenAgent?: (group: UsageAgentGroup) => void;
}) {
  const largest = Math.max(1, ...groups.map((g) => g.inputTokens + g.outputTokens));
  return (
    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,1fr)_4rem_5rem_4.5rem_4.5rem] gap-3 px-5 py-2.5 sm:grid">
        {["Agent · model", "Calls", "Tokens", "Cached", "Time"].map((heading, index) => (
          <span key={heading} className={cn(EYEBROW, index > 0 && "text-right")}>
            {heading}
          </span>
        ))}
      </div>
      {groups.map((group) => {
        const tokens = group.inputTokens + group.outputTokens;
        const name = (
          <span className="flex min-w-0 items-center gap-2">
            {group.scope === "subagent" ? (
              <span className="shrink-0 text-muted-foreground" aria-hidden>↳</span>
            ) : group.scope === "compaction" ? (
              <Shrink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : null}
            <span className="truncate text-sm font-medium text-foreground">
              {group.agentName}
              {group.scope === "main" ? <span className="text-muted-foreground"> (main)</span> : null}
            </span>
            {group.model ? (
              <span className="shrink-0 rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[0.68rem] text-muted-foreground">
                {group.model}
              </span>
            ) : null}
          </span>
        );
        const canOpen = Boolean(onOpenAgent && group.scope === "main" && group.agentId);
        return (
          <div key={`${group.scope}:${group.agentId ?? ""}:${group.agentName}:${group.model ?? ""}`} className="space-y-2 px-5 py-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm tabular-nums sm:grid-cols-[minmax(0,1fr)_4rem_5rem_4.5rem_4.5rem]">
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => onOpenAgent?.(group)}
                  className="min-w-0 rounded-md text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open ${group.agentName}`}
                >
                  {name}
                </button>
              ) : (
                name
              )}
              <span className="text-right text-muted-foreground sm:text-foreground">
                <span className="sm:hidden">{group.calls} calls · </span>
                <span className="hidden sm:inline">{group.calls}</span>
                <span className="sm:hidden">{formatCompactTokens(tokens)}</span>
              </span>
              <span className="hidden text-right font-medium text-foreground sm:block">{formatCompactTokens(tokens)}</span>
              <span className="hidden text-right text-muted-foreground sm:block">
                {formatPercent(ratio(group.cachedInputTokens, group.inputTokens))}
              </span>
              <span className="hidden text-right text-muted-foreground sm:block">{formatModelTime(group.modelMs)}</span>
            </div>
            <ShareBar fraction={tokens / largest} />
          </div>
        );
      })}
    </SoftPanel>
  );
}

/** Coverage, said plainly: the split, calls and time exist only for newer answers. */
export function CoverageNote({ detailed, total }: { detailed: number; total: number }) {
  if (total === 0 || detailed >= total) return null;
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Model calls, time and the agent split are recorded from Oct 8 onward — {detailed.toLocaleString()} of{" "}
        {total.toLocaleString()} answers here have them. Token totals include every answer.
      </span>
    </p>
  );
}

export function UsageEmpty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <SoftPanel className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon size={18} aria-hidden />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </SoftPanel>
  );
}

export function UsageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SoftPanel className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 items-center gap-3" role="alert">
        <AlertCircle size={16} className="shrink-0 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-full bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Retry
      </button>
    </SoftPanel>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-[3.75rem] rounded-[1.1rem]" />
      ))}
    </div>
  );
}

export function SectionTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}
