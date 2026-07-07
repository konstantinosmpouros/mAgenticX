const CONSENT_KEY = "mx_cookie_consent";
const CONSENT_VERSION = "1.0";

type CookieConsentData = {
    accepted: boolean;
    acceptedAt: string;
    version: string;
};

export function saveCookieConsent(): void {
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
