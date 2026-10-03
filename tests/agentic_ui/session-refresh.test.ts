// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreSession, restoreSessionWhenReachable } from "@/shared/lib/api/auth";
import { ApiError, requestRaw } from "@/shared/lib/http";
import { ensureFreshSession } from "@/shared/lib/sessionRefresh";

/**
 * Silent session refresh — the difference between "the session is over" and
 * "the bridge could not be reached".
 *
 * These were one outcome, and that logged people out every time a laptop woke
 * from sleep: the tab becomes visible a few seconds before Wi-Fi is back, the
 * refresh fetch rejects, and the app treated it like a refused refresh token.
 * The refresh cookie was still valid the whole time, so a page reload signed
 * them straight back in. Every case below pins one side of that line.
 */

const REFRESH = "/api/v1/auth/session/refresh";
const SESSION = "/api/v1/auth/session";

const authBody = {
  authenticated: true,
  user_id: "u1",
  user: { id: "u1", username: "u1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  tokenTtl: 28800,
};

const json = (status: number, body: unknown = { detail: "x" }) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Route `fetch` by path. Each route is a queue of answers, consumed in order; an
 * Error in the queue makes that call reject the way a dropped network does.
 */
function stubFetch(routes: Record<string, Array<Response | Error>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const next = routes[path]?.shift();
    if (!next) throw new Error(`unexpected fetch: ${path}`);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const networkDown = () => new TypeError("Failed to fetch");

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureFreshSession", () => {
  it.each([
    ["the network is down", networkDown()],
    ["the bridge is restarting (502)", json(502)],
    ["the bridge errors (503)", json(503)],
    ["the refresh is rate-limited (429)", json(429)],
  ])("reports unavailable, not failed, when %s", async (_label, answer) => {
    stubFetch({ [REFRESH]: [answer] });
    await expect(ensureFreshSession()).resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    ["the refresh token is dead (401)", 401],
    ["the CSRF check fails (403)", 403],
  ])("reports failed when %s", async (_label, status) => {
    stubFetch({ [REFRESH]: [json(status)] });
    await expect(ensureFreshSession()).resolves.toEqual({ status: "failed" });
  });

  it("refreshes and persists the new expiry on a 200", async () => {
    stubFetch({ [REFRESH]: [json(200, authBody)] });
    const outcome = await ensureFreshSession();
    expect(outcome.status).toBe("refreshed");
    const stored = JSON.parse(localStorage.getItem("mx_auth_session") ?? "{}");
    expect(stored.userId).toBe("u1");
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
  });
});

describe("requestRaw 401 interceptor", () => {
  const listenForLogout = () => {
    const onUnauthorized = vi.fn();
    window.addEventListener("mx:unauthorized", onUnauthorized);
    return {
      onUnauthorized,
      stop: () => window.removeEventListener("mx:unauthorized", onUnauthorized),
    };
  };

  it("does not log out when the refresh cannot reach the bridge", async () => {
    stubFetch({ "/api/v1/conversations": [json(401)], [REFRESH]: [networkDown()] });
    const { onUnauthorized, stop } = listenForLogout();

    const error = await requestRaw("/api/v1/conversations").catch((e: unknown) => e);
    stop();

    expect(error).toBeInstanceOf(ApiError);
    // Not 401: that status means "signed out" to toastError and the callers.
    expect((error as ApiError).status).toBe(0);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("logs out when the bridge refuses the refresh", async () => {
    stubFetch({ "/api/v1/conversations": [json(401)], [REFRESH]: [json(401)] });
    const { onUnauthorized, stop } = listenForLogout();

    const error = await requestRaw("/api/v1/conversations").catch((e: unknown) => e);
    stop();

    expect((error as ApiError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("retries the request once the refresh succeeds", async () => {
    stubFetch({
      "/api/v1/conversations": [json(401), json(200, { ok: true })],
      [REFRESH]: [json(200, authBody)],
    });
    const res = await requestRaw("/api/v1/conversations");
    expect(res.status).toBe(200);
  });
});

describe("restoreSession", () => {
  it("returns the session when the access token is still valid", async () => {
    stubFetch({ [SESSION]: [json(200, authBody)] });
    await expect(restoreSession()).resolves.toMatchObject({ user_id: "u1" });
  });

  it("returns null only when the bridge says there is no session", async () => {
    stubFetch({ [SESSION]: [json(401)], [REFRESH]: [json(401)] });
    await expect(restoreSession()).resolves.toBeNull();
  });

  it("throws — instead of reporting signed out — when the session check gets no answer", async () => {
    stubFetch({ [SESSION]: [networkDown()] });
    await expect(restoreSession()).rejects.toThrow("Failed to fetch");
  });

  it("throws when the refresh gets no answer", async () => {
    stubFetch({ [SESSION]: [json(401)], [REFRESH]: [json(503)] });
    await expect(restoreSession()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("restoreSessionWhenReachable", () => {
  it("waits for the network and then restores the session", async () => {
    const fetchMock = stubFetch({ [SESSION]: [networkDown(), json(200, authBody)] });
    const onUnreachable = vi.fn();

    const pending = restoreSessionWhenReachable({ onUnreachable });
    // The retry listener is attached in the same tick as the callback, so the
    // `online` event below lands in the wait rather than before it.
    await vi.waitFor(() => expect(onUnreachable).toHaveBeenCalled());
    window.dispatchEvent(new Event("online"));

    await expect(pending).resolves.toMatchObject({ user_id: "u1" });
    expect(onUnreachable).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when aborted", async () => {
    stubFetch({ [SESSION]: [networkDown()] });
    const controller = new AbortController();
    const onUnreachable = vi.fn();

    const pending = restoreSessionWhenReachable({ signal: controller.signal, onUnreachable });
    await vi.waitFor(() => expect(onUnreachable).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
