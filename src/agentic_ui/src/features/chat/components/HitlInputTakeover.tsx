import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  summariseInterrupt,
  type HitlInterrupt,
} from "@/features/chat/components/message_parts/HitlInterruptCard";
import { cn } from "@/shared/lib/utils";
import { parseHitlInterrupt } from "@/features/inference";

export type HitlActionDecision = { decision: "approve" | "reject"; reason?: string };

type HitlInputTakeoverProps = {
  interrupt: HitlInterrupt;
  pendingCount: number;
  // One decision per action_request, in order. A single-action interrupt sends
  // a one-element list; a batched interrupt sends one entry per gated tool call.
  onResolve: (decisions: HitlActionDecision[]) => Promise<void>;
};

// Compact approval surface that takes over the composer slot while a HITL
// interrupt is pending. A batched interrupt (the agent gated several tool calls
// in one turn) is presented as a STACKED DECK: the user decides one card at a
// time, each swipes away to reveal the next, and only after the last card are
// all decisions submitted together (LangChain resolves the batch atomically) —
// so the user can approve some and reject others, never "approve all".
export function HitlInputTakeover({ interrupt, pendingCount, onResolve }: HitlInputTakeoverProps) {
  const reduceMotion = useReducedMotion();
  const [busy, setBusy] = useState<"approve" | "reject" | "submit" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseHitlInterrupt(interrupt.content), [interrupt.content]);
  const actions = parsed.actions.length
    ? parsed.actions
    : [{ toolName: parsed.toolName, description: parsed.description, argsText: parsed.argsText }];
  const isBatch = actions.length > 1;

  // Deck state (batch path): the top card, a per-card decision + reason that can
  // be revisited and overwritten, and the exit gesture for the slide animation.
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<("approve" | "reject" | null)[]>(() =>
    actions.map(() => null),
  );
  const [reasons, setReasons] = useState<string[]>(() => actions.map(() => ""));
  const [exitKind, setExitKind] = useState<"approve" | "reject" | "next" | "prev">("next");

  const summaryLine = parsed.toolName
    ? `The agent wants to run: ${parsed.toolName}${parsed.requestCount > 1 ? ` (+${parsed.requestCount - 1} more)` : ""}`
    : (parsed.description?.split("\n").find((line) => line.trim()) ??
      summariseInterrupt(interrupt.content)
        .split("\n")
        .find((line) => line.trim()) ??
      "The agent is asking for your approval.");

  useEffect(() => {
    // New interrupt → fresh deck + form state.
    setReason("");
    setError(null);
    setDetailOpen(false);
    setBusy(null);
    setIndex(0);
    setDecisions(actions.map(() => null));
    setReasons(actions.map(() => ""));
    if (!isBatch) reasonRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interrupt.interruptId]);

  const submit = async (
    decisions: HitlActionDecision[],
    busyKind: "approve" | "reject" | "submit",
  ) => {
    setBusy(busyKind);
    setError(null);
    try {
      await onResolve(decisions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send decision.");
      setBusy(null);
    }
  };

  // Single-action: one decision, immediate.
  const handleSingle = (decision: "approve" | "reject") =>
    submit([{ decision, reason: reason.trim() || undefined }], decision);

  const total = actions.length;

  // Deck: set the current card's decision (overwrite allowed on revisit). The
  // first time a card is decided we auto-advance (the satisfying slide); when
  // re-deciding an already-decided card we stay put so the change is visible.
  const decideCard = (decision: "approve" | "reject") => {
    if (busy) return;
    const wasDecided = decisions[index] !== null;
    setDecisions((prev) => prev.map((d, i) => (i === index ? decision : d)));
    if (!wasDecided && index < total - 1) {
      setExitKind(decision);
      setIndex((i) => i + 1);
    }
  };

  const goTo = (target: number, kind: "next" | "prev") => {
    if (busy || target < 0 || target >= total || target === index) return;
    setExitKind(kind);
    setIndex(target);
  };
  const goNext = () => goTo(index + 1, "next");
  const goPrev = () => goTo(index - 1, "prev");

  const setCardReason = (value: string) =>
    setReasons((prev) => prev.map((r, i) => (i === index ? value : r)));

  const decidedCount = decisions.filter((d) => d !== null).length;
  const rejectedCount = decisions.filter((d) => d === "reject").length;
  const allDecided = decidedCount === total;
  const currentDecision = decisions[index];

  const handleSubmitAll = () => {
    if (!allDecided) return;
    void submit(
      decisions.map((d, i) => ({
        decision: (d ?? "approve") as "approve" | "reject",
        reason: d === "reject" ? reasons[i].trim() || undefined : undefined,
      })),
      "submit",
    );
  };

  const exitTargets: Record<"approve" | "reject" | "next" | "prev", { x: number; rotate: number }> =
    {
      approve: { x: 180, rotate: 8 },
      reject: { x: -180, rotate: -8 },
      next: { x: -150, rotate: 0 },
      prev: { x: 150, rotate: 0 },
    };
  const cardVariants: Variants = {
    enter: reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 16 },
    center: { opacity: 1, scale: 1, x: 0, y: 0, rotate: 0 },
    exit: (kind: "approve" | "reject" | "next" | "prev") =>
      reduceMotion
        ? { opacity: 0, transition: { duration: 0.12 } }
        : { opacity: 0, ...exitTargets[kind], transition: { duration: 0.22, ease: "easeIn" } },
  };

  return (
    <div className="relative z-20 overflow-hidden rounded-[2rem] border border-amber-500/45 bg-background shadow-lg">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-amber-500/[0.10] via-amber-500/[0.04] to-transparent" />

      <div className="relative flex items-center gap-3 px-4 pt-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/[0.18] text-amber-500">
          <ShieldAlert className="h-4 w-4" />
        </span>
        {isBatch ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                Approval required
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                Review each action — approve some, reject others.
              </span>
            </span>
            {/* Pager: inspect/move between actions without deciding. */}
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={goPrev}
                disabled={busy !== null || index === 0}
                aria-label="Previous action"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[3.2rem] rounded-full bg-amber-500/15 px-2 py-0.5 text-center text-[10px] font-medium text-amber-500">
                {index + 1} of {total}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={busy !== null || index === total - 1}
                aria-label="Next action"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setDetailOpen((prev) => !prev)}
            aria-expanded={detailOpen}
            aria-label={detailOpen ? "Hide approval details" : "Show approval details"}
            className="group flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 rounded-lg"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-foreground">
                Approval required
                {pendingCount > 1 ? (
                  <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                    1 of {pendingCount}
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{summaryLine}</span>
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
                detailOpen && "rotate-180",
              )}
            />
          </button>
        )}
      </div>

      {/* Single-action detail expander (unchanged). */}
      {!isBatch && detailOpen ? (
        <div className="relative mx-4 mt-2 max-h-52 space-y-2 overflow-y-auto rounded-xl border border-border bg-background/70 px-3 py-2.5">
          {parsed.description ? (
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground">
              {parsed.description}
            </p>
          ) : null}
          {parsed.argsText ? (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Arguments
              </p>
              <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground">
                {parsed.argsText}
              </pre>
            </div>
          ) : null}
          {!parsed.description && !parsed.argsText ? (
            <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-5 text-foreground">
              {parsed.raw}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* Batch path: a navigable stacked deck — one card at a time. */}
      {isBatch ? (
        <div className="relative mx-4 mt-3 min-h-[156px]">
          {/* Peek of the cards still ahead of the top card. */}
          {!reduceMotion
            ? Array.from({ length: Math.min(Math.max(total - 1 - index, 0), 2) }).map((_, i) => (
                <div
                  key={`deck-back-${i}`}
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-full rounded-2xl border border-amber-500/20 bg-secondary/40"
                  style={{
                    transform: `translateY(${(i + 1) * 7}px) scale(${1 - (i + 1) * 0.04})`,
                    opacity: 0.55 - i * 0.18,
                    zIndex: -1,
                  }}
                />
              ))
            : null}

          <AnimatePresence mode="popLayout" custom={exitKind} initial={false}>
            {busy === "submit" ? (
              <motion.div
                key="submitting"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-[156px] items-center justify-center rounded-2xl border border-amber-500/40 bg-background"
              >
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Resuming with your decisions…
                </span>
              </motion.div>
            ) : (
              <motion.div
                key={index}
                custom={exitKind}
                variants={cardVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  reduceMotion
                    ? { duration: 0.12 }
                    : { type: "spring", stiffness: 420, damping: 34 }
                }
                className="relative rounded-2xl border border-amber-500/40 bg-background px-3.5 py-3 shadow-sm"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/15 text-[11px] font-semibold text-amber-500">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {actions[index]?.toolName ?? `Action ${index + 1}`}
                  </span>
                  {currentDecision ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                        currentDecision === "approve"
                          ? "bg-emerald-500/15 text-emerald-500"
                          : "bg-orange-500/15 text-orange-500",
                      )}
                    >
                      {currentDecision === "approve" ? "Approved" : "Rejected"}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">Pending</span>
                  )}
                </div>

                {actions[index]?.argsText ? (
                  <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-foreground">
                    {actions[index]?.argsText}
                  </pre>
                ) : actions[index]?.description ? (
                  <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">
                    {actions[index]?.description}
                  </p>
                ) : null}

                <input
                  value={reasons[index] ?? ""}
                  onChange={(event) => setCardReason(event.target.value)}
                  placeholder="Reason if you reject (optional)"
                  disabled={busy !== null}
                  aria-label={`Rejection reason for ${actions[index]?.toolName ?? `action ${index + 1}`}`}
                  className="mt-2.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60"
                />

                <div className="mt-2.5 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={currentDecision === "reject"}
                    onClick={() => decideCard("reject")}
                    disabled={busy !== null}
                    className={cn(
                      "h-10 flex-1 gap-1.5 rounded-full border transition-colors",
                      currentDecision === "reject"
                        ? "border-transparent bg-orange-500/90 text-white hover:bg-orange-500"
                        : "border-orange-500/40 text-foreground/80 hover:bg-orange-500/10",
                    )}
                  >
                    <X className="h-4 w-4" /> Reject
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={currentDecision === "approve"}
                    onClick={() => decideCard("approve")}
                    disabled={busy !== null}
                    className={cn(
                      "h-10 flex-1 gap-1.5 rounded-full border transition-colors",
                      currentDecision === "approve"
                        ? "border-transparent bg-emerald-500/90 text-white hover:bg-emerald-500"
                        : "border-emerald-500/40 text-foreground/80 hover:bg-emerald-500/10",
                    )}
                  >
                    <Check className="h-4 w-4" /> Approve
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : null}

      {error ? <p className="relative px-4 pt-2 text-xs text-destructive">{error}</p> : null}

      {isBatch ? (
        <div className="relative flex items-center justify-between gap-3 px-4 pb-3 pt-3">
          {/* Status dots double as quick-nav to any action. */}
          <span className="flex items-center gap-1.5">
            {actions.map((_, i) => (
              <button
                key={`dot-${i}`}
                type="button"
                onClick={() => goTo(i, i > index ? "next" : "prev")}
                disabled={busy !== null}
                aria-label={`Go to action ${i + 1}`}
                aria-current={i === index}
                className={cn(
                  "h-2 w-2 rounded-full transition-all",
                  i === index && "ring-2 ring-amber-500/50 ring-offset-1 ring-offset-background",
                  decisions[i] === "approve"
                    ? "bg-emerald-500"
                    : decisions[i] === "reject"
                      ? "bg-orange-500"
                      : i === index
                        ? "bg-amber-500"
                        : "bg-border hover:bg-muted-foreground/50",
                )}
              />
            ))}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground">
              {allDecided
                ? rejectedCount
                  ? `${rejectedCount} rejected`
                  : "all approved"
                : `${decidedCount} of ${total} decided`}
            </span>
            <Button
              type="button"
              onClick={handleSubmitAll}
              disabled={busy !== null || !allDecided}
              className="h-10 gap-1.5 rounded-full bg-amber-500/90 px-5 text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {busy === "submit" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Submit
            </Button>
          </div>
        </div>
      ) : (
        <div className="relative flex items-center gap-2 px-3 py-3">
          <input
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && busy === null) {
                event.preventDefault();
                void handleSingle("approve");
              }
            }}
            placeholder="Reason (optional)"
            disabled={busy !== null}
            className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleSingle("reject")}
            disabled={busy !== null}
            className="h-11 gap-1.5 rounded-full px-4 text-foreground/80"
          >
            {busy === "reject" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
            Reject
          </Button>
          <Button
            type="button"
            onClick={() => handleSingle("approve")}
            disabled={busy !== null}
            className="h-11 gap-1.5 rounded-full bg-emerald-500/90 px-4 text-white hover:bg-emerald-500"
          >
            {busy === "approve" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
