import { Check, Loader2, Plus, UserRound } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { AccountSummary } from "@/shared/lib/types";

/**
 * The account switcher: every account this browser is signed in to, plus a way
 * to add one more.
 *
 * Rendered as a submenu of the profile button. Selection is by **click**, not
 * hover — a hover-only submenu is unreachable on touch and by keyboard — and the
 * rows are real buttons so arrow keys and focus rings work without extra work.
 *
 * The active account is always shown with a check so the identity in play is
 * never ambiguous: that is a security property, not a nicety, because the whole
 * risk of an account switcher is typing something into the wrong account.
 */
type AccountMenuProps = {
  accounts: AccountSummary[];
  canAddAccount: boolean;
  maxAccounts: number;
  /** Set while a switch is in flight, so rows stop accepting clicks. */
  busyAccountId?: string | null;
  onSelectAccount: (account: AccountSummary) => void;
  onAddAccount: () => void;
};

const rowBase =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60";

function Avatar({ account }: { account: AccountSummary }) {
  const initials = (account.displayName || account.username || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  if (account.avatarUrl) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-cover"
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
    >
      {initials || <UserRound size={14} />}
    </span>
  );
}

export default function AccountMenu({
  accounts,
  canAddAccount,
  maxAccounts,
  busyAccountId = null,
  onSelectAccount,
  onAddAccount,
}: AccountMenuProps) {
  const busy = Boolean(busyAccountId);

  return (
    <div className="flex w-[17rem] flex-col gap-0.5 p-1.5" role="menu" aria-label="Accounts">
      {accounts.map((account) => {
        const isCurrent = account.current;
        const isBusy = busyAccountId === account.id;
        return (
          <button
            key={account.id}
            type="button"
            role="menuitemradio"
            aria-checked={isCurrent}
            disabled={busy || isCurrent}
            onClick={() => onSelectAccount(account)}
            className={cn(
              rowBase,
              isCurrent ? "bg-muted/60" : "hover:bg-[hsl(var(--hover-surface))]",
              // A current account is disabled, but must not look unavailable.
              isCurrent && "disabled:opacity-100",
            )}
          >
            <Avatar account={account} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {account.displayName || account.username}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {account.expired
                  ? "Signed out — select to sign in again"
                  : account.email || account.username}
              </span>
            </span>
            {isBusy ? (
              <Loader2
                size={15}
                className="shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : isCurrent ? (
              <Check size={16} className="shrink-0 text-foreground" aria-hidden />
            ) : null}
          </button>
        );
      })}

      <div className="my-1 h-px bg-border/60" role="separator" />

      <button
        type="button"
        role="menuitem"
        onClick={onAddAccount}
        // Clickable even at the cap: the handler opens the "choose an account to
        // log out" dialog, which is the only way forward. Disabling it would be a
        // dead end with no explanation.
        disabled={busy}
        title={
          canAddAccount
            ? undefined
            : `You can be signed in to at most ${maxAccounts} accounts — you'll be asked to sign out of one.`
        }
        className={cn(rowBase, "hover:bg-[hsl(var(--hover-surface))]")}
      >
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 text-muted-foreground"
        >
          <Plus size={15} />
        </span>
        <span className="text-sm font-medium text-foreground">Add another account</span>
      </button>
    </div>
  );
}
