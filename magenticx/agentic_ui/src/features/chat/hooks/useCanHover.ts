import { useEffect, useState } from "react";

const QUERY = "(hover: hover)";

/**
 * Whether the primary pointer can hover (a mouse or trackpad, not a finger).
 *
 * Hover-only affordances need a touch fallback: the composer's context ring
 * opens its card on hover and compacts on click, so on a touch screen a tap
 * must open the card instead of firing the action blind. Assumes hover where
 * `matchMedia` is unavailable (tests, very old browsers).
 */
export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(
    () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(QUERY);
    const update = () => setCanHover(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return canHover;
}
