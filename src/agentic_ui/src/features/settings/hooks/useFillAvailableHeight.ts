import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Size an element to exactly the space left below it inside its scroll container.
 *
 * Needed because a CSS-only answer is not available here. `h-full` cannot work:
 * a percentage height needs a *definite* parent height, and the settings panel
 * renders its tab content in a `motion.div` that is only padded, so the chain
 * from the scroll viewport down to a tab has no resolvable height. `position:
 * sticky` cannot work either — that same `motion.div` animates `y`, and a
 * transformed ancestor becomes the containing block, so a sticky footer never
 * engages. A hardcoded `vh` value is the third dead end: it is right on one
 * screen and wrong on every other.
 *
 * So measure. The element takes the distance from its own top to the bottom of
 * the nearest scroll viewport, which is exactly the room it has, and re-measures
 * whenever either edge can move.
 *
 * @param gap Space to leave beneath the element — the container's bottom padding.
 * @returns A ref to attach, and the height in px (null until first measure).
 */
export function useFillAvailableHeight<T extends HTMLElement>(gap = 24) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Radix marks its scroll viewport; fall back to the window when this is
    // rendered somewhere that does not scroll.
    const viewport = el.closest("[data-radix-scroll-area-viewport]");
    const bottom = viewport
      ? viewport.getBoundingClientRect().bottom
      : document.documentElement.clientHeight;
    const next = Math.round(bottom - el.getBoundingClientRect().top - gap);
    // A floor keeps the editor usable on a short window instead of collapsing
    // to nothing; below this the panel's own scroll takes over.
    setHeight(Math.max(next, 320));
  }, [gap]);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;

    // The element's own top moves when anything above it reflows (the header,
    // a wrapping tab row), and the viewport's bottom moves on window resize.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const viewport = el.closest("[data-radix-scroll-area-viewport]");
    if (viewport) observer.observe(viewport);
    const parent = el.parentElement;
    if (parent) observer.observe(parent);
    window.addEventListener("resize", measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return { ref, height };
}
