import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/** How long the colours take to cross over (matches `.private-shift` in styles/private.css). */
export const INCOGNITO_SHIFT_MS = 700;

/**
 * The classes that turn the chat card into its incognito surface while the
 * chat is private (styles/private.css).
 *
 * `private-scope` re-declares every theme token on the card with one fixed,
 * always-dark violet palette, so everything inside re-themes on its own and
 * looks the same whatever theme (or future palette) is active; `dark` makes
 * Tailwind's `dark:` variants apply inside it. The sidebar keeps the theme, and
 * the contrast is part of the signal.
 *
 * Entering or leaving adds `private-shift` for a moment, which transitions
 * every colour inside the card, so the swap is a crossfade instead of a cut.
 * It is added in the same render as the scope change (not in an effect), so
 * both land in one style recalculation and the transitions fire from the old
 * colours. Skipped under reduced motion.
 */
export function useIncognitoCard(active: boolean): string {
  const reduceMotion = useReducedMotion() ?? false;
  const [shown, setShown] = useState(active);
  const [shifting, setShifting] = useState(false);

  if (shown !== active) {
    setShown(active);
    setShifting(!reduceMotion);
  }

  useEffect(() => {
    if (!shifting) return;
    const timer = window.setTimeout(() => setShifting(false), INCOGNITO_SHIFT_MS);
    return () => window.clearTimeout(timer);
  }, [shifting, shown]);

  return [active ? "dark private-scope" : "", shifting ? "private-shift" : ""]
    .filter(Boolean)
    .join(" ");
}
