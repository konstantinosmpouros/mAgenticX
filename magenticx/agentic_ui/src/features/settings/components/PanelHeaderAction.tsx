import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { PanelHeader } from "@/features/settings/panel-header-context";

/**
 * The settings panel header's page action (e.g. "Refresh usage").
 *
 * Styled as the panel's close button — a round ghost icon, no box — so the two
 * read as a pair; its name is the tooltip and the accessible label, never
 * visible text. Every click turns the icon at least once, even when the work
 * finishes in a few milliseconds, so a fast refresh never looks like a click
 * that did nothing; while the action is busy it keeps turning, and it stops on
 * a full turn (`animationiteration`) rather than snapping back mid-spin.
 */
export function PanelHeaderAction({ action }: { action: NonNullable<PanelHeader["action"]> }) {
  const [spinning, setSpinning] = useState(false);
  const Icon = action.icon;

  useEffect(() => {
    if (action.busy) setSpinning(true);
  }, [action.busy]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            setSpinning(true);
            action.onClick();
          }}
          disabled={action.busy}
          aria-label={action.label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/65 transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-[0.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:cursor-default motion-reduce:active:scale-100 sm:self-end"
        >
          <Icon
            size={17}
            aria-hidden
            className={cn(spinning && "animate-spin motion-reduce:animate-none")}
            onAnimationIteration={() => {
              if (!action.busy) setSpinning(false);
            }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{action.label}</TooltipContent>
    </Tooltip>
  );
}
