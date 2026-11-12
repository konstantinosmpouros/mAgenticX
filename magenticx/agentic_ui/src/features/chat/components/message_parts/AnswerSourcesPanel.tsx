import { useState } from "react";
import { BookOpen, ChevronDown, CircleHelp } from "lucide-react";

import type { AnswerSources } from "@/features/chat/lib/answerSources";
import { citationHostname, plainSnippet } from "@/shared/lib/citations";
import { isHttpUrl } from "@/shared/lib/schemas";
import type { CitationSource } from "@/shared/lib/types";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { SiteIcon } from "@/shared/ui/site-icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

// The Sources panel of one answer (plan 42), opened from the answer's "More"
// menu: built like the Plan and Sub-agents panels (RunSidePanels) on the same
// Sheet. First the sources the answer's text points at, with no heading; then
// a "More" section, always titled, with the other pages its runs found — the
// first few shown and a long tail behind "N more". Which source falls where:
// lib/answerSources.

/** How many of the "More" sources show before the "N more" button. */
const MORE_VISIBLE = 8;

type AnswerSourcesPanelProps = {
  sources: AnswerSources;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AnswerSourcesPanel({ sources, open, onOpenChange }: AnswerSourcesPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        // Focus the panel itself, not its first button: the help button's
        // tooltip opens on focus and showed up on its own whenever the panel opened.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <SheetHeader className="border-b border-border/70 px-5 py-4 text-left">
          {/* pr-8 keeps the title clear of the sheet's own close button. */}
          <div className="flex items-center gap-1.5 pr-8">
            <SheetTitle className="flex items-center gap-2.5 text-base">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
                <BookOpen className="h-4 w-4" aria-hidden="true" />
              </span>
              Sources
            </SheetTitle>
            <TooltipProvider>
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="About sources"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:h-11 [@media(hover:none)]:w-11"
                  >
                    <CircleHelp className="h-4 w-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  Pages the agent read for this answer
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <SheetDescription className="sr-only">Pages the agent read for this answer</SheetDescription>
        </SheetHeader>
        <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <AnswerSourcesBody sources={sources} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AnswerSourcesBody({ sources }: { sources: AnswerSources }) {
  const [expanded, setExpanded] = useState(false);
  const { cited, more } = sources;
  const shownMore = expanded ? more : more.slice(0, MORE_VISIBLE);
  const hidden = more.length - shownMore.length;

  if (!cited.length && !more.length) {
    return <p className="px-2 text-sm text-muted-foreground">No sources for this answer.</p>;
  }
  return (
    <div className="space-y-6">
      {cited.length ? <SourceRows sources={cited} label="Sources of this answer" /> : null}
      {more.length ? (
        // Its own section, always titled: the other pages the answer's runs read.
        <section aria-labelledby="answer-sources-more" className="space-y-1.5">
          <h3 id="answer-sources-more" className="px-2 text-sm font-semibold text-foreground">
            More
          </h3>
          <SourceRows sources={shownMore} label="More sources" />
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="ml-1 inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:h-11"
            >
              {hidden} more
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function SourceRows({ sources, label }: { sources: CitationSource[]; label: string }) {
  return (
    <ul aria-label={label} className="space-y-0.5">
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
    </ul>
  );
}

function SourceRow({ source }: { source: CitationSource }) {
  if (!isHttpUrl(source.url)) return null;
  const host = citationHostname(source.url);
  return (
    // The title's link stretches over the whole row (after:inset-0): one
    // large target, one link for a screen reader.
    <li className="relative rounded-lg px-2 py-2.5 transition-colors duration-150 hover:bg-muted/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <SiteIcon site={source.url} size={14} />
        <span className="truncate">{host}</span>
      </div>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-foreground outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
      >
        {source.title || host}
      </a>
      {source.snippet ? (
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {plainSnippet(source.snippet)}
        </p>
      ) : null}
    </li>
  );
}
