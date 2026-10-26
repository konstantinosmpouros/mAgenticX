import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";
import { useIsMobile } from "@/shared/hooks/use-mobile";

/**
 * A panel that slides in over the right of the page — a bottom sheet on a
 * phone — without taking the page away: it is not modal, so the canvas, the
 * import's file and the paste box stay usable beside it. Escape or its close
 * button puts it away; a click elsewhere does not.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  actions,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons in the panel's header, left of its close button. */
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const mobile = useIsMobile();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={mobile}>
      <DialogPrimitive.Portal>
        {mobile ? (
          <DialogPrimitive.Overlay
            className={cn("fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]", RADIX_MOTION.backdrop)}
          />
        ) : null}
        <DialogPrimitive.Content
          onInteractOutside={(event) => {
            if (!mobile) event.preventDefault();
          }}
          className={cn(
            "fixed z-50 flex flex-col bg-background text-foreground shadow-[0_24px_60px_-20px_hsl(var(--foreground)/0.35)] focus:outline-none",
            mobile
              ? cn("inset-x-0 bottom-0 max-h-[88svh] rounded-t-[1.6rem] border-t border-border/60", RADIX_MOTION.sheet.bottom)
              : cn(
                  "bottom-3 right-3 top-3 rounded-[1.6rem] border border-border/60",
                  wide ? "w-[min(620px,calc(100vw-1.5rem))]" : "w-[min(540px,calc(100vw-1.5rem))]",
                  RADIX_MOTION.sheet.right,
                ),
          )}
        >
          {mobile ? (
            <span className="mx-auto mt-2.5 h-1 w-10 flex-shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
          ) : null}
          <div className="flex flex-shrink-0 items-start gap-3 border-b border-border/50 px-5 pb-3.5 pt-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold tracking-tight text-foreground">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            {actions ? <div className="flex flex-shrink-0 items-center gap-1.5">{actions}</div> : null}
            <DialogPrimitive.Close
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
