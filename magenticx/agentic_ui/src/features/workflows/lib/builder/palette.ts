import type { WorkflowNodeKindInfo } from "@/shared/lib/types";
import { PALETTE_GROUPS, PALETTE_MOTION } from "./consts";
import { humanize } from "./schemaForm";

export type PaletteGroup = { id: string; label: string; items: WorkflowNodeKindInfo[] };

/**
 * The palette's groups, in `PALETTE_GROUPS` order (a group the catalogue grows
 * later goes last, under a humanized heading), keeping only the kinds that
 * match `query` (label, kind or description) and only groups left non-empty.
 */
export function paletteGroups(catalog: readonly WorkflowNodeKindInfo[], query = ""): PaletteGroup[] {
  const needle = query.trim().toLowerCase();
  const shown = catalog.filter(
    (entry) =>
      !needle ||
      entry.label.toLowerCase().includes(needle) ||
      entry.kind.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  );
  const known = new Set(PALETTE_GROUPS.map((group) => group.id));
  return [
    ...PALETTE_GROUPS,
    ...[...new Set(shown.map((entry) => entry.group))]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: humanize(id) })),
  ]
    .map((group) => ({ ...group, items: shown.filter((entry) => entry.group === group.id) }))
    .filter((group) => group.items.length > 0);
}

/**
 * The palette's folding parts (a group's steps, the search, the hint): height
 * to and from nothing with a fade and a small drop, mirroring the sidebar's
 * section lists (`features/chat/lib/sidebarMotion`). Instant under reduced
 * motion.
 */
export function paletteFoldMotion(reduceMotion: boolean) {
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: PALETTE_MOTION.durationMs / 1000, ease: PALETTE_MOTION.ease };
  return {
    initial: reduceMotion ? { height: 0, opacity: 0 } : { height: 0, opacity: 0, y: -6 },
    animate: { height: "auto", opacity: 1, y: 0 },
    exit: reduceMotion
      ? { height: 0, opacity: 0, transition: { duration: 0 } }
      : { height: 0, opacity: 0, y: -6, transition: { duration: 0.18, ease: PALETTE_MOTION.ease } },
    transition,
  };
}
