import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Check, ChevronDown, Loader2, ShieldAlert, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type { HitlInterrupt } from "@/features/chat/components/message_parts/HitlInterruptCard";
import { HitlActionSummary } from "@/features/chat/components/message_parts/HitlActionSummary";
import { useApprovalSummaries } from "@/features/chat/hooks/useApprovalSummaries";
import { approvalHeadline, hasApprovalDetail } from "@/features/chat/lib/approvalPresentation";
import { cn } from "@/shared/lib/utils";

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
  // One summary per gated tool call: a title and only the fields worth reading
  // (approvalPresentation.ts) — never the middleware's repr of the arguments.
  const actions = useApprovalSummaries(interrupt.content);
  const isBatch = actions.length > 1;
  const single = actions[0];
  const singleHasDetail = Boolean(single && hasApprovalDetail(single));

  // Deck state (batch path): the top card, a per-card decision + reason that can
  // be revisited and overwritten, and the exit gesture for the slide animation.
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<("approve" | "reject" | null)[]>(() =>
    actions.map(() => null),
  );
  const [reasons, setReasons] = useState<string[]>(() => actions.map(() => ""));
  const [exitKind, setExitKind] = useState<"approve" | "reject" | "next" | "prev">("next");

  const summaryLine = approvalHeadline(actions);

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

  // Named `resolved`, not `decisions`: the component already has a `decisions`
  // state holding the deck's per-card selections, and shadowing it here made two
  // different shapes share one name in the same file.
  const submit = async (
    resolved: HitlActionDecision[],
    busyKind: "approve" | "reject" | "submit",
  ) => {
    setBusy(busyKind);
    setError(null);
    try {
      await onResolve(resolved);
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

  // Moving between actions slides the body sideways; deciding one slides it
  // towards its decision. Reduced motion: a plain fade.
  const slideX: Record<"approve" | "reject" | "next" | "prev", number> = {
    approve: 40,
    reject: -40,
    next: -32,
    prev: 32,
  };
  const bodyVariants: Variants = {
    enter: (kind: keyof typeof slideX) =>
      reduceMotion ? { opacity: 0 } : { opacity: 0, x: -slideX[kind] },
    center: { opacity: 1, x: 0 },
    exit: (kind: keyof typeof slideX) =>
      reduceMotion
        ? { opacity: 0, transition: { duration: 0.1 } }
        : { opacity: 0, x: slideX[kind], transition: { duration: 0.16, ease: "easeIn" } },
  };
  const current = actions[index];
  const currentHasDetail = Boolean(current && hasApprovalDetail(current));

  return (
    // The composer's own card, hairline and halo (styles/composer.css), as the
    // ask-user card uses: the approval reads as part of the same surface. The
    // warning colour stays in the icon and a light wash, not the whole frame.
    <section
      className="composer-shell z-20"
      data-busy={busy !== null}
      aria-label="Approval required"
    >
      <div aria-hidden className="composer-glow" />
      <div className="composer-surface overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[1.75rem] bg-gradient-to-b from-warning/[0.08] to-transparent"
        />

        {/* ---- header: what needs approving ---- */}
        <div className="relative flex items-center gap-3 px-4 pt-4 sm:px-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/[0.12] text-warning ring-1 ring-warning/20">
            <ShieldAlert className="h-[18px] w-[18px]" />
          </span>
          {isBatch ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  Approve {total} actions
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {current?.title ?? `Action ${index + 1}`}
                  <span className="text-muted-foreground/70">
                    {" "}
                    · {index + 1} of {total}
                  </span>
                </span>
              </span>
              {/* One pill per action: where you are, and what you decided. */}
              <div role="tablist" aria-label="Actions" className="flex shrink-0 items-center gap-1">
                {actions.map((action, i) => {
                  const decided = decisions[i];
                  const state =
                    decided === "approve"
                      ? " (approved)"
                      : decided === "reject"
                        ? " (rejected)"
                        : "";
                  return (
                    <button
                      key={`step-${i}`}
                      type="button"
                      role="tab"
                      aria-selected={i === index}
                      aria-label={`Action ${i + 1}: ${action.title}${state}`}
                      onClick={() => goTo(i, i > index ? "next" : "prev")}
                      disabled={busy !== null}
                      className={cn(
                        "flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        decided === "approve"
                          ? "bg-success/15 text-success"
                          : decided === "reject"
                            ? "bg-destructive/15 text-destructive"
                            : "bg-muted text-muted-foreground hover:text-foreground",
                        i === index && "ring-2 ring-primary/40 ring-offset-1 ring-offset-card",
                      )}
                    >
                      {decided === "approve" ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      ) : decided === "reject" ? (
                        <X className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        i + 1
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setDetailOpen((prev) => !prev)}
              disabled={!singleHasDetail}
              aria-expanded={singleHasDetail ? detailOpen : undefined}
              aria-label={detailOpen ? "Hide approval details" : "Show approval details"}
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/50 disabled:cursor-default"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-foreground">
                  Approval required
                  {pendingCount > 1 ? (
                    <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                      1 of {pendingCount}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{summaryLine}</span>
              </span>
              {singleHasDetail ? (
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
                    detailOpen && "rotate-180",
                  )}
                />
              ) : null}
            </button>
          )}
        </div>

        {/* ---- body: exactly what is being approved, in its natural form ---- */}
        {!isBatch && detailOpen && single && singleHasDetail ? (
          <div className="scrollbar-muted relative mx-4 mt-3 max-h-[min(22rem,45vh)] overflow-y-auto overscroll-contain rounded-2xl border border-border/60 bg-muted/25 px-3.5 py-3 sm:mx-5">
            <HitlActionSummary summary={single} />
          </div>
        ) : null}

        {isBatch ? (
          <div className="relative mx-4 mt-3 overflow-hidden sm:mx-5">
            <AnimatePresence mode="popLayout" custom={exitKind} initial={false}>
              {busy === "submit" ? (
                <motion.div
                  key="submitting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" /> Resuming with your decisions…
                </motion.div>
              ) : (
                <motion.div
                  key={index}
                  custom={exitKind}
                  variants={bodyVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={
                    reduceMotion ? { duration: 0.12 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
                  }
                  className="scrollbar-muted max-h-[min(18rem,40vh)] overflow-y-auto overscroll-contain rounded-2xl border border-border/60 bg-muted/25 px-3.5 py-3"
                >
                  {current && currentHasDetail ? (
                    <HitlActionSummary summary={current} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Nothing more to show for this action.
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="relative px-4 pt-2 text-xs text-destructive sm:px-5">
            {error}
          </p>
        ) : null}

        {/* ---- decision row: the same for one action or each of several ---- */}
        <div className="relative flex items-center gap-2 px-4 pb-4 pt-3 sm:px-5">
          <input
            ref={reasonRef}
            value={isBatch ? (reasons[index] ?? "") : reason}
            onChange={(event) =>
              isBatch ? setCardReason(event.target.value) : setReason(event.target.value)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && busy === null) {
                event.preventDefault();
                if (isBatch) decideCard("approve");
                else void handleSingle("approve");
              }
            }}
            placeholder={isBatch ? "Reason if you reject (optional)" : "Reason (optional)"}
            disabled={busy !== null}
            aria-label={
              isBatch
                ? `Rejection reason for ${current?.title ?? `action ${index + 1}`}`
                : "Reason (optional)"
            }
            className="h-11 min-w-0 flex-1 rounded-full border border-border/70 bg-muted/30 px-4 text-sm text-foreground placeholder:text-muted-foreground/70 transition-colors focus-visible:border-primary/40 focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60"
          />
          {/* One solid affirmative, one quiet deny. Reject stays neutral until
              you reach for it; a decided action shows its choice filled. */}
          <Button
            type="button"
            variant="outline"
            aria-pressed={isBatch ? currentDecision === "reject" : undefined}
            onClick={() => (isBatch ? decideCard("reject") : void handleSingle("reject"))}
            disabled={busy !== null}
            className={cn(
              "h-11 gap-1.5 rounded-full px-4 transition-colors",
              isBatch && currentDecision === "reject"
                ? "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "border-border text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:text-destructive",
            )}
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
            aria-pressed={isBatch ? currentDecision === "approve" : undefined}
            onClick={() => (isBatch ? decideCard("approve") : void handleSingle("approve"))}
            disabled={busy !== null}
            className={cn(
              "h-11 gap-1.5 rounded-full px-4 transition-colors",
              isBatch && currentDecision === "reject"
                ? "border border-border bg-transparent text-muted-foreground hover:bg-success/10 hover:text-success"
                : "bg-success text-success-foreground hover:bg-success/90",
            )}
          >
            {busy === "approve" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve
          </Button>
        </div>

        {/* ---- several actions: send them together once each is decided ---- */}
        <AnimatePresence initial={false}>
          {isBatch && allDecided && busy !== "submit" ? (
            <motion.div
              key="send"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="relative overflow-hidden"
            >
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 sm:px-5">
                <span className="text-xs text-muted-foreground">
                  {total - rejectedCount} approved
                  {rejectedCount ? ` · ${rejectedCount} rejected` : ""}
                </span>
                <Button
                  type="button"
                  onClick={handleSubmitAll}
                  disabled={busy !== null}
                  className="h-10 gap-1.5 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="h-4 w-4" />
                  Send decisions
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}
