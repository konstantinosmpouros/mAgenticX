import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/utils";
import type { AccountSummary } from "@/shared/lib/types";

/**
 * Shown when the browser already holds the maximum number of signed-in accounts
 * and the user asks to add another.
 *
 * The cap is a security bound — each parked account is a live bearer credential —
 * so it cannot simply be raised on demand. Instead of a dead-end error, this
 * offers the only action that makes room: sign out of one of the existing
 * accounts and continue to the login screen.
 */
type AccountLimitDialogProps = {
  open: boolean;
  accounts: AccountSummary[];
  submitting?: boolean;
  onCancel: () => void;
  /** Sign the chosen account out, then continue to sign in as someone new. */
  onConfirm: (account: AccountSummary) => void;
};

export default function AccountLimitDialog({
  open,
  accounts,
  submitting = false,
  onCancel,
  onConfirm,
}: AccountLimitDialogProps) {
  // Default to the first account so "Log out and continue" is never a no-op.
  const [selectedId, setSelectedId] = useState<string | null>(accounts[0]?.id ?? null);
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0] ?? null;

  const countWord = accounts.length === 2 ? "two" : String(accounts.length);

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !submitting ? onCancel() : undefined)}>
      <DialogContent className="max-w-md rounded-2xl border border-border/70 bg-background p-6">
        <DialogTitle className="text-lg font-semibold text-foreground">
          Choose an account to log out
        </DialogTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          You&apos;re already logged in to {countWord} accounts. Log out of one to add a new
          account.
        </p>

        <div role="radiogroup" aria-label="Accounts" className="mt-5 flex flex-col gap-1">
          {accounts.map((account) => {
            const isSelected = account.id === selected?.id;
            return (
              <button
                key={account.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={submitting}
                onClick={() => setSelectedId(account.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60",
                  isSelected ? "bg-muted/50" : "hover:bg-[hsl(var(--hover-surface))]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    isSelected ? "border-foreground" : "border-muted-foreground/60",
                  )}
                >
                  {isSelected ? <span className="h-2 w-2 rounded-full bg-foreground" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {account.email || account.username}
                  {account.current ? (
                    <span className="ml-2 text-xs text-muted-foreground">(current)</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={submitting || !selected}
            className="inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            Log out and continue
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
