// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTouchMenuTrigger } from "@/features/chat/hooks/useTouchMenuTrigger";

/**
 * A finger opens the sidebar's menus on the tap's click, not on pointerdown:
 * a menu opened on pointerdown switches pointer events off before the tap's
 * click arrives, and that click fell through the mobile sidebar onto the
 * composer. A mouse and the keyboard keep Radix's own handling.
 */
// The event types come from the hook itself: `react` does not resolve from
// this folder (see the `paths` note in tsconfig.app.json).
type TriggerHandlers = ReturnType<ReturnType<typeof useTouchMenuTrigger>>;
type DownEvent = Parameters<TriggerHandlers["onPointerDown"]>[0];
type ClickEvent = Parameters<TriggerHandlers["onClick"]>[0];

const pointerDown = (pointerType: string) => {
  const preventDefault = vi.fn();
  return { event: { pointerType, preventDefault } as unknown as DownEvent, preventDefault };
};
const click = (detail = 1) => ({ detail }) as unknown as ClickEvent;

describe("useTouchMenuTrigger", () => {
  it("opens on the click of a tap and keeps Radix off the pointerdown", () => {
    const { result } = renderHook(() => useTouchMenuTrigger());
    const toggle = vi.fn();
    const handlers = result.current(toggle);
    const down = pointerDown("touch");

    handlers.onPointerDown(down.event);
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();

    handlers.onClick(click());
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("leaves a mouse to Radix", () => {
    const { result } = renderHook(() => useTouchMenuTrigger());
    const toggle = vi.fn();
    const handlers = result.current(toggle);
    const down = pointerDown("mouse");

    handlers.onPointerDown(down.event);
    handlers.onClick(click());
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("ignores a keyboard click after a tap, which Radix already opened on keydown", () => {
    const { result } = renderHook(() => useTouchMenuTrigger());
    const toggle = vi.fn();
    const handlers = result.current(toggle);

    handlers.onPointerDown(pointerDown("touch").event);
    handlers.onClick(click(0));
    expect(toggle).not.toHaveBeenCalled();
    // …and the tap does not linger to toggle a later keyboard click either.
    handlers.onClick(click());
    expect(toggle).not.toHaveBeenCalled();
  });
});
