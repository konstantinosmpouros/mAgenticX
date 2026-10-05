import { AlertTriangle, Loader2, LogOut, RotateCcw } from "lucide-react";

import type { PendingDeletion } from "@/shared/lib/types";
import { formatDeletionDate } from "@/features/settings/lib/accountDeletion";
import { usePendingDeletion } from "@/features/settings/hooks/usePendingDeletion";
import { ExportDataCard } from "./profile_parts/ExportDataCard";

// What a user sees when they sign in while their account awaits deletion
// (plan 32). The session is frozen on the server — every workspace call answers
// 403 — so the shell renders this instead of the workspace: the date, and the
// only three things left to do: cancel, download a copy, or sign out.

export function PendingDeletionScreen({
  userId,
  pending,
  onLogout,
}: {
  userId: string;
  pending: PendingDeletion;
  onLogout: () => void;
}) {
  const { cancel, cancelling, error } = usePendingDeletion(userId);
  const deleteOn = formatDeletionDate(pending.scheduledFor);

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-xl space-y-6">
        <section
          aria-labelledby="pending-deletion-title"
          className="rounded-[1.4rem] border border-border/60 bg-card/60 px-6 py-6 shadow-card"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <AlertTriangle size={18} aria-hidden />
            </span>
            <div className="min-w-0 space-y-1.5">
              <h1 id="pending-deletion-title" className="text-lg font-semibold text-foreground">
                Your account is scheduled for deletion
              </h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {pending.inProgress ? (
                  "Deletion has started and can no longer be cancelled."
                ) : (
                  <>
                    It will be permanently deleted on{" "}
                    <span className="font-medium text-foreground">{deleteOn}</span>. Until then it is
                    paused: nothing runs, and your shared links are hidden.
                  </>
                )}
              </p>
            </div>
          </div>

          {error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            {!pending.inProgress ? (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={cancelling}
                aria-busy={cancelling}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
              >
                {cancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="h-4 w-4" aria-hidden />
                )}
                Cancel deletion
              </button>
            ) : null}
            <button
              type="button"
              onClick={onLogout}
              disabled={cancelling}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/60 px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </button>
          </div>
        </section>

        <ExportDataCard userId={userId} />
      </div>
    </main>
  );
}
