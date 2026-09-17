const CONSENT_KEY = "mx_cookie_consent";
const CONSENT_VERSION = "1.0";

type CookieConsentData = {
  accepted: boolean;
  acceptedAt: string;
  version: string;
};

/**
 * In-process fallback for browsers that throw on localStorage writes (Safari ITP
 * in embedded contexts, "block all cookies", strict enterprise policy). Without
 * it an accepted consent is lost the moment the write fails, so the gate re-asks
 * on every document — and a user who already holds a session cookie can never
 * get past it. This at least holds the consent for the life of the document.
 */
let inMemoryConsent = false;

export function saveCookieConsent(): void {
  inMemoryConsent = true;
  try {
    const data: CookieConsentData = {
      accepted: true,
      acceptedAt: new Date().toISOString(),
      version: CONSENT_VERSION,
    };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable — silently ignore
  }
}

export function loadCookieConsent(): CookieConsentData | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CookieConsentData;
  } catch {
    return null;
  }
}

export function hasCookieConsent(): boolean {
  if (inMemoryConsent) return true;
  const data = loadCookieConsent();
  return data !== null && data.accepted === true && data.version === CONSENT_VERSION;
}

export function clearCookieConsent(): void {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    // localStorage unavailable — silently ignore
  }
}
