import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { EFFORT_HINTS, EFFORT_LABELS, EFFORT_SHORT_LABELS } from "@/shared/lib/consts";
import type { EffortLevel } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { useTouchMenuTrigger } from "@/features/chat/hooks/useTouchMenuTrigger";

type EffortPickerProps = {
  /** The levels the agent's model takes, in order; empty hides the picker. */
  efforts: readonly EffortLevel[];
  /** The level in use; null hides the picker. */
  effort: EffortLevel | null;
  onChange: (level: EffortLevel) => void;
};

/**
 * The composer's reasoning-effort control, left of the dictation button: the
 * level as a quiet text button ("Medium"), opening a menu of the agent's
 * levels. Shown only for an agent whose model takes an effort.
 */
export function EffortPicker({ efforts, effort, onChange }: EffortPickerProps) {
  const [open, setOpen] = React.useState(false);
  const reduceMotion = useReducedMotion();
  const touchMenuTrigger = useTouchMenuTrigger();
  const shown = efforts.length > 0 && effort !== null;
  const label = effort ? `Reasoning effort: ${EFFORT_LABELS[effort]}` : "Reasoning effort";

  React.useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  return (
    <AnimatePresence initial={false}>
      {shown && effort ? (
        <motion.span
          key="effort-picker"
          className="inline-flex shrink-0"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Modal, opened on the tap's click for a finger: the sibling menus'
              pattern (useTouchMenuTrigger explains why). */}
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild {...touchMenuTrigger(() => setOpen((v) => !v))}>
                  <button
                    type="button"
                    aria-label={label}
                    className="group/effort flex h-10 min-w-10 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full pl-3 pr-2 text-sm font-medium sm:pl-3.5 sm:pr-2.5 text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground hover:bg-[hsl(var(--hover-surface))] active:scale-[0.94] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 data-[state=open]:bg-[hsl(var(--hover-surface))] motion-reduce:active:scale-100"
                  >
                    {/* The short name on a phone, where the toolbar is tight. */}
                    <span className="sm:hidden">{EFFORT_SHORT_LABELS[effort]}</span>
                    <span className="hidden sm:inline">{EFFORT_LABELS[effort]}</span>
                    <ChevronDown
                      aria-hidden
                      className="h-4 w-4 shrink-0 opacity-70 transition-transform duration-200 group-data-[state=open]/effort:rotate-180 motion-reduce:transition-none"
                    />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                <p>Reasoning effort</p>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="top" align="end" className="w-56">
              <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
              {efforts.map((level) => {
                const selected = level === effort;
                return (
                  <DropdownMenuItem
                    key={level}
                    role="menuitemradio"
                    aria-checked={selected}
                    onSelect={() => onChange(level)}
                    className="items-start"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{EFFORT_LABELS[level]}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {EFFORT_HINTS[level]}
                      </span>
                    </span>
                    <Check
                      aria-hidden
                      className={cn("mt-0.5 text-foreground", selected ? "opacity-100" : "opacity-0")}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
