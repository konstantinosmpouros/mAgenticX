import { useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";

export type HitlInterrupt = {
  // LangGraph interrupt's unique id — distinguishes consecutive HITLs that
  // share the same conversation thread_id. Required so the modal can dedupe
  // and track resolution per-interrupt rather than per-thread.
  interruptId: string;
  threadId: string;
  content: unknown;
};

// --------------------------------------------------------------------------
// HitlInterruptCard — the actionable approve/reject UI for one HITL interrupt
// --------------------------------------------------------------------------

type HitlInterruptCardProps = {
  interrupt: HitlInterrupt;
  resolved: boolean;
  // How the interrupt was resolved, when the event log knows it. Falls back
  // to a neutral "Decision sent" when only the client-side marker is set.
  resolution?: "approved" | "rejected" | null;
  onResolve: (decision: "approve" | "reject", reason?: string) => Promise<void>;
  className?: string;
};

export function summariseInterrupt(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const question = obj.question ?? obj.prompt ?? obj.message ?? obj.text ?? obj.description;
    if (typeof question === "string" && question.trim()) return question.trim();
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return content === null || content === undefined ? "" : String(content);
}

// The card is the smallest reusable unit: it renders inline inside the
// Thinking block of the run timeline. The pending
// approval also surfaces as the input-bar takeover (HitlInputTakeover), which
// drives the same resolver.
export function HitlInterruptCard({
  interrupt,
  resolved,
  resolution,
  onResolve,
  className,
}: HitlInterruptCardProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const summary = summariseInterrupt(interrupt.content);

  const handle = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      await onResolve(decision, reason.trim() || undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to send decision.";
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  if (resolved) {
    const isRejected = resolution === "rejected";
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border px-3 py-2 text-[12px]",
          isRejected
            ? "border-destructive/25 bg-destructive/[0.06] text-destructive"
            : "border-success/25 bg-success/[0.06] text-success",
          className,
        )}
      >
        {isRejected ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        <span className="font-medium">
          {resolution === "approved" ? "Approved" : isRejected ? "Rejected" : "Decision sent"}
        </span>
        <span className={cn("truncate", isRejected ? "text-destructive/70" : "text-success/70")}>
          · thread {interrupt.threadId}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[24px] border border-amber-500/45 bg-card px-4 py-3.5 shadow-card",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-amber-500/[0.10] via-amber-500/[0.04] to-transparent" />

      <div className="relative mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/[0.18] text-amber-500">
          <ShieldAlert className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[13px] font-semibold text-foreground">Approval required</h4>
          <p className="truncate text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            thread {interrupt.threadId}
          </p>
        </div>
      </div>

      {summary ? (
        <pre className="relative mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background/70 px-3 py-2 font-mono text-[11.5px] leading-5 text-foreground">
          {summary}
        </pre>
      ) : null}

      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional)"
        rows={2}
        disabled={busy !== null}
        className="relative mb-3 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-[12.5px] leading-5 text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      />

      {error ? <p className="relative mb-2 text-[11.5px] text-destructive">{error}</p> : null}

      <div className="relative flex items-center justify-end gap-2">
        {/* Same pairing as the input-bar takeover: one solid affirmative, one
            quiet deny that only turns destructive on hover/focus. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => handle("reject")}
          disabled={busy !== null}
          className="gap-1.5 border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:text-destructive"
        >
          {busy === "reject" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => handle("approve")}
          disabled={busy !== null}
          className="gap-1.5 bg-success text-success-foreground transition-colors hover:bg-success/90"
        >
          {busy === "approve" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Approve
        </Button>
      </div>
    </div>
  );
}
