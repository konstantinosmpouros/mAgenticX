import type { MessageOut } from "@/shared/lib/types";

// The pure geometry of ChatBody's "keep the stream in view" scrolling, apart
// from the component so the rules can be tested without a layout engine.

// Gap kept above the question while it sits anchored at the top during streaming.
export const SCROLL_PADDING_TOP = 24;
// Gap kept below the newest line so it never butts against the composer.
export const BOTTOM_BREATHING_ROOM = 48;

/**
 * Where the view should sit while a reply streams, and how much room the spacer
 * below the content must add (all in scroll coordinates). The question is held
 * near the top while the answer is short; once the newest line would reach the
 * bottom edge the view rides the bottom instead, with breathing room. The two
 * meet without a step, so the hand-off is seamless.
 *
 * `heading` is where the view is going (where it is, at rest). With no question
 * to anchor yet (a retry, before its reply exists) the view stays there. With
 * `hold` (the per-token follow) it never moves back up from there either — the
 * user may have scrolled to the very bottom, into the spacer.
 *
 * The spacer keeps both the target and the view's current spot (`scrollTop`)
 * reachable: shortening the page under the view made the browser clamp it up a
 * step — a jump the motion could not smooth, and that read as the user
 * scrolling. A later follow relaxes it once the view has moved.
 */
export function streamScrollTarget(m: {
  viewportHeight: number;
  scrollTop: number;
  heading: number;
  contentBottom: number;
  anchorTop: number | null;
  hold?: boolean;
}) {
  const target =
    m.anchorTop === null
      ? Math.max(0, m.heading)
      : Math.max(
          0,
          m.anchorTop - SCROLL_PADDING_TOP,
          m.contentBottom + BOTTOM_BREATHING_ROOM - m.viewportHeight,
          m.hold ? m.heading : 0,
        );
  const lowest = Math.max(target, m.scrollTop);
  return {
    target,
    spacer: Math.max(BOTTOM_BREATHING_ROOM, lowest + m.viewportHeight - m.contentBottom),
  };
}

/**
 * The question the streaming reply answers — the turn the view anchors to. Only a
 * LIVE turn counts: the optimistic echo (the user's own message, which is last
 * the moment they send, before the run exists), or the parent of the reply being
 * written when that reply is the newest message. A stale thinking state from the
 * previous turn must not name the previous question, or the view would first head
 * there and then turn around.
 */
export function findStreamAnchor(
  messages: MessageOut[],
  liveReplyId: string | null,
): string | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  if (last.sender === "user") return last.id;
  if (liveReplyId && last.id === liveReplyId) return last.parentMessageId ?? last.id;
  return null;
}
