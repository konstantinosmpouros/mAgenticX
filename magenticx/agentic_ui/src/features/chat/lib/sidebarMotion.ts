// The main sidebar's motion, in one place so every section and highlight
// moves the same way (and tests can check they do): transform and opacity
// only, instant under reduced motion.

/** A gentle spring for list rows sliding to a new place (a pin, a new chat on top). */
export const ROW_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

/**
 * The selected list row's highlight (Workflows, Pinned, Chats): one layoutId
 * across the lists, so it glides from a chat to a workflow.
 */
export const SIDEBAR_ROW_LAYOUT_ID = "sidebar-active-row";

/**
 * The open page's highlight (Automations, Agents): its own layoutId, so moving
 * between a page and a chat never flies a pill across the whole sidebar.
 */
export const SIDEBAR_PAGE_LAYOUT_ID = "sidebar-active-page";

/**
 * The page highlight's glide between neighbouring entries: a short ease-out
 * tween (no spring, so no bounce or overshoot), position only (no stretch).
 */
export const PAGE_GLIDE = { type: "tween", duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

/** Fade-and-drop for a section's list (Workflows, Pinned, Chats). */
export const sectionListMotion = (reduceMotion: boolean | null) => ({
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: reduceMotion
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, y: -6, transition: { duration: 0.12, ease: "easeIn" as const } },
  transition: reduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" as const },
});

/** A list row: fades and rises in on a short stagger, slides out to the left. */
export const rowMotion = (reduceMotion: boolean | null, index: number) => ({
  layout: "position" as const,
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: reduceMotion
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, x: -8, transition: { duration: 0.15, ease: "easeIn" as const } },
  transition: reduceMotion
    ? { duration: 0 }
    : {
        opacity: { duration: 0.22, delay: Math.min(index * 0.025, 0.3) },
        y: { duration: 0.22, delay: Math.min(index * 0.025, 0.3) },
        layout: ROW_SPRING,
      },
});
