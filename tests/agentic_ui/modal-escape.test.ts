import { describe, expect, it, vi } from "vitest";

import { dismissTopModalShell, pushModalShell } from "@/shared/lib/modalStack";

/**
 * Esc closes modal shells through one stack: the topmost first, one per
 * keypress. The custom instructions dialog opens over Settings, so closing
 * both on a single Esc (the old behaviour of stacked listeners) is the bug
 * these pin.
 */
describe("modal shell stack", () => {
  it("closes only the topmost shell per dismissal", () => {
    const closeSettings = vi.fn();
    const closeInstructions = vi.fn();
    const unregisterSettings = pushModalShell(closeSettings);
    const unregisterInstructions = pushModalShell(closeInstructions);

    expect(dismissTopModalShell()).toBe(true);
    expect(closeInstructions).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();

    unregisterInstructions();
    expect(dismissTopModalShell()).toBe(true);
    expect(closeSettings).toHaveBeenCalledTimes(1);

    unregisterSettings();
  });

  it("reports false when no shell is open", () => {
    expect(dismissTopModalShell()).toBe(false);
  });

  it("forgets a shell that closed out of order", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();
    const unregisterLower = pushModalShell(closeLower);
    const unregisterUpper = pushModalShell(closeUpper);

    unregisterLower();
    dismissTopModalShell();
    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();

    unregisterUpper();
    expect(dismissTopModalShell()).toBe(false);
  });
});
