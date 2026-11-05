import * as React from "react";

import { DATA_PANEL_OPEN_STORAGE_KEY } from "@/features/workflows/lib/builder/consts";

function initialOpen(): boolean {
  try {
    return window.localStorage.getItem(DATA_PANEL_OPEN_STORAGE_KEY) !== "false";
  } catch {
    // Storage off (private mode, blocked site data): open, as by default.
    return true;
  }
}

/**
 * Whether the inspector's "Data from earlier steps" fold is open: open by
 * default (it is how a field gets its data), the user's last choice on this
 * device otherwise. A change is remembered when storage allows.
 */
export function useDataPanelOpen() {
  const [open, setOpenState] = React.useState(initialOpen);

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    try {
      window.localStorage.setItem(DATA_PANEL_OPEN_STORAGE_KEY, String(next));
    } catch {
      // Not remembered: the choice still holds for this visit.
    }
  }, []);

  return { open, setOpen };
}
