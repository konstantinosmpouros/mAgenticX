import * as React from "react";
import { Check, ChevronsUpDown, Loader2, RotateCw, Search } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { WorkflowToolInfo, WorkflowToolRef, WorkflowToolsState } from "@/shared/lib/types";
import { INPUT, INPUT_SM, SMALL_BUTTON } from "@/features/workflows/lib/builder/consts";
import { findTool, groupTools, toolGroupLabel } from "@/features/workflows/lib/builder/toolArgs";

const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:outline-none";

/** A description's first line, for a one-line row. */
const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";

/** Move focus between the list's rows with the arrow keys (from the search box: into the list). */
function moveFocus(list: HTMLElement | null, from: Element | null, step: 1 | -1) {
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-tool-row]"));
  if (!rows.length) return;
  const at = rows.indexOf(from as HTMLButtonElement);
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
  rows[next].focus();
}

/**
 * A tool step's tool: a searchable list of the tools the step may call
 * (`GET /v1/workflows/tools`), grouped "Built-in" then by server, each row its
 * name and a one-line description; the picked tool's description sits under
 * the trigger. While the list loads the field says so; if it can't be loaded
 * (or no longer lists the picked tool) the current tool is shown as is, so
 * nothing is lost.
 */
export function ToolField({
  id,
  current,
  tools,
  onPick,
  invalid,
  describedBy,
}: {
  id: string;
  /** The tool the config names, or null. */
  current: WorkflowToolRef | null;
  tools: WorkflowToolsState;
  onPick: (tool: WorkflowToolInfo) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const list = React.useRef<HTMLDivElement>(null);

  if (!tools.data) {
    if (tools.isLoading) {
      return (
        <div
          id={id}
          className={cn(INPUT, "flex items-center gap-2 text-muted-foreground")}
          role="status"
          aria-busy="true"
        >
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          Loading tools…
        </div>
      );
    }
    // The list is unavailable: the picked tool stays as it is.
    return (
      <div>
        <div id={id} className={cn(INPUT, "flex min-w-0 items-center gap-2 bg-muted/30")} aria-describedby={describedBy}>
          <span className={cn("min-w-0 flex-1 truncate", !current && "text-muted-foreground")}>
            {current?.name ?? "No tool picked"}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">The tool list couldn't be loaded.</p>
          <button type="button" className={SMALL_BUTTON} onClick={tools.retry}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const catalog = tools.data;
  const picked = findTool(catalog.tools, current);
  const groups = groupTools(catalog.tools, query);
  const pick = (tool: WorkflowToolInfo) => {
    setOpen(false);
    setQuery("");
    onPick(tool);
  };
  const missingNote = current && !picked
    ? current.source === "mcp" && !catalog.mcpAvailable
      ? "Server tools can't be listed right now; this tool is kept."
      : "This tool isn't available any more. Pick another."
    : null;
  const listId = `${id}-list`;

  return (
    <div className="min-w-0">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={cn(INPUT, "flex min-w-0 items-center gap-2 text-left")}
          >
            <span className={cn("min-w-0 flex-1 truncate", !current && "text-muted-foreground/80")}>
              {current?.name ?? "Choose a tool"}
            </span>
            {picked ? (
              <span className="max-w-[40%] flex-shrink-0 truncate text-[11px] text-muted-foreground">
                {toolGroupLabel(picked)}
              </span>
            ) : null}
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] max-w-[calc(100vw-2rem)] p-1.5"
        >
          <div className="relative mb-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveFocus(list.current, null, 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const first = groups[0]?.tools[0];
                  if (first) pick(first);
                }
              }}
              placeholder="Search tools"
              aria-label="Search tools"
              className={cn(INPUT_SM, "pl-8")}
            />
          </div>
          {!catalog.mcpAvailable ? (
            <p className="px-2 pb-1 text-[11.5px] leading-snug text-muted-foreground">
              Server tools can't be listed right now.
            </p>
          ) : null}
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Tools"
            className="scrollbar-muted max-h-72 overflow-y-auto overscroll-contain"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(list.current, document.activeElement, event.key === "ArrowDown" ? 1 : -1);
              }
            }}
          >
            {groups.length ? (
              groups.map((group) => (
                <div key={group.key} role="group" aria-label={group.label} className="py-1">
                  <p className="truncate px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {group.label}
                  </p>
                  {group.tools.map((tool) => {
                    const selected = tool === picked;
                    const blurb = firstLine(tool.description);
                    return (
                      <button
                        key={`${tool.source}:${tool.name}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-tool-row
                        title={tool.description || tool.name}
                        onClick={() => pick(tool)}
                        className={ROW}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-medium text-foreground">{tool.name}</span>
                          {blurb ? <span className="truncate text-[11.5px] text-muted-foreground">{blurb}</span> : null}
                        </span>
                        {selected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {catalog.tools.length ? "No tools match." : "No tools are available."}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {picked?.description ? (
        <p className="mt-1.5 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground">{picked.description}</p>
      ) : null}
      {missingNote ? <p className="mt-1.5 text-xs leading-relaxed text-[hsl(var(--warning))]">{missingNote}</p> : null}
    </div>
  );
}
