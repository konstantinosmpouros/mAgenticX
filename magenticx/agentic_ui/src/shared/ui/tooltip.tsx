import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/shared/lib/utils";
import { lastInputKind } from "@/shared/lib/focus-return";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

/**
 * A tooltip's trigger that opens on focus only when the focus came from the
 * keyboard.
 *
 * Radix opens a tooltip whenever its trigger is focused. Focus also arrives
 * without the user aiming at the trigger: a dialog or panel focusing its first
 * button when it opens, a dialog or menu handing focus back to the button that
 * opened it, the window regaining focus after a file picker or a new tab. Each
 * of those popped a tooltip nobody hovered, and it stayed until something else
 * was hovered. A keyboard user tabbing to the trigger still gets it; a mouse
 * user gets it on hover, as before. (Radix skips its own open when the focus
 * event is default-prevented.)
 */
const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onFocus, ...props }, ref) => (
  <TooltipPrimitive.Trigger
    ref={ref}
    onFocus={(event) => {
      onFocus?.(event);
      if (lastInputKind() !== "keyboard") event.preventDefault();
    }}
    {...props}
  />
));
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // z-[95]: above the profile-panel modal (z-[60]) and its internal
        // sidebar/dropdown layers (z-[80]/z-[90]) so hover labels are never
        // clipped behind an overlay, while staying below toasts (z-[100]).
        // Tooltips are transient hover hints and are always meant to be on top.
        "z-[95] overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md origin-[--radix-tooltip-content-transform-origin]",
        RADIX_MOTION.popover,
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
