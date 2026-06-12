import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { summariseInterrupt, type HitlInterrupt } from "@/components/chat/message_parts/HitlInterruptCard";
import { cn, parseHitlInterrupt } from "@/lib/utils";

type HitlInputTakeoverProps = {
  interrupt: HitlInterrupt;
  pendingCount: number;
  onResolve: (decision: "approve" | "reject", reason?: string) => Promise<void>;
};

// Compact approval surface that takes over the composer slot while a HITL
// interrupt is pending: the action lives at the bottom where the user is
// already looking, the chat scroll stays anchored, and nothing shoves the
// conversation around. Replaces the old center-of-chat blocking modal.
export function HitlInputTakeover({ interrupt, pendingCount, onResolve }: HitlInputTakeoverProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseHitlInterrupt(interrupt.content), [interrupt.content]);
  // Human-readable summary: the tool the agent wants to run, falling back to
  // the description's first line, then the generic summariser — never the
  // raw JSON payload (that lives behind the detail expander).
  const summaryLine = parsed.toolName
    ? `The agent wants to run: ${parsed.toolName}${parsed.requestCount > 1 ? ` (+${parsed.requestCount - 1} more)` : ""}`
    : parsed.description?.split("\n").find((line) => line.trim()) ??
      summariseInterrupt(interrupt.content).split("\n").find((line) => line.trim()) ??
      "The agent is asking for your approval.";

  useEffect(() => {
    // New interrupt → fresh form state; focus lands on the reason input so
    // the keyboard path mirrors the composer it replaced.
    setReason("");
    setError(null);
    setDetailOpen(false);
    reasonRef.current?.focus();
  }, [interrupt.interruptId]);

  const handle = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      await onResolve(decision, reason.trim() || undefined);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send decision.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative z-20 overflow-hidden rounded-[2rem] border border-amber-500/45 bg-background shadow-lg">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-amber-500/[0.10] via-amber-500/[0.04] to-transparent" />

      <div className="relative flex items-center gap-3 px-4 pt-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/[0.18] text-amber-500">
          <ShieldAlert className="h-4 w-4" />
        </span>
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
      </div>

      {detailOpen ? (
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
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground">
                {parsed.argsText}
              </pre>
            </div>
          ) : null}
          {!parsed.description && !parsed.argsText ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground">
              {parsed.raw}
            </pre>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="relative px-4 pt-2 text-xs text-destructive">{error}</p> : null}

      <div className="relative flex items-center gap-2 px-3 py-3">
        <input
          ref={reasonRef}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && busy === null) {
              event.preventDefault();
              void handle("approve");
            }
          }}
          placeholder="Reason (optional)"
          disabled={busy !== null}
          className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60"
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => handle("reject")}
          disabled={busy !== null}
          className="h-11 gap-1.5 rounded-full px-4 text-foreground/80"
        >
          {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Reject
        </Button>
        <Button
          type="button"
          onClick={() => handle("approve")}
          disabled={busy !== null}
          className="h-11 gap-1.5 rounded-full bg-emerald-500/90 px-4 text-white hover:bg-emerald-500"
        >
          {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Approve
        </Button>
      </div>
    </div>
  );
}
