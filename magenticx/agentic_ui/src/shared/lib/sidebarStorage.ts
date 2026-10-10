/**
 * Per-browser memory for how the user left the sidebar's sections.
 *
 * Deliberately outside the IndexedDB UI snapshot (`uiStateStorage.ts`): a
 * section's open/closed state is a one-bit layout preference that must be
 * known on the first paint, and adding it to the snapshot would mean a
 * version bump that discards every cached snapshot for no gain. Nothing
 * user-identifying is stored — only the literal "0" / "1".
 */

export type SidebarSection = "pinned" | "chats";

const sectionKey = (section: SidebarSection) => `mx_sidebar_${section}_open`;

/** Whether a section is expanded; defaults to open, also when storage is unavailable. */
export function loadSidebarSectionOpen(section: SidebarSection): boolean {
  try {
    return localStorage.getItem(sectionKey(section)) !== "0";
  } catch {
    return true;
  }
}

export function saveSidebarSectionOpen(section: SidebarSection, open: boolean): void {
  try {
    localStorage.setItem(sectionKey(section), open ? "1" : "0");
  } catch {
    // localStorage unavailable — the state still holds for this document
  }
}
