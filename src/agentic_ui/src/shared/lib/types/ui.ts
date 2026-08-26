// ------------------------------------------------------
// Other Schemas from UI
// ------------------------------------------------------
// Thinking state type used in the application
export type ThinkingState = {
  messageId: string;
  thoughts: string[];
  currentThoughtIndex: number;
  isActive: boolean;
  isDone: boolean;
  startTime: number;
  endTime?: number;
  branchPath?: string[];
};

/**
 * Options for the app's keyboard-shortcut handler.
 *
 * Lives in `shared` because `shared/ui/sidebar` has to name this type to accept
 * the injected hook, and `shared` must not import from `features/`. The hook
 * that consumes it stays in `features/chat` — only the data shape is shared.
 */
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
  openShortcutsPanel: () => void;
  startNewChat: () => void;
  dismissActiveUi: () => boolean;
};

/** Signature of the injected shortcut hook (see ChatKeyboardShortcutOptions). */
export type ChatKeyboardShortcutsHook = (
  options: (ChatKeyboardShortcutOptions & { toggleSidebar: () => void }) | null,
) => void;

/**
 * Dictation state machine. In `shared` because the voice feature needs to name
 * it and features must not import from one another — it was declared on the chat
 * composer, which made `features/voice` depend on `features/chat`.
 */
export type DictationStatus = "idle" | "recording" | "review" | "submitting";
