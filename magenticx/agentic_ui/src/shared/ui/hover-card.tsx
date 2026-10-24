import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";

import { cn } from "@/shared/lib/utils";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  // Portalled and layered like the tooltip (z-[95]: above the profile panel and
  // its menus, below toasts), so a card opened from the composer is never
  // clipped by the chat column.
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-[95] w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none origin-[--radix-hover-card-content-transform-origin]",
        RADIX_MOTION.popover,
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
