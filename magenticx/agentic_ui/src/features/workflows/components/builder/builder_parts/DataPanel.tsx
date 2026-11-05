import { ChevronRight, Repeat } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowTemplatePath } from "@/shared/lib/types";
import { useDataPanelOpen } from "@/features/workflows/hooks/useDataPanelOpen";
import { groupTemplatePaths, placeholder } from "@/features/workflows/lib/builder/templates";
import { TemplateSourceIcon } from "./TemplateField";

const PILL =
  "inline-flex min-h-[28px] max-w-full cursor-grab items-center gap-1 rounded-md border border-border/60 bg-background/80 px-2 py-0.5 text-[12px] text-foreground/90 transition-colors hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 active:cursor-grabbing [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-3";

/**
 * The inspector's "Data from earlier steps": what this step can read, as
 * small pills under each earlier step (nearest first), then the run's inputs
 * and the variables. A click adds the value to the template field used last
 * (`onInsert`); a drag carries `{{path}}` as plain text into any field.
 * A step that runs in a loop offers "Every run" too. Folded or open, as last
 * left on this device.
 */
export function DataPanel({
  nodeId,
  paths,
  onInsert,
}: {
  nodeId: string;
  paths: readonly WorkflowTemplatePath[];
  onInsert: (path: string) => void;
}) {
  const { open, setOpen } = useDataPanelOpen();
  const sources = groupTemplatePaths(paths.filter((entry) => entry.group !== "output" && !entry.more)).filter(
    (source) => source.entries.length,
  );
  if (!sources.length) return null;
  const headerId = `wf-data-panel-${nodeId}`;
  const panelId = `${headerId}-panel`;
  return (
    <section className="rounded-2xl border border-border/60 bg-muted/10">
      <button
        type="button"
        id={headerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Data from earlier steps</span>
      </button>
      {open ? (
        <div id={panelId} role="region" aria-labelledby={headerId} className="border-t border-border/50 px-3.5 pb-3.5 pt-2.5">
          <p className="mb-2.5 text-xs leading-relaxed text-muted-foreground">
            Click a value to add it to the field you used last, or drag it into any field.
          </p>
          <div className="scrollbar-muted -mx-1 max-h-64 space-y-3 overflow-y-auto overscroll-contain px-1 pb-0.5">
            {sources.map((source) => (
              <div key={source.key} role="group" aria-label={source.title}>
                <p className="mb-1.5 flex min-w-0 items-center gap-2">
                  <TemplateSourceIcon source={source} />
                  <span className="truncate text-[12px] font-medium text-foreground/85">{source.title}</span>
                </p>
                <div className="flex flex-wrap gap-1.5 pl-7">
                  {source.entries.map((entry) => {
                    const every = entry.path.endsWith(".outputs");
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", placeholder(entry.path));
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => onInsert(entry.path)}
                        title={`${entry.label} (${entry.hint})`}
                        aria-label={`Insert ${source.title} › ${entry.label}`}
                        className={PILL}
                      >
                        {every ? <Repeat className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden /> : null}
                        <span className="min-w-0 truncate">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
