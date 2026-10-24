import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The plan's mark: steps on a rail, the first one done (filled) and the rest
 * ahead — the agent's plan as it works through it. Strokes in `currentColor`
 * on the 24-unit grid with stroke width 2 and round caps, like the lucide
 * icons beside it, and pairs with the agent map's mark in the composer.
 */
export function PlanIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      {/* The rail: a done step, then two ahead. */}
      <circle cx="5" cy="5" r="2" fill="currentColor" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="5" cy="19" r="2" />
      <path d="M5 7v3" />
      <path d="M5 14v3" />
      {/* Each step's line of text. */}
      <path d="M10 5h10" />
      <path d="M10 12h10" />
      <path d="M10 19h7" />
    </svg>
  );
}
