// Global "dismiss the top-most transient UI" cascade, invoked on Escape and
// click-away. Order is load-bearing: the first open surface is closed and the
// function returns true so the caller can swallow the event; it returns false
// only when nothing was open, letting the caller fall through.
export type DismissActiveUiCtx = {
  isSearchOpen: boolean;
  selectedFilePreview: unknown;
  selectedImage: unknown;
  dictationStatus: string;
  isReportDialogOpen: boolean;
  shareTargetMessage: unknown;
  showUserProfile: boolean;
  showShortcutsPanel: boolean;
  showHelpPanel: boolean;
  isAgentPickerOpen: boolean;
  isHeaderActionMenuOpen: boolean;
  isSidebarFloatingUiOpen: boolean;
  editingMessageId: unknown;
  closeSearchPanel: () => void;
  closeFilePreview: () => void;
  closeImagePreview: () => void;
  cancelDictation: () => void;
  closeReportDialog: () => void;
  closeShareDialog: () => void;
  closeProfilePanel: () => void;
  closeShortcutsPanel: () => void;
  closeHelpPanel: () => void;
  handleCancelEditMessage: () => void;
  closeAgentPicker: () => void;
  closeHeaderActionMenu: () => void;
  /**
   * The sidebar's menus are owned by Radix inside ChatSidebar, so this cascade
   * can only *request* a dismissal rather than perform one.
   */
  dismissSidebarFloatingUi: () => void;
};

export function runActiveUiDismissal(ctx: DismissActiveUiCtx): boolean {
  const {
    isSearchOpen,
    selectedFilePreview,
    selectedImage,
    dictationStatus,
    isReportDialogOpen,
    shareTargetMessage,
    showUserProfile,
    showShortcutsPanel,
    showHelpPanel,
    isAgentPickerOpen,
    isHeaderActionMenuOpen,
    isSidebarFloatingUiOpen,
    editingMessageId,
    closeSearchPanel,
    closeFilePreview,
    closeImagePreview,
    cancelDictation,
    closeReportDialog,
    closeShareDialog,
    closeProfilePanel,
    closeShortcutsPanel,
    closeHelpPanel,
    handleCancelEditMessage,
    closeAgentPicker,
    closeHeaderActionMenu,
    dismissSidebarFloatingUi,
  } = ctx;

  if (isSearchOpen) {
    closeSearchPanel();
    return true;
  }

  if (selectedFilePreview) {
    closeFilePreview();
    return true;
  }

  if (selectedImage) {
    closeImagePreview();
    return true;
  }

  if (dictationStatus !== "idle" && dictationStatus !== "submitting") {
    cancelDictation();
    return true;
  }

  if (isReportDialogOpen) {
    closeReportDialog();
    return true;
  }

  if (shareTargetMessage) {
    closeShareDialog();
    return true;
  }

  if (showShortcutsPanel) {
    closeShortcutsPanel();
    return true;
  }

  if (showHelpPanel) {
    closeHelpPanel();
    return true;
  }

  if (showUserProfile) {
    closeProfilePanel();
    return true;
  }

  if (isAgentPickerOpen) {
    closeAgentPicker();
    return true;
  }

  if (isHeaderActionMenuOpen) {
    closeHeaderActionMenu();
    return true;
  }

  if (isSidebarFloatingUiOpen) {
    dismissSidebarFloatingUi();
    return true;
  }

  if (editingMessageId) {
    handleCancelEditMessage();
    return true;
  }

  if (typeof document !== "undefined") {
    const expandedTrigger = document.querySelector<HTMLElement>('[aria-expanded="true"]');
    if (expandedTrigger) {
      window.dispatchEvent(new Event("magenticx:close-ai-action-menus"));
      expandedTrigger.blur();
      return true;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
      return true;
    }
  }

  return false;
}
