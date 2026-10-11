import { useState, type MouseEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDashed,
  Info,
  Loader2,
  MousePointerClick,
  Shrink,
  Sigma,
  Timer,
  Wrench,
} from "lucide-react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card";
import { Button } from "@/shared/ui/button";
import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import type {
  ContextCompactionControl,
  ConversationStats,
  RunContextUsage,
} from "@/shared/lib/types";
import { contextLevel } from "@/features/chat/lib/contextUsage";
import { useCanHover } from "@/features/chat/hooks/useCanHover";
import { useIsMobile } from "@/shared/hooks/use-mobile";

// The composer's context gauge. The ring shows how full the model's window is
// on the conversation's latest call; the card on hover reads top to bottom:
//
//   117K / 272K tokens               [43%]   ← occupancy; the notch on the bar
//   ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░╋░░                 is where compaction kicks in
//   Free · Compacting in                     ← room left, and left before compaction
//   THIS CONVERSATION                        ← every finished answer, replaced
//   Input · Output · Total · Tool calls        ones included (what was spent)
//   Click the ring to compact now            ← or why it cannot (plan 34)
//   gpt-5                Avg latency 2.3 s   ← the model, time per model call
//
// Hover (or keyboard focus) opens the card; a click compacts the conversation
// now. Without hover — a touch screen, the mobile layout, or simply a tap
// from a finger — a tap opens the card and its "Compact now" button compacts,
// so a blind tap never fires a summary call. `(hover: hover)` alone is not
// enough: phones with a stylus and some Android browsers report hover, and so
// does a narrow desktop window, where the layout is still the mobile one.
// Occupancy moves after every model call; the conversation block when an
// answer finishes. Built on the shadcn HoverCard rather than the vendored AI
// Elements Context: this card's sections (free room, the compaction point, the
// conversation block) are not that component's shape, and it carries a control.

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LEVEL_TEXT = {
  ok: "text-primary",
  high: "text-warning",
  critical: "text-destructive",
} as const;

const LEVEL_PILL = {
  ok: "bg-primary/10 text-primary",
  high: "bg-warning/10 text-warning",
  critical: "bg-destructive/10 text-destructive",
} as const;

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

function StatRow({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", className)}>
      <dt className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground/70" aria-hidden />
        {label}
      </dt>
      <dd className="text-right font-medium text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function CompactRow({
  compaction,
  showButton,
}: {
  compaction: ContextCompactionControl;
  showButton: boolean;
}) {
  if (compaction.status === "compacting") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Compacting the conversation…
      </p>
    );
  }
  // Touch: the card's own button is the only way to compact, so it is always
  // there — disabled, with the reason under it, when there is nothing to compact.
  if (showButton) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-11 w-full"
          disabled={Boolean(compaction.disabledReason)}
          onClick={compaction.compact}
        >
          <Shrink className="h-3.5 w-3.5" aria-hidden />
          Compact now
        </Button>
        {compaction.disabledReason ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {compaction.disabledReason}
          </p>
        ) : null}
      </div>
    );
  }
  if (compaction.disabledReason) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {compaction.disabledReason}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <MousePointerClick className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Click the ring to compact now
    </p>
  );
}

export function ContextMeter({
  context,
  stats = null,
  compaction = null,
}: {
  context: RunContextUsage | null;
  stats?: ConversationStats | null;
  compaction?: ContextCompactionControl | null;
}) {
  const canHover = useCanHover();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // Set by the first tap from a finger, for hybrid devices that report hover.
  const [tapped, setTapped] = useState(false);
  if (!context) return null;
  const percent = context.percent;
  const known = typeof percent === "number";
  const level = contextLevel(context);
  const filled = known ? Math.min(Math.max(percent, 0), 100) : 0;
  const window = context.window;
  const compactAt =
    window && context.compactionPercent ? (window * context.compactionPercent) / 100 : null;
  const avgLatencyMs = stats && stats.timedCalls > 0 ? stats.modelMs / stats.timedCalls : null;
  const usage = known
    ? `Context window: ${percent}% used`
    : `Context: ${context.tokens.toLocaleString()} tokens used`;
  const compacting = compaction?.status === "compacting";
  const canCompact = Boolean(compaction && !compaction.disabledReason);
  const tapMode = !canHover || isMobile || tapped;
  const label = compacting
    ? `${usage}. Compacting the conversation`
    : canCompact && !tapMode
      ? `${usage}. Click to compact the conversation`
      : usage;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Chrome and Firefox deliver click as a PointerEvent, so a finger is
    // recognisable even where the media query claims hover.
    const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
    const fromFinger = pointerType === "touch" || pointerType === "pen";
    if (fromFinger) setTapped(true);
    // Without hover the tap opens the card, whose button compacts.
    if (tapMode || fromFinger) {
      setOpen((current) => !current);
      return;
    }
    if (canCompact) compaction?.compact();
  };

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-busy={compacting || undefined}
          onClick={handleClick}
          className={cn(
            "flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium tabular-nums text-muted-foreground transition-[background-color,transform] duration-150 hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
            canCompact && "active:scale-[0.94] motion-reduce:active:scale-100",
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className={cn(
              "h-5 w-5 -rotate-90",
              compacting && "animate-pulse motion-reduce:animate-none",
            )}
            aria-hidden
          >
            <circle
              cx="12"
              cy="12"
              r={RADIUS}
              fill="none"
              strokeWidth="3"
              className="stroke-muted"
            />
            <circle
              cx="12"
              cy="12"
              r={RADIUS}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              className={cn(
                "stroke-current transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none",
                LEVEL_TEXT[level],
              )}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - filled / 100)}
            />
          </svg>
          {known ? <span>{Math.round(percent)}%</span> : null}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        className="w-72 divide-y divide-border/50 overflow-hidden rounded-xl p-0 shadow-lg"
      >
        <div className="space-y-3 px-3.5 pb-3 pt-3.5">
          <div className="flex items-center justify-between gap-3 tabular-nums">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              {formatCompactTokens(context.tokens)}
              {window ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  / {formatCompactTokens(window)}
                </span>
              ) : null}{" "}
              <span className="font-normal text-muted-foreground">tokens</span>
            </p>
            {known ? (
              <span
                className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold", LEVEL_PILL[level])}
              >
                {percent}%
              </span>
            ) : null}
          </div>
          {known && window ? (
            <div className="relative py-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full w-full origin-left rounded-full bg-current",
                    LEVEL_TEXT[level],
                  )}
                  style={{ transform: `scaleX(${filled / 100})` }}
                />
              </div>
              {context.compactionPercent ? (
                // The notch stands proud of the track so it reads as a marker,
                // not as part of the fill.
                <div
                  className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
                  style={{ left: `${Math.min(context.compactionPercent, 100)}%` }}
                  aria-hidden
                />
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This model's window size is unknown.</p>
          )}
          {window ? (
            <dl className="space-y-1.5 text-xs">
              <StatRow icon={CircleDashed} label="Free">
                {formatCompactTokens(Math.max(window - context.tokens, 0))} tokens
              </StatRow>
              {compactAt ? (
                <StatRow icon={Shrink} label="Compacting in">
                  {compactAt > context.tokens
                    ? `${formatCompactTokens(compactAt - context.tokens)} tokens`
                    : "next call"}
                </StatRow>
              ) : null}
            </dl>
          ) : null}
        </div>

        {stats ? (
          <div className="space-y-2.5 px-3.5 py-3">
            <div className="space-y-0.5">
              <p className="text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-foreground">
                This conversation
              </p>
              <p className="text-xs text-muted-foreground/80 tabular-nums">
                {plural(stats.answers, "answer", "answers")}
                {stats.replaced ? ` (${stats.replaced.toLocaleString()} replaced)` : ""}
                {stats.modelCalls
                  ? ` · ${plural(stats.modelCalls, "model call", "model calls")}`
                  : ""}
              </p>
            </div>
            <dl className="space-y-1.5 text-xs">
              <StatRow icon={ArrowDownToLine} label="Input">
                {formatCompactTokens(stats.inputTokens)}
                {stats.cachedInputTokens ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    ({formatCompactTokens(stats.cachedInputTokens)} cached)
                  </span>
                ) : null}
              </StatRow>
              <StatRow icon={ArrowUpFromLine} label="Output">
                {formatCompactTokens(stats.outputTokens)}
              </StatRow>
              <StatRow icon={Wrench} label="Tool calls">
                {stats.toolCalls.toLocaleString()}
              </StatRow>
              <StatRow
                icon={Sigma}
                label="Total"
                className="border-t border-dashed border-border/60 pt-1.5 [&_dd]:font-semibold"
              >
                {formatCompactTokens(stats.inputTokens + stats.outputTokens)} tokens
              </StatRow>
            </dl>
          </div>
        ) : null}

        {compaction ? (
          <div className="px-3.5 py-2.5 text-xs">
            <CompactRow compaction={compaction} showButton={tapMode} />
          </div>
        ) : null}

        {context.model || avgLatencyMs !== null ? (
          <div className="flex items-center justify-between gap-3 bg-muted/40 px-3.5 py-2.5 text-xs">
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {context.model ?? ""}
            </span>
            {avgLatencyMs !== null ? (
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
                <Timer className="h-3.5 w-3.5" aria-hidden />
                Avg latency
                <span className="font-medium text-foreground">{formatModelTime(avgLatencyMs)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
