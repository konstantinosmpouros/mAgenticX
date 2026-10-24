import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { usePanelMotion } from "@/shared/lib/motion/panels";
import { cn } from "@/shared/lib/utils";

/**
 * A full-screen layer with a dimming backdrop and one card, appearing and
 * leaving with the shared `panel` motion (shared/lib/motion/panels).
 *
 * For our own (non-Radix) overlays: PremiumModalShell, Share, Report, the
 * attachment preview, the image lightbox. Pass `open` and keep rendering it:
 * on close the card and the backdrop animate out showing the last content they
 * had, so a caller whose data goes away with the panel (the shared message,
 * the previewed file) does not blank the card mid-exit.
 *
 * Escape, focus and the stacking cascade stay with the caller; this only owns
 * the layer and the motion.
 */
type CardProps = Pick<
  React.HTMLAttributes<HTMLDivElement>,
  "role" | "aria-modal" | "aria-label" | "aria-labelledby" | "tabIndex" | "onClick"
>;

export type ModalLayerProps = {
  open: boolean;
  /** Called on a click on the backdrop. Omit to make the backdrop inert. */
  onBackdropClick?: () => void;
  /** The fixed layer (position, z-index, padding, alignment). */
  className?: string;
  /** The dimming backdrop's look. */
  backdropClassName?: string;
  /** The card wrapper (width, layout). */
  cardClassName?: string;
  cardRef?: React.Ref<HTMLDivElement>;
  cardProps?: CardProps;
  children: React.ReactNode;
};

export function ModalLayer({
  open,
  onBackdropClick,
  className,
  backdropClassName = "bg-black/80 backdrop-blur-md",
  cardClassName,
  cardRef,
  cardProps,
  children,
}: ModalLayerProps) {
  const { panel } = usePanelMotion();
  return (
    <AnimatePresence>
      {open ? (
        <div
          key="modal-layer"
          className={cn("fixed inset-0 flex items-center justify-center", className)}
        >
          <motion.div
            aria-hidden="true"
            className={cn("absolute inset-0 z-0", backdropClassName)}
            onClick={onBackdropClick}
            {...panel.backdrop}
          />
          <motion.div
            ref={cardRef}
            className={cn("relative z-10", cardClassName)}
            {...cardProps}
            {...panel.content}
          >
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
