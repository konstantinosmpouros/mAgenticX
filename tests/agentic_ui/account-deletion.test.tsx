// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Delete account (plan 32) — the UI side.
 *
 * The server repeats every check, so what is pinned here is that the UI never
 * lets the user press "Delete" before the server would accept it (fresh
 * sign-in, matching confirmation), that a malformed server answer fails safe
 * (never "no re-auth needed", never a stuck pending screen), and that a request
 * or a cancel leaves the app the way the next step needs.
 */

const { api, storage } = vi.hoisted(() => ({
  api: {
    getAccountDeletionStatus: vi.fn(),
    requestAccountDeletion: vi.fn(),
    cancelAccountDeletion: vi.fn(),
    refreshSession: vi.fn(),
  },
  storage: { clearSession: vi.fn() },
}));
vi.mock("@/shared/lib/api", () => api);
vi.mock("@/shared/lib/authStorage", () => storage);

import { DeleteAccountDialog } from "@/features/settings/components/profile_parts/DeleteAccountDialog";
import { useAccountDeletion } from "@/features/settings/hooks/useAccountDeletion";
import { usePendingDeletion } from "@/features/settings/hooks/usePendingDeletion";
import {
  confirmationMatches,
  formatDeletionDate,
  loginUrlAfterDeletion,
  readDeletionNotice,
} from "@/features/settings/lib/accountDeletion";
import { AccountDeletionStatusSchema, PendingDeletionSchema } from "@/shared/lib/schemas";
import type { AccountDeletionStatus } from "@/shared/lib/types";

const assign = vi.fn();
const STATUS: AccountDeletionStatus = {
  enabled: true,
  pending: false,
  requestedAt: null,
  scheduledFor: null,
  inProgress: false,
  graceDays: 14,
  reauthRequired: false,
  confirmWith: "alice@example.com",
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  storage.clearSession.mockReset();
  assign.mockReset();
  Object.defineProperty(window, "location", { value: { assign, search: "" }, writable: true });
});

describe("helpers", () => {
  it("compares the confirmation the way the server does", () => {
    expect(confirmationMatches("  Alice@Example.com ", "alice@example.com")).toBe(true);
    expect(confirmationMatches("alice@example.co", "alice@example.com")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false); // nothing to match never matches
  });

  it("hands the date to the login page and reads it back", () => {
    const url = loginUrlAfterDeletion("2026-10-19T10:00:00Z");
    expect(readDeletionNotice(url.slice(url.indexOf("?")))).toEqual({ scheduledFor: "2026-10-19T10:00:00Z" });
    expect(readDeletionNotice("?deletion=scheduled&on=not-a-date")).toEqual({ scheduledFor: null });
    expect(readDeletionNotice("?sso=failed")).toBeNull();
    expect(formatDeletionDate("garbage")).toBe("");
  });
});

describe("contracts fail safe", () => {
  it("a malformed pending deletion is no pending deletion", () => {
    expect(PendingDeletionSchema.parse(null)).toBeNull();
    expect(PendingDeletionSchema.parse({ scheduledFor: "2026-10-19T10:00:00Z" })).toBeNull();
    expect(
      PendingDeletionSchema.parse({ requestedAt: "2026-10-05T10:00:00Z", scheduledFor: "2026-10-19T10:00:00Z" }),
    ).toEqual({ requestedAt: "2026-10-05T10:00:00Z", scheduledFor: "2026-10-19T10:00:00Z", inProgress: false });
  });

  it("a status without the flags asks for a re-sign-in and reads as off", () => {
    const status = AccountDeletionStatusSchema.parse({});
    expect(status.reauthRequired).toBe(true);
    expect(status.enabled).toBe(false);
  });
});

describe("DeleteAccountDialog", () => {
  const renderDialog = (status: AccountDeletionStatus, onConfirm = vi.fn(), onReauthenticate = vi.fn()) =>
    render(
      <DeleteAccountDialog
        open
        onOpenChange={vi.fn()}
        status={status}
        reauthFailed={false}
        submitting={false}
        error={null}
        onReauthenticate={onReauthenticate}
        onConfirm={onConfirm}
      />,
    );

  it("asks for a fresh sign-in first, and offers nothing to type until then", () => {
    const onReauthenticate = vi.fn();
    renderDialog({ ...STATUS, reauthRequired: true }, vi.fn(), onReauthenticate);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete my account" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onReauthenticate).toHaveBeenCalledOnce();
  });

  it("enables Delete only once the account is typed back", () => {
    const onConfirm = vi.fn();
    renderDialog(STATUS, onConfirm);
    const input = screen.getByLabelText(/Type alice@example.com to confirm/);
    const button = screen.getByRole("button", { name: "Delete my account" });

    fireEvent.change(input, { target: { value: "alice@example" } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "ALICE@example.com" } });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith("ALICE@example.com");
  });
});

describe("useAccountDeletion", () => {
  it("after a request, drops the local session and goes to the login page with the date", async () => {
    api.getAccountDeletionStatus.mockResolvedValue(STATUS);
    api.requestAccountDeletion.mockResolvedValue({ ...STATUS, pending: true, scheduledFor: "2026-10-19T10:00:00Z" });
    const { result } = renderHook(() => useAccountDeletion("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.request("alice@example.com");
    });

    expect(api.requestAccountDeletion).toHaveBeenCalledWith("u1", "alice@example.com");
    expect(storage.clearSession).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(loginUrlAfterDeletion("2026-10-19T10:00:00Z"));
  });

  it("a refused request stays put, shows why, and re-reads the status", async () => {
    api.getAccountDeletionStatus.mockResolvedValue(STATUS);
    api.requestAccountDeletion.mockRejectedValue(new Error("Please sign in again to confirm it's you."));
    const { result } = renderHook(() => useAccountDeletion("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.request("alice@example.com");
    });

    expect(assign).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Please sign in again to confirm it's you.");
    expect(api.getAccountDeletionStatus).toHaveBeenCalledTimes(2);
  });
});

describe("usePendingDeletion", () => {
  it("cancels, re-mints the session without the freeze, and starts the app over", async () => {
    api.cancelAccountDeletion.mockResolvedValue({ ...STATUS });
    api.refreshSession.mockResolvedValue({ authenticated: true });
    const { result } = renderHook(() => usePendingDeletion("u1"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(api.cancelAccountDeletion).toHaveBeenCalledWith("u1");
    expect(api.refreshSession).toHaveBeenCalledWith(false);
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("a cancel refused once the purge started explains it and stays", async () => {
    api.cancelAccountDeletion.mockRejectedValue(new Error("Your account is already being deleted; it can no longer be cancelled."));
    const { result } = renderHook(() => usePendingDeletion("u1"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(api.refreshSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/can no longer be cancelled/);
  });
});
