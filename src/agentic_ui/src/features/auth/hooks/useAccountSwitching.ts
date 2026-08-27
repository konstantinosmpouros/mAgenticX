import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";

import { createAuthHandlers, type AuthCtx } from "@/features/auth/handlers/auth";
import { logoutAccount } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type { AccountSummary } from "@/shared/lib/types";

type UseAccountSwitchingOptions = {
  isLoggedIn: boolean;
  userId: string | null;
  navigate: NavigateFunction;
  /**
   * Everything `createAuthHandlers` needs *except* `onSwitchStateChange` — the
   * interstitial state is owned here, so the hook wires that one itself.
   */
  auth: Omit<AuthCtx, "onSwitchStateChange">;
};

/**
 * Several accounts signed in per browser, with switching.
 *
 * Owns the switcher's own state and the six callbacks the sidebar and the
 * account-limit dialog fire, and calls `createAuthHandlers` on the caller's
 * behalf so the switch interstitial (`accountSwitch`) can be driven from state
 * that lives in the same place as the thing that reads it.
 *
 * `handleLogout` is returned rather than kept private because it is also the
 * profile menu's Sign out and the target of the global `mx:unauthorized` event.
 */
export function useAccountSwitching({
  isLoggedIn,
  userId,
  navigate,
  auth,
}: UseAccountSwitchingOptions) {
  // `active` blanks the entire workspace — the shell early-returns on it, which
  // is what stops a late response from the outgoing account being painted under
  // the incoming identity.
  const [accountSwitch, setAccountSwitch] = useState<{
    active: boolean;
    detail?: string;
    error?: string | null;
  }>({ active: false });
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountsMeta, setAccountsMeta] = useState({ canAddAccount: false, maxAccounts: 0 });
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [accountsRefreshSignal, setAccountsRefreshSignal] = useState(0);
  // Shown when the account cap is reached and the user asks to add another.
  const [accountLimitOpen, setAccountLimitOpen] = useState(false);

  const { toast } = auth;

  const {
    handleLogout,
    loadAccounts,
    handleSwitchAccount,
    handleLogoutAccount,
    handleLogoutAllAccounts,
  } = createAuthHandlers({ ...auth, onSwitchStateChange: setAccountSwitch });

  // Populate the account switcher for whoever is signed in. Re-runs on a switch
  // because the previous account becomes the parked one and vice versa. A
  // disabled feature answers 404, which loadAccounts turns into an empty list,
  // so the switcher simply never appears.
  // `createAuthHandlers` is called on every render, so `loadAccounts` is a NEW
  // function identity each time. Depending on it here would re-run this effect on
  // every render, and each fetch sets state -> renders again: an infinite request
  // loop that burns the per-IP auth budget and 429s the rest of the app. Reach it
  // through a ref and key the effect on the identity that actually matters.
  const loadAccountsRef = useRef(loadAccounts);
  loadAccountsRef.current = loadAccounts;

  useEffect(() => {
    if (!isLoggedIn || !userId) {
      setAccounts([]);
      setAccountsMeta({ canAddAccount: false, maxAccounts: 0 });
      return;
    }
    let cancelled = false;
    void loadAccountsRef.current().then((result) => {
      if (cancelled) return;
      setAccounts(result.accounts);
      setAccountsMeta({ canAddAccount: result.canAddAccount, maxAccounts: result.maxAccounts });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the ref above
  }, [isLoggedIn, userId, accountsRefreshSignal]);

  // Bumped after a switch or an added account, so the switcher re-reads without
  // being tied to a render-unstable dependency.
  const refreshAccounts = useCallback(() => setAccountsRefreshSignal((n) => n + 1), []);

  const onSelectAccount = useCallback(
    async (account: AccountSummary) => {
      if (account.current || busyAccountId) return;
      setBusyAccountId(account.id);
      try {
        const ok = await handleSwitchAccount(account.id, account.displayName || account.username);
        // The accounts swap roles on success: the one just left becomes parked.
        if (ok) refreshAccounts();
      } finally {
        setBusyAccountId(null);
      }
    },
    [busyAccountId, handleSwitchAccount, refreshAccounts],
  );

  const onLogoutAccount = useCallback(
    async (account: AccountSummary) => {
      if (busyAccountId) return;
      setBusyAccountId(account.id);
      try {
        const others = accounts
          .filter((row) => row.id !== account.id)
          .map((row) => ({ id: row.id, label: row.displayName || row.username }));
        const outcome = await handleLogoutAccount(account.id, others);
        // "logged-out" already navigated to /login, so there is nothing to refresh.
        if (outcome === "removed" || outcome === "switched") refreshAccounts();
      } finally {
        setBusyAccountId(null);
      }
    },
    [accounts, busyAccountId, handleLogoutAccount, refreshAccounts],
  );

  const onLogoutAllAccounts = useCallback(() => {
    void handleLogoutAllAccounts();
  }, [handleLogoutAllAccounts]);

  const onAddAccount = useCallback(() => {
    // At the cap there is nowhere to put another account, so ask which one to
    // give up instead of failing the login later with a 429.
    if (!accountsMeta.canAddAccount) {
      setAccountLimitOpen(true);
      return;
    }
    // Reuses the whole login screen (validation, rate-limit countdown, SSO
    // availability) rather than duplicating a second credential form.
    navigate("/login?add=1");
  }, [accountsMeta.canAddAccount, navigate]);

  // "Log out and continue": free a slot, then go and sign in as someone new.
  const onConfirmAccountLimit = useCallback(
    async (account: AccountSummary) => {
      setBusyAccountId(account.id);
      try {
        await logoutAccount(account.id);
        setAccountLimitOpen(false);
        // Signing out the *active* account leaves no session to park, so the new
        // sign-in has to be a plain login; otherwise it can still be an "add".
        // A HARD navigation: this handler changed which identity the cookies
        // describe without running the local teardown, so the module-level store
        // still holds the outgoing account. Restarting is what guarantees the
        // login page (and whatever it navigates to) starts from the new session.
        window.location.assign(account.current ? "/login" : "/login?add=1");
      } catch (error) {
        toastError(toast, "Could not sign out of that account", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setBusyAccountId(null);
      }
    },
    [toast],
  );

  return {
    handleLogout,
    accountSwitch,
    accounts,
    accountsMeta,
    busyAccountId,
    accountLimitOpen,
    setAccountLimitOpen,
    onSelectAccount,
    onAddAccount,
    onLogoutAccount,
    onLogoutAllAccounts,
    onConfirmAccountLimit,
  };
}
