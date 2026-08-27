import { useCallback, useState } from "react";

type UseSettingsPanelsOptions = {
  /** Store setter — the active tab is persisted, so it lives outside this hook. */
  setActiveProfileTab: (tab: string) => void;
  requestPersist: () => void;
};

/**
 * Open/closed state for the four settings surfaces reachable from the sidebar
 * profile menu: the full settings panel, the small "Edit profile" card, and the
 * Shortcuts and Help reference panels.
 *
 * Grouped rather than left as four loose booleans because they are addressed as
 * a set — the Escape/click-away cascade closes whichever is topmost, and the
 * keyboard shortcuts open them by name. Each surface exposes explicit
 * open/close callbacks so callers never have to inline a `() => setShow…(true)`
 * arrow, which would be a new function identity on every render of the shell.
 */
export function useSettingsPanels({
  setActiveProfileTab,
  requestPersist,
}: UseSettingsPanelsOptions) {
  const [showUserProfile, setShowUserProfile] = useState(false);
  // The small "Edit profile" dialog opened from the sidebar profile menu —
  // separate surface from the full settings panel, ChatGPT-style.
  const [showEditProfile, setShowEditProfile] = useState(false);
  // Dedicated reference panels (not settings sections), opened from the
  // sidebar profile menu's Help submenu and the Alt+/ shortcut.
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [showHelpPanel, setShowHelpPanel] = useState(false);

  const openProfilePanel = useCallback(
    (tab: string = "general") => {
      setActiveProfileTab(tab);
      setShowUserProfile(true);
      requestPersist();
    },
    [requestPersist, setActiveProfileTab],
  );

  const closeProfilePanel = useCallback(() => setShowUserProfile(false), []);
  const openEditProfile = useCallback(() => setShowEditProfile(true), []);
  const closeEditProfile = useCallback(() => setShowEditProfile(false), []);
  const openShortcutsPanel = useCallback(() => setShowShortcutsPanel(true), []);
  const closeShortcutsPanel = useCallback(() => setShowShortcutsPanel(false), []);
  const openHelpPanel = useCallback(() => setShowHelpPanel(true), []);
  const closeHelpPanel = useCallback(() => setShowHelpPanel(false), []);

  return {
    showUserProfile,
    showEditProfile,
    showShortcutsPanel,
    showHelpPanel,
    openProfilePanel,
    closeProfilePanel,
    openEditProfile,
    closeEditProfile,
    openShortcutsPanel,
    closeShortcutsPanel,
    openHelpPanel,
    closeHelpPanel,
    /** Logout clears the panel directly; exposed for that one caller. */
    setShowUserProfile,
  };
}
