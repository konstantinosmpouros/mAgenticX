import { useEffect, useState } from "react";
import { Archive, ChevronRight, Loader2, Lock, MessagesSquare, Search } from "lucide-react";

import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { formatCompactTokens } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import type { UsageConversationSort, UsageRange } from "@/shared/lib/api";
import { useUsageConversationList } from "@/features/settings/hooks/useUsageConversationList";
import { rangeLabel } from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import { FillBar, RangeSelect, RowsSkeleton, UsageEmpty, UsageError } from "./UsageParts";

// Level 1a of the Usage tab: every conversation ranked by what it spent (or by
// recency, or by how full its context is), searchable by title and filterable
// by agent, a keyset page at a time. Private chats are never listed — they come
// back as one aggregate row. A row opens that conversation's analysis.

const SEARCH_DEBOUNCE_MS = 300;

const SORTS: { value: UsageConversationSort; label: string }[] = [
  { value: "tokens", label: "Most tokens" },
  { value: "recent", label: "Most recent" },
  { value: "context", label: "Fullest context" },
];

const ALL_AGENTS = "__all__";

const triggerClass =
  "h-9 w-auto min-w-[9rem] gap-2 rounded-xl border-border/60 bg-background/60 px-3 text-xs font-medium";
const contentClass = "z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg";

export function UsageConversations({
  userId,
  range,
  onRangeChange,
  agentOptions,
  refreshToken,
  onBusyChange,
  onOpenConversation,
}: {
  userId: string | null;
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  refreshToken: number;
  onBusyChange: (busy: boolean) => void;
  agentOptions: { id: string; name: string }[];
  onOpenConversation: (id: string, title: string | null) => void;
}) {
  const [sort, setSort] = useState<UsageConversationSort>("tokens");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchText]);

  const list = useUsageConversationList(userId, { sort, range, agentId, query, refreshToken });
  useEffect(() => onBusyChange(list.loading), [list.loading, onBusyChange]);
  const filtered = Boolean(query || agentId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search conversation titles</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search titles"
            maxLength={100}
            className="h-9 rounded-xl border-border/60 bg-background/60 pl-8 text-sm"
          />
        </label>
        <RangeSelect value={range} onChange={onRangeChange} />
        <Select value={agentId ?? ALL_AGENTS} onValueChange={(value) => setAgentId(value === ALL_AGENTS ? null : value)}>
          <SelectTrigger aria-label="Agent" className={triggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={contentClass}>
            <SelectItem value={ALL_AGENTS} className="rounded-lg text-xs">All agents</SelectItem>
            {agentOptions.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} className="rounded-lg text-xs">
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as UsageConversationSort)}>
          <SelectTrigger aria-label="Sort by" className={triggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={contentClass}>
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="rounded-lg text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {list.error && !list.loaded ? (
        <UsageError message={list.error} onRetry={list.reload} />
      ) : !list.loaded ? (
        <RowsSkeleton />
      ) : list.items.length === 0 && !list.privateTotals ? (
        <UsageEmpty icon={MessagesSquare} title={filtered ? "No matching conversations" : "Nothing in this range"}>
          {filtered
            ? "Try another title or agent."
            : sort === "context"
              ? "No conversation has recorded its context yet — it appears after the next answer."
              : `No conversation had answers in the ${rangeLabel(range).toLowerCase()}.`}
        </UsageEmpty>
      ) : (
        <div className="space-y-3">
          <SoftPanel className="divide-y divide-border/40 overflow-hidden">
            {list.items.map((row) => {
              const Icon = mapIcon(row.agentIcon);
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onOpenConversation(row.id, row.title)}
                  className="group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background/70 text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">{row.title || "Untitled conversation"}</span>
                      {row.isArchived ? <Archive className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Archived" /> : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[row.agentName, `${row.answers} ${row.answers === 1 ? "answer" : "answers"}`, row.toolCalls ? `${row.toolCalls} tool calls` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="hidden shrink-0 sm:block">
                    <FillBar tokens={row.contextTokens} window={row.contextWindow} />
                  </span>
                  <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                    {formatCompactTokens(row.totalTokens)}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              );
            })}
            {list.privateTotals ? (
              <div className="flex items-center gap-3 px-4 py-3" aria-label="Private chats, not listed">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background/70 text-muted-foreground">
                  <Lock className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">Private chats</span>
                  <span className="block text-xs text-muted-foreground">
                    {list.privateTotals.conversations} {list.privateTotals.conversations === 1 ? "chat" : "chats"} ·{" "}
                    {list.privateTotals.answers} answers · not listed
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                  {formatCompactTokens(list.privateTotals.totalTokens)}
                </span>
                <span className="w-4 shrink-0" aria-hidden />
              </div>
            ) : null}
          </SoftPanel>
          {list.error ? <UsageError message={list.error} onRetry={list.loadMore} /> : null}
          {list.hasMore ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={list.loadMore}
                disabled={list.loadingMore}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-muted/40 px-4 text-xs font-semibold text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {list.loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                Load more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
