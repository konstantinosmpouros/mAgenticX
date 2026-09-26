/**
 * Grouping the active branch into the turns the conversation rail draws.
 *
 * The rail is a navigation tool, so the property that matters most is not how
 * the card looks — it is that **every message stays reachable**. A turn that
 * shows only its last two prompts must still jump to the first one, or the
 * message you interrupted has no tick and cannot be found, which is precisely
 * when you would go looking for it.
 */
import { describe, expect, it } from "vitest";

import {
  CARD_CLEARANCE_PX,
  MAGNIFY_MAX_SCALE,
  MAGNIFY_RADIUS_PX,
  MAX_PREVIEW_PROMPTS,
  MAX_PREVIEW_REPLIES,
  groupIntoRailEntries,
  TICK_BASE_PX,
  magnification,
  magnifyScale,
} from "@/features/chat/lib/conversationRail";
import type { MessageOut } from "@/shared/lib/types";

const user = (id: string, content = `prompt ${id}`) =>
  ({ id, sender: "user", content }) as MessageOut;
const ai = (id: string, content = `reply ${id}`) =>
  ({ id, sender: "ai", content }) as MessageOut;

describe("groupIntoRailEntries", () => {
  it("pairs a prompt with the reply that answered it", () => {
    const entries = groupIntoRailEntries([user("u1"), ai("a1")]);

    expect(entries).toHaveLength(1);
    expect(entries[0].prompts).toEqual(["prompt u1"]);
    expect(entries[0].replies).toEqual(["reply a1"]);
    expect(entries[0].answered).toBe(true);
  });

  it("starts a new turn at the first prompt after a reply", () => {
    const entries = groupIntoRailEntries([user("u1"), ai("a1"), user("u2"), ai("a2")]);

    expect(entries).toHaveLength(2);
    expect(entries[0].anchorId).toBe("u1");
    expect(entries[1].anchorId).toBe("u2");
  });

  it("keeps consecutive prompts in one turn", () => {
    // Sending again before the agent answers is one exchange, not three.
    const entries = groupIntoRailEntries([user("u1"), user("u2"), user("u3"), ai("a1")]);

    expect(entries).toHaveLength(1);
    expect(entries[0].messageIds).toEqual(["u1", "u2", "u3", "a1"]);
  });

  it("previews the most recent prompts of a long run", () => {
    const entries = groupIntoRailEntries([user("u1"), user("u2"), user("u3"), ai("a1")]);

    expect(entries[0].prompts).toHaveLength(MAX_PREVIEW_PROMPTS);
    expect(entries[0].prompts).toEqual(["prompt u2", "prompt u3"]);
  });

  it("still jumps to the FIRST message of the turn, not the first one previewed", () => {
    // The load-bearing case. `u1` is dropped from the preview but must stay
    // reachable — scrolling to the top of the turn puts all three on screen.
    const entries = groupIntoRailEntries([user("u1"), user("u2"), user("u3"), ai("a1")]);

    expect(entries[0].anchorId).toBe("u1");
    expect(entries[0].prompts).not.toContain("prompt u1");
  });

  it("marks an interrupted prompt as unanswered", () => {
    // Interrupt, then send again: the first turn never got a reply, and the
    // rail says so rather than hiding it.
    const entries = groupIntoRailEntries([user("u1"), ai("a1"), user("u2")]);

    expect(entries).toHaveLength(2);
    expect(entries[1].answered).toBe(false);
    expect(entries[1].replies).toEqual([]);
  });

  it("attaches every assistant message of a turn to the one prompt", () => {
    // A tool-calling turn emits several assistant messages; they are one
    // exchange, not several.
    const entries = groupIntoRailEntries([user("u1"), ai("a1"), ai("a2"), ai("a3")]);

    expect(entries).toHaveLength(1);
    expect(entries[0].messageIds).toHaveLength(4);
  });

  it("previews the opening replies of a turn, not its tail", () => {
    // The start of a reply identifies it; the end is usually detail.
    const entries = groupIntoRailEntries([user("u1"), ai("a1"), ai("a2"), ai("a3")]);

    expect(entries[0].replies).toHaveLength(MAX_PREVIEW_REPLIES);
    expect(entries[0].replies).toEqual(["reply a1", "reply a2"]);
  });

  it("keeps an opening greeting rather than dropping it", () => {
    // Agents greet before the user says anything; that message has no prompt
    // to attach to and would otherwise vanish from the rail.
    const entries = groupIntoRailEntries([ai("a0"), user("u1"), ai("a1")]);

    expect(entries).toHaveLength(2);
    expect(entries[0].anchorId).toBe("a0");
    expect(entries[0].prompts).toEqual([]);
    expect(entries[0].replies).toEqual(["reply a0"]);
  });

  it("counts a text-less message for navigation but not for the preview", () => {
    // An attachment-only prompt has no content. It still needs a place in the
    // turn so scroll-spy can resolve it — it just contributes no blank row.
    const entries = groupIntoRailEntries([user("u1", ""), ai("a1")]);

    expect(entries[0].messageIds).toContain("u1");
    expect(entries[0].prompts).toEqual([]);
  });

  it("collapses whitespace and caps line length", () => {
    const long = "x".repeat(400);
    const entries = groupIntoRailEntries([user("u1", `  multi\n\n  line  `), ai("a1", long)]);

    expect(entries[0].prompts[0]).toBe("multi line");
    // Capped well below the source so a huge reply never reaches the DOM; the
    // visible ellipsis comes from CSS at the card's real width.
    expect(entries[0].replies[0].length).toBeLessThan(long.length);
  });

  it("returns nothing for an empty branch", () => {
    expect(groupIntoRailEntries([])).toEqual([]);
  });
});

/**
 * The dock-style falloff.
 *
 * It runs on every animation frame while the cursor is near the rail, so the
 * properties worth pinning are the ones that make it read as a single smooth
 * bulge: peak exactly under the cursor, symmetric either side, and genuinely
 * zero at the radius — a curve that stops at 0.02 leaves a visible step where
 * the effect ends.
 */
describe("magnification", () => {
  it("peaks under the cursor", () => {
    expect(magnification(0)).toBe(1);
    expect(magnifyScale(0)).toBe(MAGNIFY_MAX_SCALE);
  });

  it("reaches exactly zero at the radius and stays there", () => {
    expect(magnification(MAGNIFY_RADIUS_PX)).toBe(0);
    expect(magnification(MAGNIFY_RADIUS_PX + 200)).toBe(0);
    // A tick outside the radius must sit at its resting scale, or the rail
    // would render every tick slightly stretched.
    expect(magnifyScale(MAGNIFY_RADIUS_PX)).toBe(1);
  });

  it("is symmetric, so approaching from below feels like from above", () => {
    for (const distance of [5, 17, 40]) {
      expect(magnification(-distance)).toBeCloseTo(magnification(distance), 10);
    }
  });

  it("decreases monotonically away from the cursor", () => {
    // Any rise on the way out would show as a second bump in the rail.
    let previous = magnification(0);
    for (let distance = 1; distance <= MAGNIFY_RADIUS_PX; distance += 1) {
      const current = magnification(distance);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it("is half-height at half the radius", () => {
    // The shape check: a raised cosine crosses 0.5 at the midpoint, where a
    // linear ramp would too — but the curve's smooth ends are what remove the
    // kink at the cursor and the hard edge at the rim.
    expect(magnification(MAGNIFY_RADIUS_PX / 2)).toBeCloseTo(0.5, 10);
  });

  it("survives a non-finite distance", () => {
    // getBoundingClientRect on a detached node yields zeros; NaN must not
    // become a NaN transform, which would blank the tick entirely.
    expect(magnification(Number.NaN)).toBe(0);
    expect(magnifyScale(Number.NaN)).toBe(1);
  });
});

/**
 * The card must clear the bulge.
 *
 * A tick grows leftward from the rail, so the widest it ever gets decides how
 * far out the preview card has to start. These were overlapping when the
 * magnification was first tuned by eye, which is why the clearance is derived
 * from the scale rather than picked — and why that derivation is pinned here.
 */
describe("card clearance", () => {
  it("starts beyond the widest a tick can ever reach", () => {
    const widestTick = TICK_BASE_PX * MAGNIFY_MAX_SCALE;
    expect(CARD_CLEARANCE_PX).toBeGreaterThan(widestTick);
  });

  it("leaves a visible gap rather than merely touching", () => {
    // Flush against the bulge reads as a collision even when it technically
    // is not one.
    const widestTick = TICK_BASE_PX * MAGNIFY_MAX_SCALE;
    expect(CARD_CLEARANCE_PX - widestTick).toBeGreaterThanOrEqual(8);
  });

  it("keeps the bulge a hint rather than a takeover", () => {
    // Guards the size complaint that prompted the retune: a tick that more
    // than doubles, or a radius spanning half the rail, stops reading as a
    // pointer hint and starts redrawing the gutter.
    expect(MAGNIFY_MAX_SCALE).toBeLessThanOrEqual(2);
    expect(MAGNIFY_RADIUS_PX).toBeLessThanOrEqual(40);
  });
});
