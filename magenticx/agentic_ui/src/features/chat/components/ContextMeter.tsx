import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDashed,
  Loader2,
  Shrink,
  Sigma,
  Timer,
  Wrench,
} from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import type {
  ContextCompactionControl,
  ConversationStats,
  RunContextUsage,
} from "@/shared/lib/types";
import { contextLevel } from "@/features/chat/lib/contextUsage";

// The conversation's context gauge, in the sidebar just above the profile.
// The ring and the percentage under it show how full the model's window is on
// the conversation's latest call; the sidebar draws the row around them like
// its other rows (`renderTrigger`: the icon pinned at the same place on the
// collapsed rail and the open sidebar, which adds "Context" and the tokens).
// A click opens a small centred panel that reads top to bottom:
//
//   Context window  gpt-5                     ← the model beside the title
//   43%                    Compacts itself at  ← occupancy, large; where the
//   117K of 272K tokens used             92%     automatic compaction kicks in
//   ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░╋░░                   (the notch on the bar)
//   [Free]  [Until it compacts]               ← room left, and left before it
//   This conversation   7 answers · 14 calls   ← every finished answer, replaced
//   [Input] [Output] [Tool calls] [Total]        ones included (what was spent)
//   Compact the conversation       [Compact]  ← the only button that compacts
//   Average time per model call        2.3 s
//
// Opening the panel never compacts: the panel's own button does (or the
// /compact slash command), so a stray click can never fire a summary call.

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LEVEL_TEXT = {
  ok: "text-primary",
  high: "text-warning",
  critical: "text-destructive",
} as const;

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** One figure of the panel: a small card with its label over its value. */
function StatTile({
  icon: Icon,
  label,
  value,
  note,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5", className)}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">
        {value}
        {note ? <span className="ml-1 text-xs font-normal text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

/** The ring itself: how full the window is, coloured by how close compaction is. */
function ContextRing({
  filled,
  level,
  pulsing,
}: {
  filled: number;
  level: keyof typeof LEVEL_TEXT;
  pulsing: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[18px] w-[18px] shrink-0 -rotate-90", pulsing && "animate-pulse motion-reduce:animate-none")}
      aria-hidden
    >
      <circle cx="12" cy="12" r={RADIUS} fill="none" strokeWidth="3" className="stroke-muted" />
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
  );
}

/**
 * The panel's compaction row: why it cannot compact yet (or what it does),
 * beside the one button that compacts.
 */
function CompactRow({ compaction }: { compaction: ContextCompactionControl }) {
  if (compaction.status === "compacting") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        Compacting the conversation…
      </p>
    );
  }
  const reason = compaction.disabledReason;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-foreground">Compact the conversation</p>
        <p className="text-xs text-muted-foreground">
          {reason ?? "Summarise the older turns to free room."} Or type{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.68rem]">/compact</code>.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={reason ? "secondary" : "default"}
        className="h-9 shrink-0 rounded-full px-4"
        disabled={Boolean(reason)}
        onClick={compaction.compact}
      >
        <Shrink className="h-3.5 w-3.5" aria-hidden />
        Compact
      </Button>
    </div>
  );
}

/** What the sidebar needs to draw the gauge's row like its other rows. */
export type ContextTrigger = {
  /** The ring with the percentage under it: the row's 36px icon. */
  icon: ReactNode;
  /** "Context", or "Compacting…" while it runs. */
  title: string;
  /** "117K / 272K tokens". */
  detail: string;
  /** The accessible name: how full it is, and whether it is compacting. */
  ariaLabel: string;
  busy: boolean;
  /** Opens the panel. */
  onOpen: () => void;
};

export type RenderContextTrigger = (trigger: ContextTrigger) => ReactNode;

/** Without a sidebar to draw it (tests, a page of its own): a plain button. */
const defaultTrigger: RenderContextTrigger = ({ icon, title, detail, ariaLabel, busy, onOpen }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-busy={busy || undefined}
    aria-haspopup="dialog"
    onClick={onOpen}
    className="flex items-center gap-2 rounded-xl px-1.5 text-left text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
  >
    {icon}
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-sm text-foreground">{title}</span>
      <span className="truncate text-xs tabular-nums">{detail}</span>
    </span>
  </button>
);

export function ContextMeter({
  context,
  stats = null,
  compaction = null,
  renderTrigger = defaultTrigger,
}: {
  context: RunContextUsage | null;
  stats?: ConversationStats | null;
  compaction?: ContextCompactionControl | null;
  /** Draws the row that opens the panel; the sidebar passes its own. */
  renderTrigger?: RenderContextTrigger;
}) {
  const [open, setOpen] = useState(false);
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
  const label = compacting ? `${usage}. Compacting the conversation` : usage;
  const tokensLine = window
    ? `${formatCompactTokens(context.tokens)} / ${formatCompactTokens(window)} tokens`
    : `${formatCompactTokens(context.tokens)} tokens`;

  return (
    <>
      {renderTrigger({
        icon: (
          // A 36px box like every sidebar icon, so the row pins it in place:
          // the ring, the percentage under it.
          <span className="grid size-9 shrink-0 place-items-center">
            <span className="flex flex-col items-center gap-px">
              <ContextRing filled={filled} level={level} pulsing={compacting} />
              {known ? (
                <span
                  className={cn(
                    "text-[0.6rem] font-semibold leading-none tabular-nums",
                    LEVEL_TEXT[level],
                  )}
                >
                  {Math.round(percent)}%
                </span>
              ) : null}
            </span>
          </span>
        ),
        title: compacting ? "Compacting…" : "Context",
        detail: tokensLine,
        ariaLabel: label,
        busy: compacting,
        onOpen: () => setOpen(true),
      })}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <div className="px-5 pb-5 pt-5">
            <div className="flex items-center gap-2 pr-8">
              <DialogTitle className="text-base">Context window</DialogTitle>
              {context.model ? (
                <span className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem] text-muted-foreground">
                  {context.model}
                </span>
              ) : null}
            </div>
            <DialogDescription className="sr-only">
              How full the model's context window is, and what this conversation has spent.
            </DialogDescription>

            <div className="mt-5 flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-3xl font-semibold leading-none tracking-tight tabular-nums",
                    known ? LEVEL_TEXT[level] : "text-foreground",
                  )}
                >
                  {known ? `${percent}%` : formatCompactTokens(context.tokens)}
                </p>
                <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                  {window
                    ? `${formatCompactTokens(context.tokens)} of ${formatCompactTokens(window)} tokens used`
                    : "tokens used · this model's window size is unknown"}
                </p>
              </div>
              {context.compactionPercent ? (
                <p className="shrink-0 text-right text-xs leading-snug text-muted-foreground">
                  Compacts itself at
                  <span className="block text-sm font-semibold tabular-nums text-foreground">
                    {context.compactionPercent}%
                  </span>
                </p>
              ) : null}
            </div>

            {known && window ? (
              <div className="relative mt-3 py-1">
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full w-full origin-left rounded-full bg-current transition-transform duration-300 ease-out motion-reduce:transition-none",
                      LEVEL_TEXT[level],
                    )}
                    style={{ transform: `scaleX(${filled / 100})` }}
                  />
                </div>
                {context.compactionPercent ? (
                  // The notch stands proud of the track so it reads as a marker,
                  // not as part of the fill.
                  <div
                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
                    style={{ left: `${Math.min(context.compactionPercent, 100)}%` }}
                    aria-hidden
                  />
                ) : null}
              </div>
            ) : null}

            {window ? (
              <dl className="mt-4 grid grid-cols-2 gap-2">
                <StatTile
                  icon={CircleDashed}
                  label="Free"
                  value={`${formatCompactTokens(Math.max(window - context.tokens, 0))} tokens`}
                />
                {compactAt ? (
                  <StatTile
                    icon={Shrink}
                    label="Until it compacts"
                    value={
                      compactAt > context.tokens
                        ? `${formatCompactTokens(compactAt - context.tokens)} tokens`
                        : "Next call"
                    }
                  />
                ) : null}
              </dl>
            ) : null}
          </div>

          {stats ? (
            <div className="border-t border-border/50 px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="shrink-0 text-sm font-semibold text-foreground">This conversation</p>
                <p className="truncate text-xs tabular-nums text-muted-foreground">
                  {plural(stats.answers, "answer", "answers")}
                  {stats.replaced ? ` (${stats.replaced.toLocaleString()} replaced)` : ""}
                  {stats.modelCalls
                    ? ` · ${plural(stats.modelCalls, "model call", "model calls")}`
                    : ""}
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <StatTile
                  icon={ArrowDownToLine}
                  label="Input"
                  value={formatCompactTokens(stats.inputTokens)}
                  note={
                    stats.cachedInputTokens
                      ? `${formatCompactTokens(stats.cachedInputTokens)} cached`
                      : undefined
                  }
                />
                <StatTile icon={ArrowUpFromLine} label="Output" value={formatCompactTokens(stats.outputTokens)} />
                <StatTile icon={Wrench} label="Tool calls" value={stats.toolCalls.toLocaleString()} />
                <StatTile
                  icon={Sigma}
                  label="Total"
                  value={`${formatCompactTokens(stats.inputTokens + stats.outputTokens)} tokens`}
                />
              </dl>
            </div>
          ) : null}

          {compaction ? (
            <div className="border-t border-border/50 px-5 py-4">
              <CompactRow compaction={compaction} />
            </div>
          ) : null}

          {avgLatencyMs !== null ? (
            <div className="flex items-center justify-between gap-3 border-t border-border/50 bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5" aria-hidden />
                Average time per model call
              </span>
              <span className="font-medium tabular-nums text-foreground">{formatModelTime(avgLatencyMs)}</span>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
