import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The "new chat" mark: a rounded square left open at its top-right corner, with
 * a pencil writing into it.
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
      {/* The page: generous corners, open where the pencil comes in. */}
      <path d="M11.5 4H7.5A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5v-4" />
      {/* The pencil: a slim body with a rounded cap at the top-right and a short
          pointed tip at the bottom-left — kept narrow so it still reads at 20px. */}
      <path d="M17.4 4.6a1.5 1.5 0 0 1 2.1 2.1L12.2 14l-2.75.65.65-2.75z" />
    </svg>
  );
}
