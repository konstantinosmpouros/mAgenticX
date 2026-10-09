import { useId, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { cn, formatCompactTokens } from "@/shared/lib/utils";

// Where the conversation was compacted (plan 34) — the same mark for a compaction
// the user asked for between turns and one the agent made on its own mid-answer:
//
//        Compacted chat · manual · 81K tokens freed  ⌄     ← expands to the details
//   〰〰〰〰〰〰〰〰〰  Compacted  〰〰〰〰〰〰〰〰〰
//
// A custom component because nothing in shadcn draws a labelled wavy rule; the
// expandable row is the shadcn Collapsible. The wave is an SVG pattern in the
// border colour; while compacting it drifts sideways (transform only, and still
// under reduced motion).

const WAVE_PERIOD = 12;

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

export type CompactionDividerProps = {
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

export function CompactionDivider({
  trigger,
  status,
  freed,
  tokensBefore,
  tokensAfter,
  summarizedMessages,
  keptMessages,
  summary,
  className,
}: CompactionDividerProps) {
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
          <CollapsibleTrigger
            className="mx-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs italic text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
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
      <div className="flex items-center gap-3">
        <WavyRule moving={running} />
        {running ? (
          <ShimmeringText
            text="Compacting…"
            duration={1.1}
            pause={1.2}
            color="hsl(var(--muted-foreground))"
            shimmeringColor="hsl(var(--foreground))"
            className="shrink-0 text-xs font-medium"
          />
        ) : (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Compacted</span>
        )}
        <WavyRule moving={running} />
      </div>
    </div>
  );
}
