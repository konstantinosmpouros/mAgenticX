import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The private-chat mark: the "incognito" hat and glasses. Drawn here because
 * the icon set in use has no such glyph; same 24-unit grid, stroke width 2 and
 * round caps as the lucide icons beside it, stroked in `currentColor`.
 */
export function IncognitoIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      {/* The hat: a crown with a dented top, on a wide brim. */}
      <path d="m5 11 1.6-5.6A2 2 0 0 1 8.5 4h1.1a2 2 0 0 1 1.2.4l.4.3a1.4 1.4 0 0 0 1.6 0l.4-.3a2 2 0 0 1 1.2-.4h1.1a2 2 0 0 1 1.9 1.4L19 11" />
      <path d="M2 11h20" />
      {/* The glasses. */}
      <circle cx="7" cy="17" r="3" />
      <circle cx="17" cy="17" r="3" />
      <path d="M10 17a2 2 0 0 1 4 0" />
    </svg>
  );
}
