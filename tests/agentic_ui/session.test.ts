import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSessionValid, type StoredSession } from "@/shared/lib/authStorage";
import { hasCookieConsent, saveCookieConsent } from "@/shared/lib/cookieConsentStorage";

/**
 * Session bootstrap: the gate every page load passes through. Both modules here
 * have caused a lockout — `isSessionValid` because callers read `session.userId`
 * straight after it, and the consent store because a swallowed write turned into
 * an infinite reload for anyone whose browser blocks localStorage.
 */

describe("isSessionValid", () => {
  const session = (expiresAt: number): StoredSession =>
    ({ userId: "u1", expiresAt }) as StoredSession;

  it("rejects a missing or expired session and accepts a live one", () => {
    const live = session(Date.now() + 60_000);
    const expired = session(Date.now() - 1);

    expect(isSessionValid(null)).toBe(false);
    expect(isSessionValid(expired)).toBe(false);
    expect(isSessionValid(live)).toBe(true);
  });

  it("narrows the type so callers can read the session", () => {
    // This is the point of the predicate: reading `.userId` immediately after
    // the check must COMPILE. If the signature regresses to plain `boolean`,
    // `npm run typecheck` fails here — the runtime assertion alone would not
    // notice, which is why the tests are inside the typecheck's include list.
    const maybe: StoredSession | null = session(Date.now() + 60_000);
    if (isSessionValid(maybe)) {
      expect(maybe.userId).toBe("u1");
    } else {
      throw new Error("expected a valid session");
    }
  });
});

describe("cookie consent", () => {
  const realLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: realLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("holds consent in memory when localStorage writes throw", async () => {
    // Safari ITP in an embedded context, "block all cookies", and enterprise
    // policy all throw here. The write failure is swallowed by design — what
    // must NOT happen is the gate re-asking on the same document, which is what
    // put a user with a valid session cookie into an endless reload.
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      },
      configurable: true,
      writable: true,
    });

    const storage = await import("@/shared/lib/cookieConsentStorage");
    expect(storage.hasCookieConsent()).toBe(false);
    expect(() => storage.saveCookieConsent()).not.toThrow();
    expect(storage.hasCookieConsent()).toBe(true);
  });

  it("reports consent once saved through working storage", () => {
    expect(typeof hasCookieConsent()).toBe("boolean");
    saveCookieConsent();
    expect(hasCookieConsent()).toBe(true);
  });
});
