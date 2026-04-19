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
  | "composer.newline";

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
      mac: [{ key: "b", meta: true }],
      win: [{ key: "b", ctrl: true }],
    },
    labels: {
      mac: "Cmd+B",
      win: "Ctrl+B",
    },
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
      mac: [
        { key: "n", code: "KeyN", meta: true },
        { key: "x", code: "KeyX", meta: true, shift: true },
      ],
      win: [
        { key: "n", code: "KeyN", ctrl: true },
        { key: "x", code: "KeyX", ctrl: true, shift: true },
      ],
    },
    labels: {
      mac: "Cmd+Shift+X",
      win: "Ctrl+Shift+X",
    },
    availabilityNote: "Browsers often reserve Cmd/Ctrl+N. Use Cmd/Ctrl+Shift+X in the web UI.",
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
      mac: [{ key: "k", meta: true }],
      win: [{ key: "k", ctrl: true }],
    },
    labels: {
      mac: "Cmd+K",
      win: "Ctrl+K",
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
        { key: ",", code: "Comma", meta: true },
        { key: ".", code: "Period", meta: true },
      ],
      win: [
        { key: ",", code: "Comma", ctrl: true },
        { key: ".", code: "Period", ctrl: true },
      ],
    },
    labels: {
      mac: "Cmd+, or Cmd+.",
      win: "Ctrl+, or Ctrl+.",
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
      mac: [{ key: "/", code: "Slash", meta: true }],
      win: [{ key: "/", code: "Slash", ctrl: true }],
    },
    labels: {
      mac: "Cmd+/",
      win: "Ctrl+/",
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
      mac: [{ key: "l", meta: true }],
      win: [{ key: "l", code: "KeyL", ctrl: true }],
    },
    labels: {
      mac: "Cmd+L",
      win: "Ctrl+L",
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
      mac: [{ key: "u", meta: true }],
      win: [{ key: "u", code: "KeyU", ctrl: true }],
    },
    labels: {
      mac: "Cmd+U",
      win: "Ctrl+U",
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
      mac: [{ key: "m", meta: true }],
      win: [{ key: "m", code: "KeyM", ctrl: true }],
    },
    labels: {
      mac: "Cmd+M",
      win: "Ctrl+M",
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
      mac: [{ key: "a", meta: true, shift: true }],
      win: [{ key: "a", code: "KeyA", ctrl: true, shift: true }],
    },
    labels: {
      mac: "Cmd+Shift+A",
      win: "Ctrl+Shift+A",
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
      mac: [{ key: "p", meta: true, shift: true }],
      win: [{ key: "p", ctrl: true, shift: true }],
    },
    labels: {
      mac: "Cmd+Shift+P",
      win: "Ctrl+Shift+P",
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
