import * as React from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import type { WorkflowApprovalDecision, WorkflowPendingApproval } from "@/shared/lib/types";
import { errorText, hasContent } from "@/features/workflows/lib/format";
import { JsonView } from "./JsonView";

/*
 * The approval a waiting workflow execution is paused on: its message, the
 * payload it is asking about, an optional comment, Approve / Reject. In the
 * chat's HitlInterruptCard chrome (amber border, shield, one solid
 * affirmative and one quiet deny) — not that component itself, which reads a
 * chat interrupt's tool-call action requests; a workflow approval carries a
 * message and a free payload instead.
 */

type ApprovalCardProps = {
  approval: WorkflowPendingApproval;
  onResolve: (decision: WorkflowApprovalDecision, comment?: string) => Promise<void>;
  className?: string;
};

export function ApprovalCard({ approval, onResolve, className }: ApprovalCardProps) {
  const [busy, setBusy] = React.useState<WorkflowApprovalDecision | null>(null);
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const commentId = React.useId();
  const allowed = approval.allowedDecisions.length
    ? approval.allowedDecisions
    : (["approve", "reject"] as WorkflowApprovalDecision[]);

  const decide = async (decision: WorkflowApprovalDecision) => {
    setBusy(decision);
    setError(null);
    try {
      await onResolve(decision, comment.trim() || undefined);
    } catch (err) {
      setError(errorText(err, "Could not send the decision."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="Approval required"
      className={cn(
        "relative overflow-hidden rounded-[24px] border border-warning/45 bg-card px-4 py-3.5 shadow-card",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-warning/[0.10] via-warning/[0.04] to-transparent" />
      <div className="relative mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warning/[0.18] text-warning">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[13px] font-semibold text-foreground">Approval required</h4>
          <p className="text-xs text-muted-foreground">The run is paused until you decide.</p>
        </div>
      </div>

      {approval.message ? (
        <p className="relative mb-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">
          {approval.message}
        </p>
      ) : null}

      {hasContent(approval.payload) ? (
        <JsonView value={approval.payload} title="Details" className="relative mb-3" />
      ) : null}

      <label
        htmlFor={commentId}
        className="relative mb-1 block text-xs font-medium text-muted-foreground"
      >
        Comment (optional)
      </label>
      <textarea
        id={commentId}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={2}
        disabled={busy !== null}
        className="relative mb-3 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-[12.5px] leading-5 text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      />

      {error ? (
        <p role="alert" className="relative mb-2 text-[11.5px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="relative flex items-center justify-end gap-2">
        {allowed.includes("reject") ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void decide("reject")}
            disabled={busy !== null}
            className="min-h-[2.5rem] gap-1.5 border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:text-destructive"
          >
            {busy === "reject" ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
            ) : (
              <X className="h-3.5 w-3.5" aria-hidden />
            )}
            Reject
          </Button>
        ) : null}
        {allowed.includes("approve") ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void decide("approve")}
            disabled={busy !== null}
            className="min-h-[2.5rem] gap-1.5 bg-success text-success-foreground transition-colors hover:bg-success/90"
          >
            {busy === "approve" ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve
          </Button>
        ) : null}
      </div>
    </section>
  );
}
