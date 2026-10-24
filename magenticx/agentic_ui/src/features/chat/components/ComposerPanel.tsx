import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/shared/lib/utils";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { returnFocusOnlyForKeyboard } from "@/shared/lib/focus-return";

// The shell of the panels that open from the composer's control row (the agent
// map, the plan). On a desktop it floats above the composer, as wide as the
// composer, rising out of it; on a phone it is a bottom sheet. Modal (a Radix
// dialog): Esc or a click outside closes it, focus stays inside and goes back
// to the button only after keyboard use (shared/lib/focus-return). What goes
// inside — a header, the scrolling views — is the panel's own.

const PANEL_GAP = 12;
const PANEL_MIN_HEIGHT = 300;
const PANEL_MAX_HEIGHT = 640;
/** A panel with nothing to show yet: a calm, shorter card. */
const COMPACT_HEIGHT = 380;
// Room left above the panel for the header bar.
const HEADER_ROOM = 76;

type Placement = { left: number; width: number; bottom: number; height: number };

/** Above the composer the button sits in, as wide as it, as tall as fits. */
function placeAbove(anchor: HTMLElement | null): Placement | null {
  if (!anchor) return null;
  const shell = (anchor.closest(".composer-shell") as HTMLElement | null) ?? anchor;
  const rect = shell.getBoundingClientRect();
  const viewport = window.innerWidth;
  const width = Math.min(Math.max(rect.width, 480), viewport - 32);
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, 16),
    viewport - width - 16,
  );
  const room = rect.top - PANEL_GAP - HEADER_ROOM;
  const height = Math.min(Math.max(room, PANEL_MIN_HEIGHT), PANEL_MAX_HEIGHT);
  return { left, width, bottom: window.innerHeight - rect.top + PANEL_GAP, height };
}

type ComposerPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button the panel opens from; the panel sits above its composer. */
  anchorRef: React.RefObject<HTMLElement>;
  /** Nothing to show yet: a shorter card on a desktop. */
  compact?: boolean;
  /** For the opening button's `aria-controls`. */
  id?: string;
  contentRef?: React.Ref<HTMLDivElement>;
  onOpenAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** The panel's own entrance has finished. */
  onEntered?: () => void;
  children: React.ReactNode;
};

export function ComposerPanel({
  open,
  onOpenChange,
  anchorRef,
  compact = false,
  id,
  contentRef,
  onOpenAutoFocus,
  onEscapeKeyDown,
  onEntered,
  children,
}: ComposerPanelProps) {
  const isMobile = useIsMobile();
  const [placement, setPlacement] = React.useState<Placement | null>(null);

  React.useLayoutEffect(() => {
    if (!open || isMobile) return;
    const place = () => setPlacement(placeAbove(anchorRef.current));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, isMobile, anchorRef]);

  const desktopStyle: React.CSSProperties | undefined =
    !isMobile && placement
      ? {
          left: placement.left,
          width: placement.width,
          bottom: placement.bottom,
          height: compact ? Math.min(placement.height, COMPACT_HEIGHT) : placement.height,
        }
      : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Appears and leaves with the shared panel motion (shared/lib/motion/panels):
            a panel on a desktop, a bottom sheet on a phone. */}
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[92]",
            isMobile ? "bg-black/45" : "bg-[hsl(var(--background)/0.35)] backdrop-blur-[2px]",
            RADIX_MOTION.backdrop,
          )}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          id={id}
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={returnFocusOnlyForKeyboard}
          onEscapeKeyDown={onEscapeKeyDown}
          style={desktopStyle}
          className={cn(
            "fixed z-[92] flex flex-col overflow-hidden border border-border/70 bg-card text-card-foreground focus:outline-none",
            "shadow-[0_28px_70px_-24px_hsl(var(--foreground)/0.35),0_2px_8px_hsl(var(--foreground)/0.06)]",
            isMobile
              ? cn(
                  "inset-x-0 bottom-0 h-[85dvh] rounded-t-[1.5rem] border-b-0",
                  RADIX_MOTION.sheet.bottom,
                )
              : cn("rounded-[1.5rem]", RADIX_MOTION.panel),
            !isMobile && !placement && "invisible",
          )}
          // Children's own animations bubble here too, hence the target check.
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) onEntered?.();
          }}
        >
          {/* A wash of the brand colour along the top edge. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/[0.07] to-transparent" />
          {isMobile ? (
            <div className="relative mx-auto mt-2.5 h-1 w-10 flex-shrink-0 rounded-full bg-muted-foreground/25" />
          ) : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
