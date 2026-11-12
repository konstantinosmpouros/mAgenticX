import { useId, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleSlash } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { cn, formatCompactTokens } from "@/shared/lib/utils";
import type { AsyncTaskStatus } from "@/shared/lib/types";

// Every marker the conversation draws between (or inside) messages, in one
// place and one shape, so they read as a family:
//
//        <headline> ⌄ / ›                         ← details, or opens something
//   〰〰〰〰〰〰〰〰〰  <label>  〰〰〰〰〰〰〰〰〰
//
// - CompactionMarker — where the conversation was compacted (plan 34).
// - TaskMarker — a background task settled (plan 41): the wake-up's notice
//   row and the inline mark of a result pulled into a busy run.
//
// A custom component because nothing in shadcn draws a labelled wavy rule; the
// expandable headline is the shadcn Collapsible. A new marker goes here, built
// on MarkerRule, never as a one-off elsewhere.

const WAVE_PERIOD = 12;

/** One half of the rule: an SVG wave in the border colour. While something is
 *  in progress it drifts sideways (transform only; still under reduced motion). */
function WavyRule({ moving }: { moving: boolean }) {
  const reduceMotion = useReducedMotion();
  // useId's colons are not safe inside url(#…).
  const patternId = `wave${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <div className="relative h-2 min-w-6 flex-1 overflow-hidden text-border" aria-hidden>
      <motion.svg
        className="absolute inset-y-0 left-0 h-2"
        style={{ width: `calc(100% + ${WAVE_PERIOD}px)` }}
        animate={moving && !reduceMotion ? { x: [0, -WAVE_PERIOD] } : { x: 0 }}
        transition={moving && !reduceMotion ? { duration: 0.9, ease: "linear", repeat: Infinity } : { duration: 0 }}
      >
        <defs>
          <pattern id={patternId} width={WAVE_PERIOD} height="8" patternUnits="userSpaceOnUse">
            <path d="M0 4 Q 3 1 6 4 T 12 4" fill="none" stroke="currentColor" strokeWidth="1.25" />
          </pattern>
        </defs>
        <rect width="100%" height="8" fill={`url(#${patternId})`} />
      </motion.svg>
    </div>
  );
}

/** The rule with its label in the middle; a shimmering label while in progress. */
function MarkerRule({
  label,
  icon,
  tone = "text-muted-foreground",
  inProgress = false,
}: {
  label: string;
  icon?: ReactNode;
  tone?: string;
  inProgress?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <WavyRule moving={inProgress} />
      {inProgress ? (
        <ShimmeringText
          text={label}
          duration={1.1}
          pause={1.2}
          color="hsl(var(--muted-foreground))"
          shimmeringColor="hsl(var(--foreground))"
          className="shrink-0 text-xs font-medium"
        />
      ) : (
        <span className={cn("flex shrink-0 items-center gap-1 text-xs font-medium", tone)}>
          {icon}
          {label}
        </span>
      )}
      <WavyRule moving={inProgress} />
    </div>
  );
}

/** The small italic line above the rule; a button when it does something. */
const HEADLINE =
  "mx-auto flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs italic text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const HEADLINE_ACTIVE = "hover:text-foreground";

// --- Compaction ------------------------------------------------------------------

export type CompactionMarkerProps = {
  trigger: "manual" | "auto";
  status: "running" | "done";
  freed?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summarizedMessages?: number;
  keptMessages?: number;
  /** The summary the agent now works from (manual compactions only). */
  summary?: string;
  className?: string;
};

/** Where the conversation was compacted — the same mark for a compaction the
 *  user asked for between turns and one the agent made on its own mid-answer. */
export function CompactionMarker({
  trigger,
  status,
  freed,
  tokensBefore,
  tokensAfter,
  summarizedMessages,
  keptMessages,
  summary,
  className,
}: CompactionMarkerProps) {
  const [open, setOpen] = useState(false);
  const running = status === "running";
  const headline = [
    "Compacted chat",
    trigger,
    typeof freed === "number" && freed > 0 ? `${formatCompactTokens(freed)} tokens freed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const counts = [
    typeof summarizedMessages === "number" ? `${summarizedMessages.toLocaleString()} messages summarized` : null,
    typeof keptMessages === "number" ? `${keptMessages.toLocaleString()} kept as they were` : null,
    typeof tokensBefore === "number" && typeof tokensAfter === "number"
      ? `context ${formatCompactTokens(tokensBefore)} → ~${formatCompactTokens(tokensAfter)} tokens`
      : null,
  ].filter(Boolean);

  return (
    <div
      role="separator"
      aria-label={running ? "Compacting the conversation" : headline}
      className={cn("flex w-full flex-col gap-1.5 py-2", className)}
    >
      {running ? null : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className={cn(HEADLINE, HEADLINE_ACTIVE)}>
            {headline}
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mx-auto mt-2 w-full max-w-2xl space-y-2 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs text-muted-foreground">
            {counts.length ? <p className="tabular-nums">{counts.join(" · ")}</p> : null}
            {summary ? (
              <div className="scrollbar-muted max-h-64 overflow-y-auto pr-1">
                {/* The summary is the summarizer's markdown (headings, lists);
                    `compaction-summary` keeps its headings at panel size. */}
                <MarkdownRenderer
                  content={summary}
                  className="compaction-summary text-xs leading-relaxed text-foreground/85"
                />
              </div>
            ) : (
              <p>The agent works from a summary of the earlier messages; the full history stays readable to it.</p>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
      <MarkerRule label={running ? "Compacting…" : "Compacted"} inProgress={running} />
    </div>
  );
}

// --- Background task ---------------------------------------------------------------

/** The rule's label for a task's end, with an icon so it never relies on colour alone. */
function taskOutcome(status: AsyncTaskStatus): { label: string; icon?: ReactNode; tone?: string } {
  if (status === "success") {
    return { label: "Finished", icon: <Check className="h-3.5 w-3.5" aria-hidden />, tone: "text-success" };
  }
  if (status === "error") {
    return { label: "Failed", icon: <CircleAlert className="h-3.5 w-3.5" aria-hidden />, tone: "text-destructive" };
  }
  if (status === "cancelled") {
    return { label: "Stopped", icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden /> };
  }
  return { label: "Working…" };
}

export type TaskMarkerProps = {
  status: AsyncTaskStatus;
  /** "General Purpose finished · 22s" — the headline above the rule. */
  text: string;
  /** Opens the task's drill-down; without it the headline is plain text. */
  onOpen?: () => void;
  className?: string;
};

/** A background task settled: its name and time above, the outcome on the rule. */
export function TaskMarker({ status, text, onOpen, className }: TaskMarkerProps) {
  const outcome = taskOutcome(status);
  const settled = status === "success" || status === "error" || status === "cancelled";
  return (
    <div role="separator" aria-label={text} className={cn("flex w-full flex-col gap-1 py-0.5", className)}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${text} — open the task`}
          className={cn(HEADLINE, HEADLINE_ACTIVE)}
        >
          <span className="min-w-0 truncate">{text}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      ) : (
        <span className={HEADLINE}>
          <span className="min-w-0 truncate">{text}</span>
        </span>
      )}
      <MarkerRule label={outcome.label} icon={outcome.icon} tone={outcome.tone} inProgress={!settled} />
    </div>
  );
}
