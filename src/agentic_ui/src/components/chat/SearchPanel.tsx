import * as React from "react";
import { Bot, FileText, MessageSquare, Search, X } from "lucide-react";

import type { WorkspaceSearchResult, WorkspaceSearchResultKind } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

type SearchPanelProps = {
  open: boolean;
  query: string;
  results: WorkspaceSearchResult[];
  defaultResults?: WorkspaceSearchResult[];
  loading: boolean;
  error?: string | null;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
};

const RESULT_GROUP_LABELS: Record<WorkspaceSearchResultKind, string> = {
  conversation: "Conversations",
  message: "Messages",
  file: "Files",
  agent: "Agents",
};

const RESULT_KIND_ORDER: WorkspaceSearchResultKind[] = ["conversation", "message", "file", "agent"];

const ResultIcon = ({ kind }: { kind: WorkspaceSearchResultKind }) => {
  if (kind === "agent") return <Bot className="h-4 w-4" />;
  if (kind === "file") return <FileText className="h-4 w-4" />;
  return <MessageSquare className="h-4 w-4" />;
};

const SearchSkeletonRows = () => (
  <div className="space-y-4 px-2 py-3" aria-label="Searching">
    {Array.from({ length: 3 }).map((_, index) => (
      <div key={`search-skeleton-${index}`} className="flex items-center gap-3">
        <div className="h-9 w-9 flex-shrink-0 rounded-full bg-muted/25" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3.5 w-24 rounded-full bg-muted/25" />
          <div className="h-3.5 w-full max-w-[150px] rounded-full bg-muted/20" />
        </div>
      </div>
    ))}
  </div>
);

export default function SearchPanel({
  open,
  query,
  results,
  defaultResults = [],
  loading,
  error,
  onQueryChange,
  onClose,
  onSelectResult,
}: SearchPanelProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  const hasQuery = query.trim().length > 0;
  const visibleResults = hasQuery ? results : defaultResults;
  const groupedResults = RESULT_KIND_ORDER.map((kind) => ({
    kind,
    items: visibleResults.filter((result) => result.kind === kind),
  })).filter((group) => group.items.length > 0);
  const showEmpty = hasQuery && !loading && !error && results.length === 0;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div
        ref={panelRef}
        className={cn(
          "pointer-events-auto fixed left-1/2 top-1/2 flex max-h-[min(38rem,calc(100svh-2rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 text-foreground shadow-2xl backdrop-blur-xl animate-in fade-in-0 duration-200"
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search..."
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            spellCheck={false}
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={onClose}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-[20rem] overflow-y-auto p-2">
          {loading ? (
            <SearchSkeletonRows />
          ) : error ? (
            <div className="flex min-h-[10rem] items-center justify-center px-4 text-center text-sm text-destructive">
              {error}
            </div>
          ) : !hasQuery ? (
            groupedResults.length > 0 ? (
              <div className="space-y-3">
                {groupedResults.map((group) => (
                  <section key={group.kind} className="space-y-1">
                    <div className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">
                      Recent chats
                    </div>
                    <div className="space-y-1">
                      {group.items.map((result) => (
                        <button
                          key={`${result.kind}-${result.id}`}
                          type="button"
                          onClick={() => onSelectResult(result)}
                          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="sidebar-icon-badge grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl text-primary">
                            <ResultIcon kind={result.kind} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">{result.title}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {result.snippet || result.subtitle || RESULT_GROUP_LABELS[result.kind]}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[10rem] items-center justify-center px-4 text-center text-sm text-muted-foreground">
                Search conversations, messages, files, and agents.
              </div>
            )
          ) : showEmpty ? (
            <div className="flex min-h-[10rem] items-center justify-center px-4 text-center text-sm text-muted-foreground">
              No results
            </div>
          ) : (
            <div className="space-y-3">
              {groupedResults.map((group) => (
                <section key={group.kind} className="space-y-1">
                  <div className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">
                    {RESULT_GROUP_LABELS[group.kind]}
                  </div>
                  <div className="space-y-1">
                    {group.items.map((result) => (
                      <button
                        key={`${result.kind}-${result.id}`}
                        type="button"
                        onClick={() => onSelectResult(result)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="sidebar-icon-badge grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl text-primary">
                          <ResultIcon kind={result.kind} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">{result.title}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {result.snippet || result.subtitle || RESULT_GROUP_LABELS[result.kind]}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
