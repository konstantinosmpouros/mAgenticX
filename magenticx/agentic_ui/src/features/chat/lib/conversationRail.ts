import type { MessageOut } from "@/shared/lib/types";

/**
 * Grouping the active branch into the exchanges the conversation rail draws.
 *
 * The rail used to be one tick per message, which made a long thread a wall of
 * near-touching ticks and gave a hover preview nothing coherent to show — half
 * the cards would be a lone "Done." with no idea what it answered. An entry is
 * now a **turn**: the user messages that were sent together, plus every
 * assistant message that replied to them.
 *
 * That halves the tick count on a normal thread, which is what makes the ticks
 * big enough to hover at all.
 */

/** Characters kept per preview line before the DOM sees them. */
const PREVIEW_CHAR_LIMIT = 100;

/** User lines shown in one card. A longer run keeps its most recent prompts. */
export const MAX_PREVIEW_PROMPTS = 2;

/** Assistant lines shown in one card. */
export const MAX_PREVIEW_REPLIES = 2;

export type RailEntry = {
  /**
   * Where the tick jumps to — the **first** message of the group, not the first
   * one previewed.
   *
   * Those differ when a turn holds more prompts than the card shows: a run of
   * three user messages previews the last two, and jumping to the third would
   * leave the first scrolled off with no tick of its own to reach it. Scrolling
   * to the top of the group puts every message in it on screen instead, so
   * nothing in the thread is unreachable from the rail.
   */
  anchorId: string;
  /** Every message id in this group, so scroll-spy can resolve the active tick. */
  messageIds: string[];
  /** Prompt lines, already clipped. At most {@link MAX_PREVIEW_PROMPTS}. */
  prompts: string[];
  /** Reply lines, already clipped. At most {@link MAX_PREVIEW_REPLIES}. */
  replies: string[];
  /** Whether this turn has a reply — false marks an interrupted prompt. */
  answered: boolean;
};

/** One line of preview text: collapsed whitespace, hard-capped length. */
function previewLine(content: string | undefined): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  // Clipped here as well as in CSS on purpose. The ellipsis the user sees comes
  // from `text-overflow`, which adapts to the card's real width; this cap is
  // about not putting a 10 KB assistant message into the DOM on every hover.
  return text.length > PREVIEW_CHAR_LIMIT ? text.slice(0, PREVIEW_CHAR_LIMIT) : text;
}

const isUser = (message: MessageOut): boolean => message.sender !== "ai";

/**
 * Split the active branch into rail entries, in order.
 *
 * A new entry opens at the first user message after any assistant message, so
 * consecutive prompts stay together and every assistant message attaches to the
 * prompts it answered. A thread that opens with an assistant greeting yields a
 * reply-only first entry rather than dropping it.
 *
 * Messages with no text (an attachment-only turn, a tool-only assistant step)
 * still count for navigation — they keep their place in `messageIds` — but
 * contribute no preview line, so a card never shows a blank row.
 */
export function groupIntoRailEntries(messages: MessageOut[]): RailEntry[] {
  const entries: RailEntry[] = [];
  let current: RailEntry | null = null;
  // Tracks whether the entry being built has already seen a reply; the next
  // user message after one starts a new turn.
  let sawReply = false;

  for (const message of messages) {
    const startsTurn = isUser(message) && (current === null || sawReply);
    if (startsTurn) {
      current = {
        anchorId: message.id,
        messageIds: [],
        prompts: [],
        replies: [],
        answered: false,
      };
      entries.push(current);
      sawReply = false;
    }
    if (current === null) {
      // An assistant message before any prompt — the agent's opening greeting.
      current = {
        anchorId: message.id,
        messageIds: [],
        prompts: [],
        replies: [],
        answered: false,
      };
      entries.push(current);
    }

    current.messageIds.push(message.id);
    const line = previewLine(message.content);
    if (isUser(message)) {
      if (line) current.prompts.push(line);
    } else {
      current.answered = true;
      sawReply = true;
      if (line) current.replies.push(line);
    }
  }

  // Keep the most recent prompts and the first replies: the latest prompt is
  // what the turn actually asked, while the opening of a reply is what
  // identifies it — its tail is usually detail.
  for (const entry of entries) {
    entry.prompts = entry.prompts.slice(-MAX_PREVIEW_PROMPTS);
    entry.replies = entry.replies.slice(0, MAX_PREVIEW_REPLIES);
  }
  return entries;
}

/**
 * Dock-style magnification for the rail's ticks.
 *
 * `RADIUS` is how far from the cursor a tick still reacts — the width of the
 * bulge — and `MAX_SCALE` is its height. Roughly four ticks either side at the
 * rail's 8px pitch: enough for the falloff to read as a curve, tight enough
 * that it stays a hint rather than taking over the gutter.
 *
 * **`MAX_SCALE` is load-bearing beyond taste.** A tick grows leftward from the
 * rail, so the widest it ever gets sets how far the preview card must sit to
 * clear it — see `TICK_BASE_PX` / `CARD_CLEARANCE_PX` below. Raising it without
 * moving the card makes the two overlap.
 */
export const MAGNIFY_RADIUS_PX = 36;
export const MAGNIFY_MAX_SCALE = 1.8;

/** Widest resting tick (an answered turn), in px — Tailwind's `w-5`. */
export const TICK_BASE_PX = 20;

/**
 * How far the preview card sits from the rail's right edge.
 *
 * Derived, not chosen: a magnified tick reaches `TICK_BASE_PX * MAX_SCALE`
 * leftward, and the card has to start beyond that or it lands on top of the
 * bulge. Deriving it means tuning the magnification can never silently
 * re-introduce the overlap.
 */
export const CARD_CLEARANCE_PX = Math.ceil(TICK_BASE_PX * MAGNIFY_MAX_SCALE) + 12;

/**
 * Raised-cosine falloff: 1 under the cursor, easing to 0 at the radius.
 *
 * Chosen over a linear ramp because linear leaves a visible kink at the cursor
 * and a hard edge at the radius; this is smooth at both ends, so the rail
 * deforms as one curve instead of a tent.
 */
export function magnification(distancePx: number): number {
  if (!Number.isFinite(distancePx)) return 0;
  const distance = Math.abs(distancePx);
  if (distance >= MAGNIFY_RADIUS_PX) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / MAGNIFY_RADIUS_PX));
}

/** The horizontal scale a tick takes at a given distance from the cursor. */
export function magnifyScale(distancePx: number): number {
  return 1 + (MAGNIFY_MAX_SCALE - 1) * magnification(distancePx);
}
