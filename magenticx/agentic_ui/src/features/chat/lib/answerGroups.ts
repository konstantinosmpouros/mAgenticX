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
 * - Copy → the text of every member, in order.
 */
import type { MessageOut } from "@/shared/lib/types";

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

/** The text "Copy" puts on the clipboard for a whole group. */
export function answerGroupText(group: AnswerGroup): string {
  return group.members
    .map((member) => (member.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}
