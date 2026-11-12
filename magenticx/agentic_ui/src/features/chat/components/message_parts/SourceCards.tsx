/**
 * The pages a search step found, as compact chips (plan 42): what a tool step
 * shows in place of its result whenever the result named sources — for any
 * search tool, Tavily, arXiv or a newly installed MCP server alike. The page
 * contents stay with the agent; the browser gets only each page's title and
 * link.
 *
 * Each chip is a link that opens the page (http(s) only, new tab, `noopener
 * noreferrer nofollow`): the site's icon (served by our own origin, never the
 * site's — see `SiteIcon`) and a short label, the page's title or, without
 * one, its host. The full title and host are in the chip's tooltip.
 */
import { citationHostname } from "@/shared/lib/citations";
import { isHttpUrl } from "@/shared/lib/schemas";
import type { CitationSource } from "@/shared/lib/types";
import { SiteIcon } from "@/shared/ui/site-icon";

export function SourceCards({ sources }: { sources: CitationSource[] }) {
  const pages = sources.filter((source) => isHttpUrl(source.url));
  if (!pages.length) return null;
  return (
    <ul aria-label="Sources" className="flex flex-wrap gap-1.5">
      {pages.map((source) => {
        const host = citationHostname(source.url);
        const label = source.title || host;
        return (
          <li key={source.id} className="min-w-0 max-w-full">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={source.title ? `${source.title} — ${host}` : host}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SiteIcon site={source.url} size={14} />
              <span className="min-w-0 max-w-[14rem] truncate">{label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
