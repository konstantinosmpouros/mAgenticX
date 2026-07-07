import { useEffect, useMemo } from "react";

import { createShortcutHandlers } from "@/handlers/shortcuts";
import {
  detectShortcutPlatform,
  getGlobalShortcuts,
  type ShortcutActionMap,
  type ShortcutCombo,
  type ShortcutDefinition,
  type ShortcutRuntimeContext,
} from "@/shared/lib/shortcuts";

type UseKeyboardShortcutsArgs = {
  actions: ShortcutActionMap;
  context: ShortcutRuntimeContext;
  shortcuts?: ShortcutDefinition[];
};

export type ChatKeyboardShortcutOptions = {
  canTogglePrivateMode: boolean;
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

type SidebarShortcutRuntime = {
  toggleSidebar: () => void;
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
};

function normalizeKey(key: string): string {
  const lowered = key.toLowerCase();
  return KEY_ALIASES[lowered] ?? lowered;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function matchesShortcut(event: KeyboardEvent, combo: ShortcutCombo): boolean {
  // Match on the physical key (event.code) when the combo defines one, so letter
  // shortcuts survive non-Latin layouts (e.g. a Greek layout reports event.key
  // "μ" for the M key) and modifier-shifted glyphs (Option+M is "µ" on macOS).
  const keyMatches = combo.code ? event.code === combo.code : normalizeKey(event.key) === combo.key;

  return (
    keyMatches &&
    event.metaKey === Boolean(combo.meta) &&
    event.ctrlKey === Boolean(combo.ctrl) &&
    event.shiftKey === Boolean(combo.shift) &&
    event.altKey === Boolean(combo.alt)
  );
}

function isShortcutEnabled(definition: ShortcutDefinition, context: ShortcutRuntimeContext): boolean {
  if (definition.id === "private.toggle") {
    return context.canTogglePrivateMode;
  }

  return true;
}

export function useKeyboardShortcuts({
  actions,
  context,
  shortcuts = getGlobalShortcuts(),
}: UseKeyboardShortcutsArgs) {
  useEffect(() => {
    const platform = detectShortcutPlatform();

        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.defaultPrevented) {
            return;
          }

      const editableTarget = isEditableTarget(event.target);

      for (const shortcut of shortcuts) {
        if (!isShortcutEnabled(shortcut, context)) {
          continue;
        }

        if (editableTarget && !shortcut.allowInEditable) {
          continue;
        }

        const combos = shortcut.combos[platform];
        if (!combos.some((combo) => matchesShortcut(event, combo))) {
          continue;
        }

        const action = actions[shortcut.id];
        if (!action) {
          continue;
        }

        event.preventDefault();
        event.stopPropagation();
        action();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [actions, context, shortcuts]);
}

export function useChatKeyboardShortcuts(
  options: (ChatKeyboardShortcutOptions & SidebarShortcutRuntime) | null | undefined,
) {
  const context = useMemo<ShortcutRuntimeContext>(
    () => ({
      canTogglePrivateMode: options?.canTogglePrivateMode ?? false,
    }),
    [options?.canTogglePrivateMode],
  );

  const actions = useMemo<ShortcutActionMap>(() => {
    if (!options) {
      return {};
    }

    return createShortcutHandlers({
      toggleSidebar: options.toggleSidebar,
      openSearch: options.openSearch,
      focusComposer: options.focusComposer,
      openAttachments: options.openAttachments,
      startDictation: options.startDictation,
      triggerVoiceMode: options.triggerVoiceMode,
      openAgentPicker: options.openAgentPicker,
      togglePrivateMode: options.togglePrivateMode,
      openProfilePanel: options.openProfilePanel,
      startNewChat: options.startNewChat,
      dismissActiveUi: options.dismissActiveUi,
    });
  }, [options]);

  useKeyboardShortcuts({
    actions,
    context,
  });
}
