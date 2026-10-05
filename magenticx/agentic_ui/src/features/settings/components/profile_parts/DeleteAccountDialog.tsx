import { useEffect, useId, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/utils";
import type { AccountDeletionStatus } from "@/shared/lib/types";
import { confirmationMatches, formatDeletionDate } from "@/features/settings/lib/accountDeletion";

// Data controls → "Delete account" → the confirmation (plan 32).
//
// Not the shared ConfirmDialog: deleting an account is the one action that
// needs two gates inside the dialog — a fresh Microsoft sign-in, then the
// account's email typed back — and the second must stay hidden until the first
// is passed. Built from the same dialog primitive and visual language.

const WHAT_GOES = [
  "Every conversation, message and attached file",
  "Your custom agents, skills and memories",
  "Scheduled tasks, shared links and settings",
];

const REAUTH_FAILED = "That sign-in didn't confirm it was you — it was cancelled or used another account.";

export function DeleteAccountDialog({
  open,
  onOpenChange,
  status,
  reauthFailed,
  submitting,
  error,
  onReauthenticate,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: AccountDeletionStatus | null;
  /** The last re-sign-in came back refused. */
  reauthFailed: boolean;
  submitting: boolean;
  error: string | null;
  onReauthenticate: () => void;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const hintId = useId();

  // Start empty every time it opens: a half-typed confirmation must not survive.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const graceDays = status?.graceDays ?? 14;
  const deleteOn = formatDeletionDate(new Date(Date.now() + graceDays * 86_400_000).toISOString());
  const needsReauth = status?.reauthRequired !== false;
  const expected = status?.confirmWith ?? "";
  const matches = confirmationMatches(typed, expected);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md rounded-[1.4rem]">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <AlertTriangle size={17} aria-hidden />
            </span>
            <div className="min-w-0 space-y-1.5 text-left">
              <DialogTitle className="text-base">Delete your account?</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">
                Every device is signed out now, and the account is deleted for good on{" "}
                <span className="font-medium text-foreground">{deleteOn}</span>. Until then, signing in
                lets you cancel.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ul className="space-y-1.5 rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {WHAT_GOES.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Want a copy? Use <span className="font-medium text-foreground">Export data</span> on this page first.
        </p>

        {needsReauth ? (
          <div className="space-y-3 rounded-xl border border-border/60 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="text-sm text-foreground">
                For your security, sign in with Microsoft again to confirm it's you.
              </p>
            </div>
            {reauthFailed ? (
              <p role="alert" className="text-sm text-destructive">
                {REAUTH_FAILED}
              </p>
            ) : null}
            <button
              type="button"
              onClick={onReauthenticate}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign in again
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5" aria-hidden /> Signed in recently — confirmed it's you.
            </p>
            <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
              Type <span className="font-semibold">{expected}</span> to confirm
            </label>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              disabled={submitting}
              className="h-10 rounded-xl"
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              This is the email of the account being deleted.
            </p>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="rounded-xl border border-border/60 bg-background/60 px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(typed)}
            disabled={needsReauth || !matches || submitting}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all",
              "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
            )}
          >
            {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            Delete my account
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
