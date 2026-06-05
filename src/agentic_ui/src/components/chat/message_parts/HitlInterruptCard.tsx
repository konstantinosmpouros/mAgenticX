import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveOverlayHost } from "@/lib/overlay-host";
import { cn } from "@/lib/utils";

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
  onResolve: (decision: "approve" | "reject", reason?: string) => Promise<void>;
  className?: string;
};

function summariseInterrupt(content: unknown): string {
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

// The card is the smallest reusable unit. The Test.tsx demo renders this
// directly with a mock resolver; production wraps it in HitlInterruptModal
// (below) and only ever passes `resolved={false}` because the modal filters
// out resolved interrupts before rendering.
export function HitlInterruptCard({ interrupt, resolved, onResolve, className }: HitlInterruptCardProps) {
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
    return (
      <div className={cn(
        "flex items-center gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-500",
        className,
      )}>
        <Check className="h-3.5 w-3.5" />
        <span className="font-medium">Decision sent</span>
        <span className="truncate text-emerald-500/70">· thread {interrupt.threadId}</span>
      </div>
    );
  }

  return (
    <div className={cn(
      "relative overflow-hidden rounded-[24px] border border-amber-500/45 bg-card px-4 py-3.5 shadow-card",
      className,
    )}>
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

      {error ? (
        <p className="relative mb-2 text-[11.5px] text-destructive">{error}</p>
      ) : null}

      <div className="relative flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => handle("reject")}
          disabled={busy !== null}
          className="gap-1.5 text-foreground/80"
        >
          {busy === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => handle("approve")}
          disabled={busy !== null}
          className="gap-1.5 bg-emerald-500/90 text-white hover:bg-emerald-500"
        >
          {busy === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// HitlInterruptModal — chat-area-scoped popup wrapping a stack of cards
// --------------------------------------------------------------------------

type HitlInterruptModalProps = {
  interrupts: HitlInterrupt[];
  isResolved: (interruptId: string) => boolean;
  onResolve: (
    interrupt: HitlInterrupt,
    decision: "approve" | "reject",
    reason?: string,
  ) => Promise<void>;
};

// Portals into the chat-area overlay host (same trick the PlanningContainer
// and SubagentContainer modals use) so it blocks the conversation pane
// without covering the sidebar or chat header. No close button, no backdrop
// click-to-dismiss, no ESC handler — the only way past it is to approve or
// reject every pending interrupt. As each card is resolved (after the bridge
// HTTP call confirms) it drops out of the filtered list, and once nothing is
// pending the modal returns null.
export function HitlInterruptModal({ interrupts, isResolved, onResolve }: HitlInterruptModalProps) {
  const pending = interrupts.filter((interrupt) => !isResolved(interrupt.interruptId));
  if (pending.length === 0) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="absolute inset-0 z-[70] flex items-center justify-center p-4 sm:p-6">
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-amber-500/50 bg-card shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/[0.18] text-amber-500">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Action required</h3>
            <p className="text-[10.5px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              {pending.length} interrupt{pending.length === 1 ? "" : "s"} awaiting your decision
            </p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [scrollbar-color:hsl(var(--muted-foreground)_/_0.25)_transparent] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[hsl(var(--muted-foreground)/0.25)] [&::-webkit-scrollbar-thumb:hover]:bg-[hsl(var(--muted-foreground)/0.35)]">
          {pending.map((interrupt) => (
            <HitlInterruptCard
              key={interrupt.interruptId}
              interrupt={interrupt}
              resolved={false}
              onResolve={(decision, reason) => onResolve(interrupt, decision, reason)}
              className="shadow-none"
            />
          ))}
        </div>
      </div>
    </div>,
    resolveOverlayHost(),
  );
}
