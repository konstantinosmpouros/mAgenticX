// @vitest-environment happy-dom
// The helper listens on `window`, so this file needs a DOM.
import { describe, expect, it } from "vitest";

import { lastInputKind, returnFocusOnlyForKeyboard } from "@/shared/lib/focus-return";

/**
 * A menu closed with the mouse must not hand focus back to its trigger — that
 * leaves the trigger painted as focused, with its tooltip open, until the user
 * clicks somewhere else. Closed from the keyboard it must, so the user carries
 * on from where they were. Pinned: the hand-back is cancelled exactly after
 * pointer use, and a lone modifier key (Cmd/Ctrl+click) still counts as pointer.
 */

const closeEvent = () => new Event("focus", { cancelable: true });

const pointer = () => window.dispatchEvent(new Event("pointerdown"));
const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));

describe("returnFocusOnlyForKeyboard", () => {
  it("cancels the hand-back after a pointer close", () => {
    pointer();
    const event = closeEvent();
    returnFocusOnlyForKeyboard(event);
    expect(lastInputKind()).toBe("pointer");
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the hand-back after keyboard use", () => {
    key("Escape");
    const event = closeEvent();
    returnFocusOnlyForKeyboard(event);
    expect(lastInputKind()).toBe("keyboard");
    expect(event.defaultPrevented).toBe(false);
  });

  it("treats a lone modifier key as part of a pointer action", () => {
    pointer();
    key("Control");
    key("Meta");
    expect(lastInputKind()).toBe("pointer");
  });
});
