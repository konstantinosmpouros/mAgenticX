import * as React from "react";
import { ListTree, Workflow } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { AgentMapViewMode } from "@/features/chat/hooks/useAgentMapView";

// The agent map header's view switch: "Tree" | "Flow", a segmented control. A
// radio group — one tab stop on the chosen view, arrow keys move the choice —
// with a thumb that slides under it. On a phone the labels give way to the
// icons (the names stay for screen readers).

const OPTIONS: Array<{ value: AgentMapViewMode; label: string; icon: React.ReactNode }> = [
  { value: "tree", label: "Tree", icon: <ListTree className="h-3.5 w-3.5" aria-hidden /> },
  { value: "flow", label: "Flow", icon: <Workflow className="h-3.5 w-3.5" aria-hidden /> },
];

type AgentMapViewSwitchProps = {
  value: AgentMapViewMode;
  onChange: (value: AgentMapViewMode) => void;
  /** Hovered or focused: a chance to fetch the flow view before it is chosen. */
  onPreload?: () => void;
  className?: string;
};

export function AgentMapViewSwitch({
  value,
  onChange,
  onPreload,
  className,
}: AgentMapViewSwitchProps) {
  const refs = React.useRef(new Map<AgentMapViewMode, HTMLButtonElement>());
  const index = OPTIONS.findIndex((option) => option.value === value);

  const choose = (next: AgentMapViewMode) => {
    if (next !== value) onChange(next);
    refs.current.get(next)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    choose(OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Agent map view"
      data-agent-map-switch
      onKeyDown={handleKeyDown}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      className={cn(
        "relative grid h-8 flex-shrink-0 grid-cols-2 items-center rounded-full border border-border/70 bg-secondary/55 p-0.5",
        className,
      )}
    >
      {/* The thumb under the chosen option. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full border border-border/70 bg-card shadow-[0_1px_3px_hsl(var(--foreground)/0.1)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          index === 1 && "translate-x-full",
        )}
      />
      {OPTIONS.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element) refs.current.set(option.value, element);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => choose(option.value)}
            className={cn(
              "relative z-[1] flex h-7 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors sm:px-2.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
              checked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("transition-colors", checked && "text-primary")}>
              {option.icon}
            </span>
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
