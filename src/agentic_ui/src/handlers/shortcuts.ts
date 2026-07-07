import { PROFILE_PANEL_SHORTCUTS_TAB, type ShortcutActionMap } from "@/shared/lib/shortcuts";

type ShortcutHandlersCtx = {
  toggleSidebar: () => void;
  openSearch: () => void;
  focusComposer: () => void;
  openAttachments: () => void;
  startDictation: () => void;
  triggerVoiceMode: () => void;
  openAgentPicker: () => void;
  togglePrivateMode: () => void;
  openProfilePanel: (tab?: string) => void;
  startNewChat: () => void;
  dismissActiveUi: () => boolean;
};

export function createShortcutHandlers(ctx: ShortcutHandlersCtx): ShortcutActionMap {
  const resolveEscape = () => {
    if (ctx.dismissActiveUi()) {
      return;
    }

    if (typeof document !== "undefined") {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement !== document.body) {
        activeElement.blur();
      }
    }
  };

  return {
    "sidebar.toggle": ctx.toggleSidebar,
    "chat.new": ctx.startNewChat,
    "search.open": ctx.openSearch,
    "composer.focus": ctx.focusComposer,
    "attachments.open": ctx.openAttachments,
    "dictation.start": ctx.startDictation,
    "voice.mode": ctx.triggerVoiceMode,
    "agentPicker.open": ctx.openAgentPicker,
    "private.toggle": ctx.togglePrivateMode,
    "profile.open": () => ctx.openProfilePanel(),
    "shortcuts.open": () => ctx.openProfilePanel(PROFILE_PANEL_SHORTCUTS_TAB),
    "ui.escape": resolveEscape,
  };
}
