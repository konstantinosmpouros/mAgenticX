/**
 * The stack of open modal shells (`PremiumModalShell`), oldest first.
 *
 * Esc closes only the last one: the custom instructions dialog opens over
 * Settings, and one keypress must never close both. Esc has a single owner —
 * the app-wide dismissal cascade (`runActiveUiDismissal`) — which calls
 * `dismissTopModalShell`, so no shell needs a key listener of its own competing
 * with that handler. Kept out of the component file so Fast Refresh still works.
 */

type ModalEntry = { close: () => void };

const openModals: ModalEntry[] = [];

/** Register an open shell; returns the function that unregisters it. */
export function pushModalShell(close: () => void): () => void {
  const entry: ModalEntry = { close };
  openModals.push(entry);
  return () => {
    const index = openModals.indexOf(entry);
    if (index !== -1) openModals.splice(index, 1);
  };
}

/** Close the topmost open modal shell. Returns false when none is open. */
export function dismissTopModalShell(): boolean {
  const top = openModals[openModals.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
