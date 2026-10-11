/**
 * Slash commands in the composer (plan 35) — the pure rules, no React.
 *
 * The agents service owns the catalog; this file only decides what the composer
 * does with it: which commands it can offer, what the caret is typing, which
 * command a draft runs, and how picking one rewrites the draft. A command lives
 * *in the text* (`please /explain this loop`), anywhere a word can start.
 */
import type { SlashCommand } from "@/shared/lib/types";

/**
 * The actions this app knows how to run. A catalog action the app does not
 * know (`/files` until its panel exists) is not offered — never a dead item.
 */
export const CLIENT_ACTIONS = ["compact", "new", "memories", "skills", "rename", "share", "export", "usage"] as const;
export type ClientAction = (typeof CLIENT_ACTIONS)[number];

export const isClientAction = (name: string): name is ClientAction =>
  (CLIENT_ACTIONS as readonly string[]).includes(name);

/** The commands the composer can offer: every prompt command, and the actions it can run. */
export function offeredCommands(catalog: SlashCommand[]): SlashCommand[] {
  return catalog.filter((command) => command.kind === "prompt" || isClientAction(command.name));
}

/** A command that lives in the text and runs with it: every prompt command,
 *  and an action that takes an argument (`/rename [title]`). */
export const takesText = (command: SlashCommand): boolean =>
  command.kind === "prompt" || Boolean(command.argumentHint);

/** A `/word` being typed at the caret: where it sits in the draft, and the word. */
export type CaretToken = { start: number; end: number; query: string };

/**
 * The `/word` the caret is in or right after, when that `/` starts a word (the
 * start of the draft or after whitespace) — so `a/b` and URLs never open the
 * menu. `end` runs to the end of the word, so picking a command replaces all of
 * it even with the caret mid-word.
 */
export function tokenAtCaret(draft: string, caret: number): CaretToken | null {
  const before = /(?:^|\s)\/([a-z0-9-]*)$/.exec(draft.slice(0, caret));
  if (!before) return null;
  const start = caret - before[1].length - 1;
  const after = /^[a-z0-9-]*/.exec(draft.slice(caret))?.[0] ?? "";
  return { start, end: caret + after.length, query: before[1] };
}

/**
 * The menu's items for a query: runnable first, then the rest (they stay
 * visible, with their reason); within each, names that start with the query
 * before names that only contain it.
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (command: SlashCommand) =>
    (command.available ? 0 : 2) + (command.name.startsWith(q) ? 0 : 1);
  return commands
    .filter((command) => command.name.includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** A command recognised in the draft, and where its `/name` sits. */
export type DraftCommand = { command: SlashCommand; start: number; end: number };

/**
 * The command a draft runs: the first `/name` that starts a word, ends at a
 * space or the end, and names a runnable command that lives in the text. One
 * per message — a later `/name` is plain text.
 */
export function findCommand(draft: string, commands: SlashCommand[]): DraftCommand | null {
  const pattern = /(^|\s)\/([a-z0-9-]+)(?=\s|$)/g;
  for (let match = pattern.exec(draft); match; match = pattern.exec(draft)) {
    const command = commands.find((c) => c.name === match![2]);
    if (command && command.available && takesText(command)) {
      const start = match.index + match[1].length;
      return { command, start, end: start + match[2].length + 1 };
    }
  }
  return null;
}

/**
 * The draft after picking `command` for the token at the caret, and where the
 * caret goes. A command that lives in the text replaces the token with
 * `/name ` ; any other action takes the token out (it runs at once).
 */
export function applyPick(draft: string, token: CaretToken, command: SlashCommand): { draft: string; caret: number } {
  const tail = draft.slice(token.end);
  if (takesText(command)) {
    const inserted = `/${command.name}${tail.startsWith(" ") ? "" : " "}`;
    return { draft: draft.slice(0, token.start) + inserted + tail, caret: token.start + inserted.length + (tail.startsWith(" ") ? 1 : 0) };
  }
  const head = draft.slice(0, token.start);
  const joined = head.endsWith(" ") && tail.startsWith(" ") ? head + tail.slice(1) : head + tail;
  return { draft: joined, caret: token.start };
}

/** The draft without the command's `/name` — the text an action runs with (`/rename New title`). */
export function textWithout(draft: string, found: DraftCommand): string {
  return `${draft.slice(0, found.start)}${draft.slice(found.end)}`.replace(/\s+/g, " ").trim();
}
