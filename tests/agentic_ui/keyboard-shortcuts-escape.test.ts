// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useKeyboardShortcuts } from "@/features/chat/hooks/useKeyboardShortcuts";

/**
 * Escape reaches the open surface first. The global "dismiss active UI"
 * shortcut used to take every Escape in the window's capture phase and stop
 * it there, so no dialog, menu or panel could close itself. Now it runs last
 * and only when nothing handled the key; the other shortcuts are still taken
 * first.
 */

const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
};

const listeners: Array<[string, EventListener, boolean]> = [];
const listen = (handler: (event: KeyboardEvent) => void, capture: boolean) => {
  const listener = handler as EventListener;
  document.addEventListener("keydown", listener, { capture });
  listeners.push(["keydown", listener, capture]);
};

afterEach(() => {
  for (const [type, listener, capture] of listeners.splice(0)) {
    document.removeEventListener(type, listener, { capture });
  }
});

describe("Escape", () => {
  it("reaches an open dialog, which closes itself, and the workspace does nothing", () => {
    const dismiss = vi.fn();
    const dialogCloses = vi.fn();
    // Radix's escape listener: document, capture phase, marks the key handled.
    listen((event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dialogCloses();
    }, true);
    renderHook(() => useKeyboardShortcuts({ actions: { "ui.escape": dismiss }, context: { canTogglePrivateMode: false } }));
    press("Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("falls back to the workspace's dismissal when nothing else handled it", () => {
    const dismiss = vi.fn();
    const seenByPage = vi.fn();
    listen(() => seenByPage(), false);
    renderHook(() => useKeyboardShortcuts({ actions: { "ui.escape": dismiss }, context: { canTogglePrivateMode: false } }));
    press("Escape");
    expect(seenByPage).toHaveBeenCalledTimes(1); // never stopped on the way
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves the other shortcuts first in line", () => {
    const newChat = vi.fn();
    const seenByPage = vi.fn();
    listen(() => seenByPage(), true);
    renderHook(() => useKeyboardShortcuts({ actions: { "chat.new": newChat }, context: { canTogglePrivateMode: false } }));
    press("n", { code: "KeyN", altKey: true }); // Alt/Option+N on both platforms
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(seenByPage).not.toHaveBeenCalled();
  });
});
