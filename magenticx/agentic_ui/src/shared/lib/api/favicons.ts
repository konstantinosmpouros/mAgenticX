/**
 * Where a site's icon is served (source chips, citation pills, the Sources
 * panel). The bridge fetches and caches the icon itself, so the browser only
 * ever asks our own origin: no third party (nor the site) learns which pages
 * the user researched. Session-cookie auth, the user's own id in the path;
 * 404 when the site has no usable icon.
 */
import { FAVICONS_BASE_PATH } from "./paths";

export function faviconUrl(userId: string, host: string): string {
  return `${FAVICONS_BASE_PATH}/${encodeURIComponent(userId)}?host=${encodeURIComponent(host)}`;
}
