/**
 * A site's icon (favicon) beside a source's name — source chips, citation
 * pills, the Sources panel.
 *
 * Written here rather than added as shadcn's `Avatar`: that is the same idea
 * (an image with a fallback on error) but on `@radix-ui/react-avatar`, a new
 * dependency for one tag, and it retries every failed image on every mount —
 * this one remembers the hosts that have no icon for the session.
 *
 * Privacy: the image always comes from our own origin (`faviconUrl`, the
 * bridge fetches and caches it), never from the site or a third-party icon
 * service, and with no referrer. Without a signed-in user (a public share
 * page) nothing is requested at all: the site's initial on a muted tile stands
 * in, as it does whenever the icon fails to load. Decorative either way — the
 * host or title beside it is the accessible name.
 */
import { useState } from "react";

import { faviconUrl } from "@/shared/lib/api";
import { useSessionUserId } from "@/shared/hooks/useSessionUserId";
import { markSiteIconFailed, siteHost, siteIconFailed, siteInitial } from "@/shared/lib/siteIcons";
import { cn } from "@/shared/lib/utils";

type SiteIconProps = {
  /** A page URL or a hostname. */
  site: string;
  /** Edge length in px (14–16 reads best next to text-xs / text-sm). */
  size?: 14 | 16;
  className?: string;
};

export function SiteIcon({ site, size = 16, className }: SiteIconProps) {
  const userId = useSessionUserId();
  const host = siteHost(site);
  const [failed, setFailed] = useState<string | null>(null);
  const box = size === 14 ? "size-3.5" : "size-4";

  if (userId && host && failed !== host && !siteIconFailed(host)) {
    return (
      <img
        src={faviconUrl(userId, host)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        data-testid="site-icon"
        className={cn(box, "shrink-0 rounded-sm object-contain", className)}
        onError={() => {
          markSiteIconFailed(host);
          setFailed(host);
        }}
      />
    );
  }
  return (
    // The initial is drawn by CSS (`content: attr(…)`), not as text, so it never
    // joins the text around it — a copied sentence, a link's accessible name.
    <span
      aria-hidden="true"
      data-testid="site-icon-fallback"
      data-initial={siteInitial(host)}
      className={cn(
        box,
        "inline-grid shrink-0 select-none place-items-center rounded-sm bg-muted font-semibold leading-none text-muted-foreground before:content-[attr(data-initial)]",
        size === 14 ? "text-[8px]" : "text-[9px]",
        className,
      )}
    />
  );
}
