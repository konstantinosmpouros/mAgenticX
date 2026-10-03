import { ExternalLink, GitCommitHorizontal, Scale } from "lucide-react";

import { cn } from "@/shared/lib/utils";

/**
 * SkillProvenance — where a remote skill comes from: its source, the exact
 * version (commit, or the publisher's sha256 digest), and its licence, with a
 * link to read it upstream at that version.
 *
 * One component for both places a remote skill appears — a catalogue search
 * result (what an Add would pin) and a pool card (what the user holds) — so
 * the two can never describe the same skill differently. Custom component
 * because shadcn has no "metadata line" primitive; it is a row of text badges.
 *
 * Every piece is text first: colour is never the only signal.
 */
type SkillProvenanceProps = {
  sourceLabel: string;
  commit: string | null;
  licence: string | null;
  upstreamUrl: string | null;
  className?: string;
};

// A commit reads as git does (7 characters); a publisher digest keeps its
// scheme so it is not mistaken for a commit.
function shortVersion(commit: string): string {
  if (commit.startsWith("sha256:")) return `sha256:${commit.slice(7, 15)}`;
  return commit.slice(0, 7);
}

export default function SkillProvenance({
  sourceLabel,
  commit,
  licence,
  upstreamUrl,
  className,
}: SkillProvenanceProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="truncate font-medium text-foreground/80">{sourceLabel}</span>
      {commit ? (
        <span className="inline-flex items-center gap-1 font-mono tabular-nums" title={commit}>
          <GitCommitHorizontal className="h-3 w-3 shrink-0" aria-hidden />
          <span className="sr-only">Version </span>
          {shortVersion(commit)}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        <Scale className="h-3 w-3 shrink-0" aria-hidden />
        <span className="sr-only">Licence: </span>
        {/* No licence means the publisher distributes the skill itself from its
            own domain — say that, rather than an empty field. */}
        {licence ?? "Published by the source"}
      </span>
      {upstreamUrl ? (
        <a
          href={upstreamUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View source
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}
