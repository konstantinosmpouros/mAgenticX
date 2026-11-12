import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { VIEW_MOTION } from "@/features/workflows/lib/consts";

/**
 * A folded group in a step's details (response headers, stdout / stderr, the
 * raw payload of a step the summary fully says): a quiet row with a chevron,
 * a count and an optional action beside it; the body fades in below.
 */
export function Disclosure({
  title,
  count,
  icon,
  action,
  defaultOpen = false,
  tone = "default",
  children,
}: {
  title: string;
  count?: string;
  icon?: React.ReactNode;
  /** Beside the row (e.g. a copy button), outside the toggle. */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "default" | "error";
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const reduceMotion = useReducedMotion();
  const bodyId = React.useId();
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "flex min-h-[2.25rem] min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] font-medium transition-colors",
            "[@media(pointer:coarse)]:min-h-[2.75rem]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]",
            tone === "error" ? "text-destructive" : "text-foreground/85",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {icon}
          <span className="min-w-0 truncate">{title}</span>
          {count ? (
            <span className="flex-shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            id={bodyId}
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.base, ease: "easeOut" } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.base * 0.65, ease: "easeIn" } }}
            className="min-w-0 pt-1.5"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
