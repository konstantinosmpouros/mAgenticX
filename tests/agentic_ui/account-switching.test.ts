// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAccountSwitching } from "@/features/auth/hooks/useAccountSwitching";
import type { AccountSummary } from "@/shared/lib/types";

/**
 * Multi-account switching.
 *
 * The load effect here carries a deliberate ref indirection: `createAuthHandlers`
 * is a plain factory called on every render, so `loadAccounts` has a fresh
 * identity each time. Depending on it directly makes the effect re-run every
 * render, and each fetch sets state and renders again — an unbounded request
 * loop that burns the per-IP auth budget and 429s the rest of the app. It is
 * invisible in review (the code looks like an ordinary effect) and invisible in
 * the UI until the app starts failing, so it is pinned here.
 */

const { handlers } = vi.hoisted(() => ({
  handlers: {
    handleLogin: vi.fn(),
    handleLogout: vi.fn(),
    loadAccounts: vi.fn(),
    handleSwitchAccount: vi.fn(async () => true),
    handleLogoutAccount: vi.fn(async () => "removed" as const),
    handleLogoutAllAccounts: vi.fn(async () => {}),
  },
}));

vi.mock("@/features/auth/handlers/auth", () => ({
  // A NEW object every call, exactly like the real factory — otherwise the
  // identity-instability this test exists to catch cannot occur.
  createAuthHandlers: () => ({ ...handlers }),
}));

const account = (over: Partial<AccountSummary> = {}) =>
  ({
    id: "a1",
    username: "kostas",
    displayName: "Kostas",
    current: false,
    ...over,
  }) as AccountSummary;

const authCtx = { toast: vi.fn() } as never;

const mount = (props: { isLoggedIn: boolean; userId: string | null }) =>
  renderHook(
    (p: { isLoggedIn: boolean; userId: string | null }) =>
      useAccountSwitching({ ...p, navigate: vi.fn() as never, auth: authCtx }),
    { initialProps: props },
  );

describe("useAccountSwitching", () => {
  beforeEach(() => {
    handlers.loadAccounts.mockClear();
    handlers.loadAccounts.mockResolvedValue({
      accounts: [account({ current: true }), account({ id: "a2", username: "other" })],
      canAddAccount: true,
      maxAccounts: 3,
    });
    handlers.handleSwitchAccount.mockClear();
    handlers.handleLogoutAccount.mockClear();
  });

  it("loads the account list once for a signed-in user", async () => {
    const { result } = mount({ isLoggedIn: true, userId: "u1" });

    await act(async () => {});

    expect(handlers.loadAccounts).toHaveBeenCalledTimes(1);
    expect(result.current.accounts).toHaveLength(2);
    expect(result.current.accountsMeta).toEqual({ canAddAccount: true, maxAccounts: 3 });
  });

  it("does not refetch on an unrelated re-render", async () => {
    // The 429 storm: re-rendering must not re-run the load effect just because
    // `loadAccounts` is a new function identity.
    const { rerender } = mount({ isLoggedIn: true, userId: "u1" });
    await act(async () => {});

    rerender({ isLoggedIn: true, userId: "u1" });
    rerender({ isLoggedIn: true, userId: "u1" });
    await act(async () => {});

    expect(handlers.loadAccounts).toHaveBeenCalledTimes(1);
  });

  it("clears the list when signed out instead of fetching", async () => {
    const { result } = mount({ isLoggedIn: false, userId: null });

    await act(async () => {});

    expect(handlers.loadAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toEqual([]);
    expect(result.current.accountsMeta.canAddAccount).toBe(false);
  });

  it("re-reads the list after a switch, since the accounts swap roles", async () => {
    const { result } = mount({ isLoggedIn: true, userId: "u1" });
    await act(async () => {});

    await act(async () => result.current.onSelectAccount(account({ id: "a2" })));

    expect(handlers.handleSwitchAccount).toHaveBeenCalledWith("a2", "Kostas");
    expect(handlers.loadAccounts).toHaveBeenCalledTimes(2);
  });

  it("ignores a switch to the account already active", async () => {
    const { result } = mount({ isLoggedIn: true, userId: "u1" });
    await act(async () => {});

    await act(async () => result.current.onSelectAccount(account({ current: true })));

    expect(handlers.handleSwitchAccount).not.toHaveBeenCalled();
  });

  it("opens the limit dialog instead of navigating when at the cap", async () => {
    handlers.loadAccounts.mockResolvedValue({
      accounts: [account({ current: true })],
      canAddAccount: false,
      maxAccounts: 1,
    });
    const { result } = mount({ isLoggedIn: true, userId: "u1" });
    await act(async () => {});

    act(() => result.current.onAddAccount());

    expect(result.current.accountLimitOpen).toBe(true);
  });
});
