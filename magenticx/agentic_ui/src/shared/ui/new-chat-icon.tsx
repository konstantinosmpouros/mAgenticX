import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The "new chat" mark: a softly rounded square left open at its top-right
 * corner, with a pencil writing into it — the same drawing as the thesis app's.
 *
 * Drawn as an outline SVG rather than the old `edit.png` / `edit2.png` pair,
 * which were rendered artwork with a baked-in glow and background: they needed
 * one file per theme, looked soft when shrunk, and their hairline strokes sat
 * oddly next to the outline icons around them. This one strokes in
 * `currentColor`, so it follows the theme on its own and takes any text colour
 * class, and it shares the 24-unit grid, stroke width 2 and round caps of the
 * neighbouring Search / Share / Voice icons.
 */
export function NewChatIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("h-5 w-5 shrink-0", className)}
      {...props}
    >
      {/* The page: a softly rounded square filling the grid, open where the
          pencil comes in (the thesis app's mark — it reads fuller at 20px). */}
      <path d="M11.25 3.75h-3a4.5 4.5 0 0 0-4.5 4.5v7.5a4.5 4.5 0 0 0 4.5 4.5h7.5a4.5 4.5 0 0 0 4.5-4.5v-3" />
      {/* The pencil: rounded cap at the top-right, pointed tip at the bottom-left. */}
      <path d="M17.7 4.3a2.12 2.12 0 0 1 3 3l-7.2 7.2-3.85 1.05 1.05-3.85z" />
    </svg>
  );
}
