// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDataExport } from "@/features/settings/hooks/useDataExport";
import { describeCooldownWindow, formatAvailableAt } from "@/features/settings/lib/exportCooldown";

/**
 * Data controls → "Export data" (plan 27).
 *
 * The archive must never pass through JavaScript (that would hold the whole zip
 * in browser memory), so the hook only mints a one-time token and then points
 * the browser at the download URL. These pin that flow and its failure modes.
 */

const { api } = vi.hoisted(() => ({
  api: {
    getExportStatus: vi.fn(),
    requestExportToken: vi.fn(),
    exportDownloadUrl: (userId: string, token: string) => `/api/v1/export/${userId}/download?token=${token}`,
  },
}));
vi.mock("@/shared/lib/api", () => api);

const assign = vi.fn();

beforeEach(() => {
  api.getExportStatus.mockReset();
  api.requestExportToken.mockReset();
  assign.mockReset();
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  api.getExportStatus.mockResolvedValue({ enabled: true, availableAt: null, cooldownMinutes: 60 });
});

afterEach(() => vi.useRealTimers());

describe("useDataExport", () => {
  it("mints a token, then hands the download to the browser", async () => {
    api.requestExportToken.mockResolvedValue({ token: "abc_DEF-123", expiresInSeconds: 60 });
    const { result } = renderHook(() => useDataExport("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.start(false);
    });

    expect(api.requestExportToken).toHaveBeenCalledWith("u1", false);
    expect(assign).toHaveBeenCalledWith("/api/v1/export/u1/download?token=abc_DEF-123");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a refusal and never navigates", async () => {
    api.requestExportToken.mockRejectedValue(new Error("You exported your data recently."));
    const { result } = renderHook(() => useDataExport("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.start(true);
    });

    expect(assign).not.toHaveBeenCalled();
    expect(result.current.error).toBe("You exported your data recently.");
  });

  it("refuses a token the server did not send in the expected shape", async () => {
    // The schema blanks a token with characters outside the URL-safe alphabet.
    api.requestExportToken.mockResolvedValue({ token: "", expiresInSeconds: 60 });
    const { result } = renderHook(() => useDataExport("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.start(true);
    });

    expect(assign).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
  });

  it("re-reads the status when the cooldown ends, so the options re-enable without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const availableAt = new Date(Date.now() + 60_000).toISOString();
    api.getExportStatus
      .mockResolvedValueOnce({ enabled: true, availableAt, cooldownMinutes: 60 })
      .mockResolvedValue({ enabled: true, availableAt: null, cooldownMinutes: 60 });
    const { result } = renderHook(() => useDataExport("u1"));
    await waitFor(() => expect(result.current.status?.availableAt).toBe(availableAt));
    expect(api.getExportStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(api.getExportStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.availableAt).toBeNull();
  });

  it("reports the status so the row can explain why it is disabled", async () => {
    api.getExportStatus.mockResolvedValue({ enabled: false, availableAt: null, cooldownMinutes: 60 });
    const { result } = renderHook(() => useDataExport("u1"));
    await waitFor(() => expect(result.current.status?.enabled).toBe(false));
  });
});

describe("export cooldown wording", () => {
  it("names the window in its largest whole unit", () => {
    expect(describeCooldownWindow(7 * 24 * 60)).toBe("week");
    expect(describeCooldownWindow(14 * 24 * 60)).toBe("2 weeks");
    expect(describeCooldownWindow(3 * 24 * 60)).toBe("3 days");
    expect(describeCooldownWindow(60)).toBe("hour");
    expect(describeCooldownWindow(90)).toBe("90 minutes");
  });

  it("adds the day when the next export is not today", () => {
    const now = new Date(2026, 9, 4, 10, 0);
    expect(formatAvailableAt(new Date(2026, 9, 4, 16, 1), now)).toMatch(/^today at /);
    const later = formatAvailableAt(new Date(2026, 9, 11, 16, 1), now);
    expect(later).not.toMatch(/^today/);
    expect(later).toMatch(/11/);
  });
});
