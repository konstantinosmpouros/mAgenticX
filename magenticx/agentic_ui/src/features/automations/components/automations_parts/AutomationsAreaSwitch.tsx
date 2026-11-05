import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { AutomationsArea } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { AUTOMATION_AREAS } from "@/features/automations/lib/kinds";

/**
 * The Automations page's tabs: "Schedules" | "Workflows" as quiet text tabs,
 * the chosen one on a soft fill that glides between them (the toolbar sits
 * on the same row, to the right). A radio group — one tab stop on the chosen
 * area, arrow keys move the choice. The chosen area lives in the URL
 * (`?view=`), so the parent owns it.
 */
export function AutomationsAreaSwitch({
  value,
  onChange,
  className,
}: {
  value: AutomationsArea;
  onChange: (area: AutomationsArea) => void;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const refs = React.useRef(new Map<AutomationsArea, HTMLButtonElement>());
  const index = Math.max(
    0,
    AUTOMATION_AREAS.findIndex((area) => area.id === value),
  );

  const choose = (next: AutomationsArea) => {
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
    const count = AUTOMATION_AREAS.length;
    choose(AUTOMATION_AREAS[(index + step + count) % count].id);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Automation type"
      onKeyDown={handleKeyDown}
      className={cn("flex items-center gap-0.5", className)}
    >
      {AUTOMATION_AREAS.map((area) => {
        const checked = area.id === value;
        return (
          <button
            key={area.id}
            ref={(element) => {
              if (element) refs.current.set(area.id, element);
              else refs.current.delete(area.id);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => choose(area.id)}
            className={cn(
              "relative inline-flex h-8 items-center rounded-lg px-3 text-[13.5px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              checked ? "text-foreground" : "text-muted-foreground supports-[hover:hover]:hover:text-foreground",
            )}
          >
            {checked ? (
              // The chosen tab's soft fill, gliding to the next one.
              <motion.span
                layoutId="automations-area-tab"
                aria-hidden
                className="absolute inset-0 rounded-lg bg-secondary shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }}
              />
            ) : null}
            <span className="relative">{area.label}</span>
          </button>
        );
      })}
    </div>
  );
}
