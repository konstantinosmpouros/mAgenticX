import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/shared/lib/utils";

type ScrollAreaProps = React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  viewportRef?: React.Ref<HTMLDivElement>;
  // The scrollbar renders as an OVERLAY on the viewport's right edge; callers
  // whose content runs close to that edge (e.g. the settings nav rail) pass a
  // narrower bar so it sits inside their gutter instead of over the content.
  scrollBarClassName?: string;
};

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, onScroll, viewportRef, scrollBarClassName, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    {/* Radix wraps viewport children in an inline `display: table` div, which
        sizes to the widest unwrappable line instead of shrinking — so `truncate`
        content forces horizontal clipping on narrow screens. Force it to `block`
        so children can shrink; horizontal consumers (Suggestions) still overflow
        via their own `w-max` inner wrapper. */}
    <ScrollAreaPrimitive.Viewport
      className="h-full w-full rounded-[inherit] [&>div]:!block"
      onScroll={onScroll}
      ref={viewportRef as any}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar className={scrollBarClassName} />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      // make the track transparent (removes the white bg)
      "flex touch-none select-none transition-colors bg-transparent",
      orientation === "vertical" && "h-full w-3 border-l border-l-transparent p-[2px]",
      orientation === "horizontal" && "h-3 flex-col border-t border-t-transparent p-[2px]",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-muted-foreground/20 hover:bg-muted-foreground/30 transition-colors" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
