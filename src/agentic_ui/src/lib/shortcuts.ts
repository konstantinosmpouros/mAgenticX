export type ShortcutId =
  | "sidebar.toggle"
  | "chat.new"
  | "search.open"
  | "composer.focus"
  | "attachments.open"
  | "dictation.start"
  | "agentPicker.open"
  | "private.toggle"
  | "profile.open"
  | "shortcuts.open"
  | "ui.escape"
  | "composer.send"
  | "composer.newline"
  | "voice.mode";

export type ShortcutPlatform = "mac" | "win";

export type ShortcutCategory = "Workspace" | "Chat" | "Composer" | "Dismiss";

export type ShortcutScope = "Global" | "Contextual" | "Composer";

export type ShortcutCombo = {
  key: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutDefinition = {
  id: ShortcutId;
  title: string;
  description: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  implementation: "global" | "local";
  allowInEditable?: boolean;
  combos: {
    mac: ShortcutCombo[];
    win: ShortcutCombo[];
  };
  labels: {
    mac: string;
    win: string;
  };
  availabilityNote?: string;
};

export type ShortcutRuntimeContext = {
  canTogglePrivateMode: boolean;
};

export type ShortcutActionMap = Partial<Record<ShortcutId, () => void>>;

export const PROFILE_PANEL_SHORTCUTS_TAB = "shortcuts";

export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    description: "Open or collapse the main conversation sidebar.",
    category: "Workspace",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      // Alt/Option + physical key (matched by `code`, not the produced character):
      // sidesteps the heavily browser-reserved Ctrl/Cmd combos and stays correct on
      // any keyboard layout. Use Left Alt — AltGr reports as Ctrl+Alt and won't match.
      mac: [{ key: "b", code: "KeyB", alt: true }],
      win: [{ key: "b", code: "KeyB", alt: true }],
    },
    labels: {
      mac: "Option+B",
      win: "Alt+B",
    },
    availabilityNote: "In Firefox, Alt+B also opens the Bookmarks menu.",
  },
  {
    id: "chat.new",
    title: "Start new chat",
    description: "Clear the current thread and return to the empty composer.",
    category: "Workspace",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "n", code: "KeyN", alt: true }],
      win: [{ key: "n", code: "KeyN", alt: true }],
    },
    labels: {
      mac: "Option+N",
      win: "Alt+N",
    },
  },
  {
    id: "search.open",
    title: "Open search",
    description: "Open the conversation search surface or its current placeholder.",
    category: "Workspace",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "k", code: "KeyK", alt: true }],
      win: [{ key: "k", code: "KeyK", alt: true }],
    },
    labels: {
      mac: "Option+K",
      win: "Alt+K",
    },
  },
  {
    id: "profile.open",
    title: "Open profile panel",
    description: "Open the profile and preferences panel.",
    category: "Workspace",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [
        { key: ",", code: "Comma", alt: true },
        { key: ".", code: "Period", alt: true },
      ],
      win: [
        { key: ",", code: "Comma", alt: true },
        { key: ".", code: "Period", alt: true },
      ],
    },
    labels: {
      mac: "Option+, or Option+.",
      win: "Alt+, or Alt+.",
    },
  },
  {
    id: "shortcuts.open",
    title: "Open shortcuts help",
    description: "Open the profile panel directly on the Shortcuts tab.",
    category: "Workspace",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "/", code: "Slash", alt: true }],
      win: [{ key: "/", code: "Slash", alt: true }],
    },
    labels: {
      mac: "Option+/",
      win: "Alt+/",
    },
  },
  {
    id: "composer.focus",
    title: "Focus composer",
    description: "Move focus to the main message composer.",
    category: "Chat",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "l", code: "KeyL", alt: true }],
      win: [{ key: "l", code: "KeyL", alt: true }],
    },
    labels: {
      mac: "Option+L",
      win: "Alt+L",
    },
  },
  {
    id: "attachments.open",
    title: "Open file picker",
    description: "Open the file browser for attaching files and photos.",
    category: "Chat",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      // "A" for Attach. Moved off "U" because Alt+U is swallowed before the page
      // sees it on some setups (OS/app hotkey or keyboard-layout quirk).
      mac: [{ key: "a", code: "KeyA", alt: true }],
      win: [{ key: "a", code: "KeyA", alt: true }],
    },
    labels: {
      mac: "Option+A",
      win: "Alt+A",
    },
  },
  {
    id: "dictation.start",
    title: "Start dictation",
    description: "Start voice dictation from the main composer.",
    category: "Chat",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "j", code: "KeyJ", alt: true }],
      win: [{ key: "j", code: "KeyJ", alt: true }],
    },
    labels: {
      mac: "Option+J",
      win: "Alt+J",
    },
  },
  {
    id: "agentPicker.open",
    title: "Open agent picker",
    description: "Focus and open the active agent selector in the header.",
    category: "Chat",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "g", code: "KeyG", alt: true }],
      win: [{ key: "g", code: "KeyG", alt: true }],
    },
    labels: {
      mac: "Option+G",
      win: "Alt+G",
    },
  },
  {
    id: "private.toggle",
    title: "Toggle private mode",
    description: "Enable or disable private chat mode when the current thread allows it.",
    category: "Chat",
    scope: "Contextual",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "p", code: "KeyP", alt: true }],
      win: [{ key: "p", code: "KeyP", alt: true }],
    },
    labels: {
      mac: "Option+P",
      win: "Alt+P",
    },
    availabilityNote: "Available only when the private toggle is visible.",
  },
  {
    id: "ui.escape",
    title: "Dismiss active UI",
    description: "Blur the active control and let focused UI elements close themselves without stopping inference.",
    category: "Dismiss",
    scope: "Contextual",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "escape" }],
      win: [{ key: "escape" }],
    },
    labels: {
      mac: "Esc",
      win: "Esc",
    },
  },
  {
    id: "voice.mode",
    title: "Voice mode",
    description: "Activate the voice mode button in the composer.",
    category: "Chat",
    scope: "Global",
    implementation: "global",
    allowInEditable: true,
    combos: {
      mac: [{ key: "m", code: "KeyM", alt: true }],
      win: [{ key: "m", code: "KeyM", alt: true }],
    },
    labels: {
      mac: "Option+M",
      win: "Alt+M",
    },
  },
  {
    id: "composer.send",
    title: "Send message",
    description: "Send from the main composer or the inline edit textarea.",
    category: "Composer",
    scope: "Composer",
    implementation: "local",
    combos: {
      mac: [{ key: "enter" }, { key: "enter", meta: true }],
      win: [{ key: "enter" }, { key: "enter", ctrl: true }],
    },
    labels: {
      mac: "Enter or Cmd+Enter",
      win: "Enter or Ctrl+Enter",
    },
  },
  {
    id: "composer.newline",
    title: "Insert newline",
    description: "Insert a newline instead of sending from the main composer or the inline edit textarea.",
    category: "Composer",
    scope: "Composer",
    implementation: "local",
    combos: {
      mac: [{ key: "enter", shift: true }],
      win: [{ key: "enter", shift: true }],
    },
    labels: {
      mac: "Shift+Enter",
      win: "Shift+Enter",
    },
  },
];

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") {
    return "win";
  }

  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") ? "mac" : "win";
}

export function getShortcutLabel(definition: ShortcutDefinition, platform: ShortcutPlatform): string {
  return definition.labels[platform];
}

export function getGlobalShortcuts(): ShortcutDefinition[] {
  return SHORTCUTS.filter((shortcut) => shortcut.implementation === "global");
}
