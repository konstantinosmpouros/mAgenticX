/**
 * A segmented control whose selection pill glides between options — the
 * schedule editors' kind and unit pickers (Automations → Schedules, the
 * workflow builder's schedule trigger).
 *
 * Custom because shadcn/ui ships no segmented control and Radix's ToggleGroup
 * is not a dependency here; it is a plain `radiogroup` of buttons, so the
 * arrow-free Tab order and Space/Enter activation of native buttons apply.
 */
import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  idPrefix,
}: {
  value: T;
  options: { id: T; label: string; icon?: React.ReactNode }[];
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  /** A DOM id for the group, so an issue can focus it. */
  idPrefix?: string;
}) {
  const id = React.useId();
  const reduceMotion = useReducedMotion();
  return (
    <div
      id={idPrefix}
      role="radiogroup"
      aria-label={ariaLabel}
      tabIndex={idPrefix ? -1 : undefined}
      className="flex w-full gap-1 rounded-xl bg-muted/70 p-1 ring-1 ring-inset ring-border/50 focus-visible:outline-none"
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={cn(
              "relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              size === "sm" ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-[13px]",
              active
                ? "text-foreground"
                : "text-muted-foreground supports-[hover:hover]:hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }
                }
                className="absolute inset-0 rounded-lg bg-card shadow-[0_1px_3px_hsl(var(--foreground)/0.12)] ring-1 ring-border/60"
              />
            ) : null}
            {opt.icon ? (
              <span className={cn("relative max-[420px]:hidden", active && "text-primary")}>
                {opt.icon}
              </span>
            ) : null}
            <span className="relative truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
