import * as React from "react";
import { motion } from "framer-motion";

import type { AutomationKind } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { automationKind } from "@/features/automations/lib/kinds";

/**
 * The chrome every Automations card wears, whatever its kind: the animated
 * frame and surface, the kind badge, the small neutral chips and the
 * icon-only actions. A kind's card (schedule, workflow) only fills the body.
 */

/** The kind badge, from the kind registry ("Schedule", "Workflow"). */
export function KindBadge({ kind }: { kind: AutomationKind }) {
  const meta = automationKind(kind);
  const Icon = meta.icon;
  return (
    <span
      data-kind={kind}
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.badgeTone,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </span>
  );
}

/** A small neutral chip (target mode, private, version). */
export function MetaChip({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}

/** An icon-only action with a tooltip; hover/focus surfaces match the sidebar. */
export function ActionButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-50",
            danger
              ? "supports-[hover:hover]:hover:bg-destructive/10 supports-[hover:hover]:hover:text-destructive"
              : "supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export type AutomationCardFrameProps = {
  kind: AutomationKind;
  index: number;
  reduceMotion: boolean;
  /** Something is running: the card wears the live border (`.subagent-card`). */
  active?: boolean;
  /** Quieter (a paused automation). */
  dimmed?: boolean;
  /** Just created: scrolls itself into view and pulses once. */
  highlighted?: boolean;
  children: React.ReactNode;
};

/**
 * A card's frame: the staggered entrance and exit (inside the page's
 * AnimatePresence), the lift on hover, the gradient surface and, when just
 * created, the scroll-into-view and single pulse.
 */
export const AutomationCardFrame = React.forwardRef<HTMLDivElement, AutomationCardFrameProps>(
  function AutomationCardFrame(
    { kind, index, reduceMotion, active = false, dimmed = false, highlighted, children },
    ref,
  ) {
    const surfaceRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (!highlighted) return;
      // `nearest`: no jump when the card is already on screen.
      surfaceRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }, [highlighted, reduceMotion]);
    const delay = Math.min(index * 0.04, 0.32);

    return (
      <motion.div
        ref={ref}
        layout={reduceMotion ? false : "position"}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={
          reduceMotion
            ? { opacity: 0, transition: { duration: 0 } }
            : { opacity: 0, scale: 0.96, transition: { duration: 0.16, ease: "easeIn" } }
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : {
                opacity: { duration: 0.24, delay },
                y: { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay },
                scale: { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay },
                layout: { type: "spring", stiffness: 520, damping: 42, mass: 0.8 },
              }
        }
        data-testid="automation-card"
        data-automation-kind={kind}
        whileHover={
          reduceMotion ? undefined : { y: -2, transition: { duration: 0.2, ease: "easeOut" } }
        }
        className="subagent-card group/task rounded-2xl"
        data-active={active ? "true" : "false"}
      >
        <div
          ref={surfaceRef}
          className={cn(
            "relative flex h-full flex-col overflow-hidden rounded-2xl border transition-[border-color,box-shadow] duration-200",
            "bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.55)_100%)]",
            "shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] supports-[hover:hover]:group-hover/task:shadow-card",
            active
              ? "border-transparent"
              : "border-border/70 supports-[hover:hover]:group-hover/task:border-primary/30",
            dimmed && "opacity-[0.88]",
          )}
        >
          <span className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-primary/[0.05] to-transparent" />
          {highlighted ? (
            // The "just created" pulse: one ring that fades in and out (opacity
            // only). Reduced motion gets no pulse — the scroll alone lands it.
            <motion.span
              aria-hidden
              data-testid="automation-card-pulse"
              className="pointer-events-none absolute inset-0 z-[2] rounded-2xl ring-2 ring-inset ring-primary/60"
              initial={{ opacity: 0 }}
              animate={reduceMotion ? { opacity: 0 } : { opacity: [0, 1, 0] }}
              transition={reduceMotion ? { duration: 0 } : { duration: 1.1, ease: "easeOut" }}
            />
          ) : null}
          {children}
        </div>
      </motion.div>
    );
  },
);

/** The loading placeholder for one card. */
export function AutomationCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4" aria-hidden>
      <div className="flex items-start gap-3">
        <div className="loading-skeleton h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2 pt-0.5">
          <div className="loading-skeleton h-3.5 w-3/5 rounded-full" />
          <div className="loading-skeleton h-3 w-2/5 rounded-full" />
        </div>
        <div className="loading-skeleton h-5 w-16 rounded-full" />
      </div>
      <div className="loading-skeleton mt-4 h-12 rounded-xl" />
      <div className="loading-skeleton mt-3 h-3 w-1/3 rounded-full" />
      <div className="mt-4 flex justify-between border-t border-border/50 pt-3">
        <div className="loading-skeleton h-5 w-28 rounded-full" />
        <div className="loading-skeleton h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}
