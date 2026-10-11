import { useLayoutEffect, useState, type RefObject } from "react";

/** The page header that an upward-opening panel must stay below. */
const HEADER_SELECTOR = "[data-chat-header]";

/**
 * How tall a panel that opens upwards may be without reaching the chat header.
 *
 * Measured every frame while the panel is mounted (it lives only while the menu
 * is open): the composer *moves* — the browser is resized, it slides between
 * mid-screen and the bottom, the sidebar opens — often animated and without
 * changing size, so neither a resize event nor a ResizeObserver catches the
 * moment it settles. Two rect reads a frame, only while open.
 *
 * The panel (`panelRef`) is positioned against its parent — the composer — so
 * the room is from the header's bottom edge to the parent's top edge, minus
 * `gapPx` on each side; `fallbackPx` until it can be measured. The first
 * measure runs before paint, so the menu never opens too tall.
 *
 * The panel keeps its own z-order; this only bounds its height, so it never
 * covers the header in the first place.
 */
export function useSpaceAbove(panelRef: RefObject<HTMLElement>, { gapPx, fallbackPx }: { gapPx: number; fallbackPx: number }) {
  const [space, setSpace] = useState(fallbackPx);

  useLayoutEffect(() => {
    let frame = 0;
    let last = Number.NaN;
    const measure = () => {
      const anchor = panelRef.current?.parentElement;
      if (anchor) {
        const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        const room = Math.max(0, Math.floor(anchor.getBoundingClientRect().top - headerBottom - 2 * gapPx));
        // State only when the room changed, so a still page re-renders nothing.
        if (room !== last) {
          last = room;
          setSpace(room);
        }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [panelRef, gapPx]);

  return space;
}
