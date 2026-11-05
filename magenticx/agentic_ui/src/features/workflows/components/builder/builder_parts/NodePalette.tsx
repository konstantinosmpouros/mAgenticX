import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, GripVertical, Loader2, PanelLeftClose, RotateCcw, Search, SearchX, Shapes, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { WorkflowNodeKindInfo } from "@/shared/lib/types";
import { usePaletteGroups } from "@/features/workflows/hooks/usePaletteGroups";
import { kindBlurb, kindMeta } from "@/features/workflows/lib/kinds";
import {
  ICON_BUTTON,
  INPUT_SM,
  PALETTE_DRAG_TYPE,
  PALETTE_ROW,
  PALETTE_ROW_HEIGHT,
  PALETTE_TILE,
  SMALL_BUTTON,
} from "@/features/workflows/lib/builder/consts";
import { paletteFoldMotion, paletteGroups } from "@/features/workflows/lib/builder/palette";

/** A kind's icon tile in its accent (`kindMeta`), as on the canvas card. */
function KindTile({ kind, className, iconClassName }: { kind: string; className?: string; iconClassName?: string }) {
  const meta = kindMeta(kind);
  const Glyph = meta.icon;
  return (
    <span
      className={cn(PALETTE_TILE, className)}
      style={{ "--wf-accent": meta.accent } as React.CSSProperties}
      data-kind-category={meta.category}
    >
      <Glyph className={cn("h-4 w-4", iconClassName)} aria-hidden />
    </span>
  );
}

/**
 * One palette kind: drags onto the canvas (a card-shaped ghost follows the
 * pointer, the row dims where it was), or adds on click / Enter. Every kind,
 * a trigger too, can be added: the builder's checks (one trigger, reachable
 * steps) say what the graph still needs.
 */
function PaletteItem({ entry, onAdd }: { entry: WorkflowNodeKindInfo; onAdd: (kind: string) => void }) {
  const [dragging, setDragging] = React.useState(false);
  const ghostRef = React.useRef<HTMLDivElement>(null);

  return (
    <li>
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <button
            type="button"
            draggable
            aria-label={`Add ${entry.label}`}
            data-dragging={dragging ? "true" : undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData(PALETTE_DRAG_TYPE, entry.kind);
              event.dataTransfer.effectAllowed = "move";
              if (ghostRef.current) event.dataTransfer.setDragImage?.(ghostRef.current, 28, 24);
              setDragging(true);
            }}
            onDragEnd={() => setDragging(false)}
            onClick={() => onAdd(entry.kind)}
            style={{ height: PALETTE_ROW_HEIGHT }}
            className={cn(
              PALETTE_ROW,
              dragging && "scale-[0.98] border-dashed border-primary/40 bg-primary/[0.04] opacity-60 shadow-none",
            )}
          >
            <KindTile
              kind={entry.kind}
              className="h-9 w-9 group-hover/item:bg-[hsl(var(--wf-accent)/0.18)] group-focus-visible/item:bg-[hsl(var(--wf-accent)/0.18)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-5 text-foreground">{entry.label}</span>
              {entry.description ? (
                <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">
                  {kindBlurb(entry.kind, entry.description)}
                </span>
              ) : null}
            </span>
            <GripVertical
              className="h-4 w-4 flex-shrink-0 text-muted-foreground/0 transition-colors group-hover/item:text-muted-foreground/70 group-focus-visible/item:text-muted-foreground/70"
              aria-hidden
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="max-w-[17rem] text-xs">
          <span className="block font-medium">{entry.label}</span>
          {entry.description ? <span className="mt-0.5 block text-muted-foreground">{entry.description}</span> : null}
          <span className="mt-1 block text-[11px] text-muted-foreground/80">Drag onto the canvas, or click to add.</span>
        </TooltipContent>
      </Tooltip>
      {/* The drag image: a card like the one it becomes, rendered off screen. */}
      <div
        ref={ghostRef}
        aria-hidden
        className="pointer-events-none fixed -left-[9999px] top-0 flex w-[13.5rem] items-center gap-2.5 rounded-2xl border border-primary/40 bg-card px-3 py-2.5 shadow-[0_18px_40px_-18px_hsl(var(--foreground)/0.55)]"
      >
        <KindTile kind={entry.kind} className="h-8 w-8" />
        <span className="truncate text-[13px] font-semibold text-foreground">{entry.label}</span>
      </div>
    </li>
  );
}

/**
 * The palette: every step kind from the catalogue, grouped (Triggers, AI,
 * Data, Tools, Flow, Output…). Each kind shows its icon tile in its accent,
 * its name and a one-line description; drag one onto the canvas to place it
 * there, or click (Enter) to add it beside the selected step. A searchable
 * list whose groups fold (their headings are toggles, remembered per device;
 * a search opens every group with a match). `onClose` adds a close button
 * (the builder opens it from the canvas's Steps button; a phone's sheet has
 * its own).
 */
export function NodePalette({
  catalog,
  isLoading,
  error,
  onRetry,
  onAdd,
  onClose,
}: {
  catalog: readonly WorkflowNodeKindInfo[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onAdd: (kind: string) => void;
  onClose?: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const folding = usePaletteGroups();
  const listId = React.useId();

  const groups = React.useMemo(() => paletteGroups(catalog, query), [catalog, query]);
  const searching = query.trim().length > 0;
  const fold = paletteFoldMotion(reduceMotion);

  return (
    <div className="flex h-full min-h-0 flex-col" role="region" aria-label="Steps">
      <div className="flex-shrink-0 border-b border-border/50">
        <div className="flex h-[3.75rem] items-center gap-2.5 px-3.5">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
            <Shapes className="h-[17px] w-[17px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/80">Add a step</p>
            <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">Steps</h2>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the steps"
              title="Close the steps"
              className={cn(ICON_BUTTON, "h-8 w-8")}
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="relative mx-3.5 mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search steps"
            aria-label="Search steps"
            className={cn(INPUT_SM, "h-9 rounded-xl pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden")}
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear the search"
              className={cn(ICON_BUTTON, "absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2")}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1.5 pb-3 [scrollbar-gutter:stable]">
        {isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground" aria-busy="true">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Loading steps…
          </div>
        ) : error ? (
          <div className="m-1.5 space-y-2 rounded-xl border border-destructive/25 bg-destructive/[0.05] px-3 py-3">
            <p className="text-xs leading-relaxed text-destructive">{error}</p>
            <button type="button" className={SMALL_BUTTON} onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </button>
          </div>
        ) : groups.length ? (
          groups.map((group) => {
            // A search shows every group's matches; otherwise a group shows its
            // kinds unless the user folded it.
            const open = searching || !folding.isFolded(group.id);
            const itemsId = `${listId}-${group.id}`;
            return (
              <section key={group.id} aria-label={group.label} data-folded={open ? "false" : "true"}>
                <h3>
                  <button
                    type="button"
                    onClick={() => folding.toggle(group.id)}
                    disabled={searching}
                    aria-expanded={open}
                    aria-controls={itemsId}
                    aria-label={`${group.label}, ${group.items.length} step${group.items.length === 1 ? "" : "s"}`}
                    title={searching ? undefined : open ? `Fold ${group.label}` : `Show ${group.label}`}
                    className="group/heading flex h-[30px] w-full items-center gap-1.5 rounded-lg px-2 pt-3 pb-1.5 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 disabled:cursor-default"
                  >
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 flex-shrink-0 text-muted-foreground/80 transition-transform duration-200 ease-out motion-reduce:transition-none",
                        !open && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground group-hover/heading:text-foreground/80">
                      {group.label}
                    </span>
                    <span className="h-px flex-1 bg-border/60" aria-hidden />
                    <span className="rounded-full bg-muted/70 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground" aria-hidden>
                      {group.items.length}
                    </span>
                  </button>
                </h3>
                <AnimatePresence initial={false}>
                  {open ? (
                    <motion.ul key="items" id={itemsId} className="space-y-0.5 overflow-hidden" {...fold}>
                      {group.items.map((entry) => (
                        <PaletteItem key={entry.kind} entry={entry} onAdd={onAdd} />
                      ))}
                    </motion.ul>
                  ) : null}
                </AnimatePresence>
              </section>
            );
          })
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
              <SearchX className="h-4 w-4" aria-hidden />
            </span>
            <p className="text-xs text-muted-foreground">
              {searching ? <>No step matches “{query.trim()}”.</> : "No steps are available."}
            </p>
            {searching ? (
              <button type="button" className={SMALL_BUTTON} onClick={() => setQuery("")}>
                Clear the search
              </button>
            ) : null}
          </div>
        )}
      </div>
      <p className="flex flex-shrink-0 items-center gap-2 border-t border-border/50 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <GripVertical className="h-3.5 w-3.5 flex-shrink-0 opacity-70" aria-hidden />
        Drag onto the canvas, or click to add after the selected step.
      </p>
    </div>
  );
}
