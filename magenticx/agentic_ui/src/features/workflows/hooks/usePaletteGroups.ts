import * as React from "react";

import { PALETTE_GROUPS_STORAGE_KEY } from "@/features/workflows/lib/builder/consts";

function initialFolded(): ReadonlySet<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PALETTE_GROUPS_STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(stored)) return new Set(stored.filter((id): id is string => typeof id === "string"));
  } catch {
    // Storage off or a value that isn't ours: every group starts open.
  }
  return new Set();
}

/**
 * Which of the expanded palette's groups (Triggers, AI, Data…) the user has
 * folded, remembered on this device (when storage allows). Folding is the
 * expanded list's alone: the rail and a search show every group's steps.
 */
export function usePaletteGroups() {
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(initialFolded);

  const toggle = React.useCallback((groupId: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      try {
        window.localStorage.setItem(PALETTE_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered: the choice still holds for this visit.
      }
      return next;
    });
  }, []);

  const isFolded = React.useCallback((groupId: string) => folded.has(groupId), [folded]);

  return { isFolded, toggle };
}
