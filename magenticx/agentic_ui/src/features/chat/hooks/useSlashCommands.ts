import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import {
  applyPick,
  filterCommands,
  findCommand,
  offeredCommands,
  takesText,
  textWithout,
  tokenAtCaret,
  type DraftCommand,
} from "@/features/chat/lib/slashCommands";
import { getAgentCommands } from "@/shared/lib/api";
import type { CommandRef, SlashCommand } from "@/shared/lib/types";

// The catalog changes only with a deploy or a settings toggle; a minute is
// fresh enough, and switching agents back and forth costs nothing.
const STALE_AFTER_MS = 60_000;
const catalogCache = new Map<string, { at: number; commands: SlashCommand[] }>();

/** What the composer needs to show and drive slash commands (ChatInputBar's `slash` prop). */
export type SlashComposer = {
  /** The menu is showing. */
  open: boolean;
  items: SlashCommand[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  select: (command: SlashCommand) => void;
  /** The command the draft runs, and where its `/name` sits — highlighted in place. */
  found: DraftCommand | null;
  /** Replaces the textarea's onChange: the draft and where the caret now is. */
  onDraftChange: (value: string, caret: number) => void;
  /** The caret moved without typing (click, arrows, selection). */
  onCaretMove: (caret: number) => void;
  /** Runs before the textarea's own handling; true when the key was used here. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Runs instead of sending when the draft's command is an action (`/rename …`); true when it did. */
  submitAction: () => boolean;
};

type Options = {
  userId: string | null;
  /** The agent the next message goes to. */
  agentId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  /** Kept equal to the draft's command, which is what a send carries. */
  setPendingCommand: (command: CommandRef | null) => void;
  /** Runs an action command (`compact`, `rename` …) with the text that goes with it. */
  runAction: (name: string, text: string) => void;
  /** Tells the user why a command cannot run. */
  notify: (title: string, description?: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

/**
 * The composer's slash commands (plan 35). A `/word` the caret is on — at the
 * start or mid-sentence — opens the menu; picking a command writes `/name ` in
 * its place, where it stays as highlighted text. The first such `/name` in the
 * draft is the command the message runs, so the command is always exactly what
 * the user sees; deleting the text deletes the command. An action without text
 * (`/compact`) runs on the spot and leaves the draft.
 */
export function useSlashCommands({
  userId,
  agentId,
  draft,
  setDraft,
  setPendingCommand,
  runAction,
  notify,
  textareaRef,
}: Options): SlashComposer {
  const [catalog, setCatalog] = useState<SlashCommand[]>([]);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape closes the menu for this exact token; typing reopens it.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!userId || !agentId) {
      setCatalog([]);
      return;
    }
    const key = `${userId}:${agentId}`;
    const cached = catalogCache.get(key);
    if (cached) setCatalog(cached.commands);
    if (cached && Date.now() - cached.at < STALE_AFTER_MS) return;
    const request = ++requestRef.current;
    getAgentCommands(userId, agentId)
      .then((commands) => {
        catalogCache.set(key, { at: Date.now(), commands });
        if (request === requestRef.current) setCatalog(commands);
      })
      // The menu simply stays empty; "/…" then sends as plain text.
      .catch(() => {
        if (request === requestRef.current && !cached) setCatalog([]);
      });
  }, [userId, agentId]);

  const commands = useMemo(() => offeredCommands(catalog), [catalog]);
  const token = useMemo(() => tokenAtCaret(draft, Math.min(caret, draft.length)), [caret, draft]);
  const tokenKey = token ? `${draft}|${token.start}` : null;
  const items = useMemo(() => (token ? filterCommands(commands, token.query) : []), [commands, token]);
  const open = token !== null && items.length > 0 && dismissedFor !== tokenKey;
  const found = useMemo(() => findCommand(draft, commands), [commands, draft]);
  const foundName = found?.command.name ?? null;

  // The send carries the draft's command — derived, so it can never disagree
  // with the highlighted text.
  useEffect(() => {
    setPendingCommand(foundName ? { name: foundName } : null);
  }, [foundName, setPendingCommand]);

  useEffect(() => setActiveIndex(0), [token?.query]);

  const placeCaret = useCallback(
    (position: number) =>
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(position, position);
      }),
    [textareaRef],
  );

  const select = useCallback(
    (command: SlashCommand) => {
      if (!command.available) {
        notify(`/${command.name} isn't available`, command.unavailableReason ?? undefined);
        return;
      }
      if (!token) return;
      const next = applyPick(draft, token, command);
      setDraft(next.draft);
      setCaret(next.caret);
      placeCaret(next.caret);
      // An action without text was taken out of the draft: it runs now.
      if (!takesText(command)) runAction(command.name, "");
    },
    [draft, notify, placeCaret, runAction, setDraft, token],
  );

  const onDraftChange = useCallback(
    (value: string, position: number) => {
      setDraft(value);
      setCaret(position);
    },
    [setDraft],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + items.length) % items.length);
        return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        select(items[Math.min(activeIndex, items.length - 1)]);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(tokenKey);
        return true;
      }
      return false;
    },
    [activeIndex, items, open, select, tokenKey],
  );

  const submitAction = useCallback((): boolean => {
    if (!found || found.command.kind !== "action") return false;
    runAction(found.command.name, textWithout(draft, found));
    setDraft("");
    return true;
  }, [draft, found, runAction, setDraft]);

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    select,
    found,
    onDraftChange,
    onCaretMove: setCaret,
    onKeyDown,
    submitAction,
  };
}
