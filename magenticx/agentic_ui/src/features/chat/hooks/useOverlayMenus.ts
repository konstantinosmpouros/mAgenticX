import { useCallback, useState, type RefObject } from "react";

type UseOverlayMenusOptions = {
  /** Focused when the picker opens, so it is keyboard-navigable immediately. */
  agentTriggerRef: RefObject<HTMLButtonElement>;
};

/**
 * The three transient menus anchored to workspace chrome: the header's agent
 * picker, the header's conversation-actions menu, and the sidebar's own
 * floating UI (its context menus and profile menu).
 *
 * The sidebar one is the odd member. Its menus are owned by Radix inside
 * ChatSidebar, so this hook cannot close them directly — it only *knows* one is
 * open (`isSidebarFloatingUiOpen`, reported upward) and asks for a dismissal by
 * bumping a signal the sidebar watches. That indirection is why the flag and the
 * signal are two separate values rather than one boolean.
 */
export function useOverlayMenus({ agentTriggerRef }: UseOverlayMenusOptions) {
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isHeaderActionMenuOpen, setIsHeaderActionMenuOpen] = useState(false);
  const [isSidebarFloatingUiOpen, setIsSidebarFloatingUiOpen] = useState(false);
  const [sidebarDismissFloatingUiSignal, setSidebarDismissFloatingUiSignal] = useState(0);

  /** Keyboard-shortcut entry point: toggles, and focuses the trigger on open. */
  const openAgentPicker = useCallback(() => {
    setIsAgentPickerOpen((prevOpen) => {
      const nextOpen = !prevOpen;
      if (nextOpen) {
        requestAnimationFrame(() => {
          agentTriggerRef.current?.focus();
        });
      }
      return nextOpen;
    });
  }, [agentTriggerRef]);

  const closeAgentPicker = useCallback(() => setIsAgentPickerOpen(false), []);
  const closeHeaderActionMenu = useCallback(() => setIsHeaderActionMenuOpen(false), []);
  const dismissSidebarFloatingUi = useCallback(
    () => setSidebarDismissFloatingUiSignal((prev) => prev + 1),
    [],
  );

  return {
    isAgentPickerOpen,
    setIsAgentPickerOpen,
    openAgentPicker,
    closeAgentPicker,
    isHeaderActionMenuOpen,
    setIsHeaderActionMenuOpen,
    closeHeaderActionMenu,
    isSidebarFloatingUiOpen,
    setIsSidebarFloatingUiOpen,
    sidebarDismissFloatingUiSignal,
    dismissSidebarFloatingUi,
  };
}
