/**
 * Answer groups: the assistant messages that together answer one user turn.
 *
 * An orchestrator that starts background tasks answers in several runs: its
 * first reply, then one more reply each time a task finishes (the wake-up,
 * parented on a hidden `task_notification` row). In the database every run
 * stays its own message, because retry, resume, fork and per-run usage all hang
 * off it. On screen they read as one answer, so the chat shows a single action
 * bar for the whole group, on its last message, and points its actions at the
 * right member:
 *
 * - Try again → the group's FIRST message, so the whole answer is regenerated
 *   from the user's message (retrying a later member would only redo the part
 *   after the previous task finished).
 * - Fork → the LAST message, so the fork keeps every part of the answer.
 * - Copy → the text of every member, in order, with citation markers turned
 *   into one numbered reference list for the whole answer (plan 42).
 */
import type { CitationSourceMap, MessageOut } from "@/shared/lib/types";
import { citationsToPlainText } from "./citationText";

export type AnswerGroup = {
  /** The first assistant message: what "Try again" regenerates. */
  head: MessageOut;
  /** Every assistant message in the group, in display order. */
  members: MessageOut[];
};

export type AnswerGroupPlace = {
  group: AnswerGroup;
  /** True for the group's last message, the one that carries the action bar. */
  isTail: boolean;
};

/**
 * Map each assistant message of the displayed path to its group.
 *
 * Consecutive assistant messages belong together when nothing but task
 * notices sits between them; any real user message starts a new turn.
 */
export function groupAnswers(messages: readonly MessageOut[]): Map<string, AnswerGroupPlace> {
  const groups: AnswerGroup[] = [];
  let open = false; // whether the next assistant message joins the last group

  for (const message of messages) {
    if (message.kind === "task_notification") continue;
    if (message.sender !== "ai") {
      open = false;
      continue;
    }
    const last = groups[groups.length - 1];
    if (open && last) last.members.push(message);
    else groups.push({ head: message, members: [message] });
    open = true;
  }

  const places = new Map<string, AnswerGroupPlace>();
  for (const group of groups) {
    group.members.forEach((member, index) => {
      places.set(member.id, { group, isTail: index === group.members.length - 1 });
    });
  }
  return places;
}

/**
 * The text "Copy" puts on the clipboard for a whole group. With `sources`, its
 * citation markers become `[1]`, `[2]` — numbered across the whole answer —
 * followed by one "Sources:" list.
 */
export function answerGroupText(group: AnswerGroup, sources?: CitationSourceMap): string {
  const text = group.members
    .map((member) => (member.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  return sources ? citationsToPlainText(text, sources) : text;
}
