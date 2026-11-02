import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/shared/lib/utils";
import { INTERACTIVE_SURFACE } from "@/shared/lib/consts";
import type { Agent } from "@/shared/lib/types";
import { AgentsIcon } from "@/shared/ui/agents-icon";
import { Command, CommandInput, CommandItem, CommandSeparator } from "@/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { AgentSearchDialog } from "@/features/chat/components/AgentSearchDialog";
import {
  PICKER_LIMIT,
  pickerDefaults,
  readRecentAgentIds,
  rememberAgentPick,
  searchPickerAgents,
} from "@/features/chat/lib/agentPicker";

const ROW = cn(
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm",
  "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
);

/**
 * The chat's agent picker: a search box over at most five rows, so it never
 * grows or scrolls however many agents there are (lib/agentPicker.ts). With no
 * search the rows are the recent agents; typing shows the best five matches,
 * and "See all N results" opens the search panel (AgentSearchDialog) with every
 * match, paged. "Browse all agents" opens the Agents section.
 * Arrow keys move, Enter picks, Escape closes.
 */
export function AgentPicker({
  agents,
  selectedId,
  onPick,
  onBrowseAll,
  open,
  onOpenChange,
  triggerRef,
}: {
  agents: Agent[];
  selectedId: string;
  onPick: (id: string) => void;
  /** Opens the Agents section; the row is left out without it. */
  onBrowseAll?: () => void;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  const [query, setQuery] = React.useState("");
  // The search panel: open with the query it was opened from.
  const [panel, setPanel] = React.useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  // Read when the picker opens, so a pick made in another tab shows up.
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!open) return;
    setRecentIds(readRecentAgentIds());
    setQuery("");
  }, [open]);

  const selected = agents.find((agent) => agent.id === selectedId);
  const searching = query.trim().length > 0;
  const { rows, total } = React.useMemo(
    () =>
      searching
        ? searchPickerAgents(agents, query)
        : { rows: pickerDefaults(agents, selectedId, recentIds), total: 0 },
    [agents, query, searching, selectedId, recentIds],
  );

  const pick = (id: string) => {
    rememberAgentPick(id);
    onOpenChange?.(false);
    if (id !== selectedId) onPick(id);
  };
  const browseAll = () => {
    onOpenChange?.(false);
    onBrowseAll?.();
  };
  const seeAll = () => {
    onOpenChange?.(false);
    setPanel({ open: true, query });
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Agent: ${selected?.name ?? "none selected"}`}
            // Width hugs the agent name: the trigger is followed by the "might be
            // inactive" indicator, which must sit next to the chevron.
            className={cn(
              "flex h-11 w-auto max-w-[16rem] items-center gap-2 rounded-xl px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              INTERACTIVE_SURFACE,
            )}
          >
            <span
              className={cn(
                "max-w-[8.5rem] truncate text-lg md:max-w-[10.5rem]",
                selected ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {selected ? selected.name : "Select an agent"}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[18rem] p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Command shouldFilter={false} loop className="rounded-xl bg-background">
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search agents…"
              aria-label="Search agents"
            />
            <CommandPrimitive.List className="p-1.5" label="Agents">
              {!searching && rows.length ? (
                <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recent
                </p>
              ) : null}
              {rows.map((agent) => {
                const Icon = agent.icon;
                const current = agent.id === selectedId;
                return (
                  <CommandItem
                    key={agent.id}
                    value={agent.id}
                    onSelect={() => pick(agent.id)}
                    title={agent.description || undefined}
                    className={ROW}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {agent.name}
                    </span>
                    {!agent.isActive ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-500">
                        inactive
                      </span>
                    ) : agent.kind === "custom" ? (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                        Custom
                      </span>
                    ) : null}
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-primary",
                        current ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                );
              })}
              {searching && !rows.length ? (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                  No agent matches “{query.trim()}”.
                </p>
              ) : null}
              {searching && total > PICKER_LIMIT ? (
                <CommandItem
                  value="__see_all__"
                  onSelect={seeAll}
                  className={cn(ROW, "font-medium text-primary")}
                >
                  <Search className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1">See all {total} results</span>
                </CommandItem>
              ) : null}
              {onBrowseAll ? (
                <>
                  {/* alwaysRender: cmdk hides separators while a search is typed. */}
                  <CommandSeparator alwaysRender className="my-1.5 bg-border/60" />
                  <CommandItem
                    value="__browse_all__"
                    onSelect={browseAll}
                    className={cn(ROW, "text-muted-foreground")}
                  >
                    <AgentsIcon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">Browse all agents</span>
                    {agents.length > PICKER_LIMIT ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {agents.length}
                      </span>
                    ) : null}
                  </CommandItem>
                </>
              ) : null}
            </CommandPrimitive.List>
          </Command>
        </PopoverContent>
      </Popover>
      <AgentSearchDialog
        open={panel.open}
        onOpenChange={(next) => setPanel((prev) => ({ ...prev, open: next }))}
        agents={agents}
        selectedId={selectedId}
        initialQuery={panel.query}
        onPick={(id) => {
          rememberAgentPick(id);
          if (id !== selectedId) onPick(id);
        }}
        onBrowseAll={onBrowseAll}
      />
    </>
  );
}
