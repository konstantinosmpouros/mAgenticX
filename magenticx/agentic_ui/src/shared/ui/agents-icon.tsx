import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The Agents section's mark: an agent's face with a spark beside it — the
 * agents you build. Strokes in `currentColor` on the 24-unit grid with stroke
 * width 2 and round caps, like the lucide icons beside it in the sidebar.
 */
export function AgentsIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      {/* The agent's face and its eyes. */}
      <rect x="3" y="7" width="14" height="14" rx="4" />
      <path d="M7.5 13v1.5" />
      <path d="M12.5 13v1.5" />
      {/* The spark: what makes it yours. */}
      <path d="M19 2l.9 2.1L22 5l-2.1.9L19 8l-.9-2.1L16 5l2.1-.9z" />
    </svg>
  );
}
