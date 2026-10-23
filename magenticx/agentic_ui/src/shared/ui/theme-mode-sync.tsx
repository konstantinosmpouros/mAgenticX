import { useEffect } from "react";
import { useTheme } from "next-themes";

import { themeFor } from "@/styles/theme/themes";

/**
 * Keeps <html>'s `dark` class and `color-scheme` in step with the active theme.
 * next-themes sets `data-theme` (which picks the colors); dark themes also need
 * the `dark` class, which Tailwind's `dark:` variant relies on.
 */
export function ThemeModeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const mode = themeFor(resolvedTheme).mode;
    const root = document.documentElement;
    root.classList.toggle("dark", mode === "dark");
    root.style.colorScheme = mode;
  }, [resolvedTheme]);

  return null;
}
