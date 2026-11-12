/**
 * Pure helpers behind `shared/ui/site-icon` (a source's favicon): the bare
 * host an icon is asked for, the initial its fallback tile shows, and the
 * hosts whose icon failed this session (so a 404 host is asked for once).
 */

// A hostname only — anything else never reaches the icon URL.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** The bare host of an http(s) URL or a hostname, without `www.`; "" when it is neither. */
export function siteHost(urlOrHost: string): string {
  const raw = urlOrHost.trim();
  if (!raw) return "";
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      host = url.hostname;
    } catch {
      return "";
    }
  }
  host = host.toLowerCase().replace(/^www\./, "");
  return HOSTNAME.test(host) ? host : "";
}

/** The site's initial for its fallback tile: the first letter or digit of the host. */
export function siteInitial(host: string): string {
  return (host.match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
}

const failedHosts = new Set<string>();

export function siteIconFailed(host: string): boolean {
  return failedHosts.has(host);
}

export function markSiteIconFailed(host: string): void {
  failedHosts.add(host);
}

/** Forget the hosts that failed (tests). */
export function resetSiteIconFailures(): void {
  failedHosts.clear();
}
