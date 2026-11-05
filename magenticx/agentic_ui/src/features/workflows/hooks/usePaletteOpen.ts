import * as React from "react";

import { PALETTE_OPEN_STORAGE_KEY } from "@/features/workflows/lib/builder/consts";

function initialOpen(): boolean {
  try {
    return window.localStorage.getItem(PALETTE_OPEN_STORAGE_KEY) === "true";
  } catch {
    // Storage off (private mode, blocked site data): shut, as by default.
    return false;
  }
}

/**
 * Whether the builder's step palette is open: shut by default (the canvas
 * gets the room; the Steps button opens it), the user's last choice on this
 * device otherwise. A change is remembered when storage allows.
 */
export function usePaletteOpen() {
  const [open, setOpenState] = React.useState(initialOpen);

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    try {
      window.localStorage.setItem(PALETTE_OPEN_STORAGE_KEY, String(next));
    } catch {
      // Not remembered: the choice still holds for this visit.
    }
  }, []);

  return { open, setOpen };
}
