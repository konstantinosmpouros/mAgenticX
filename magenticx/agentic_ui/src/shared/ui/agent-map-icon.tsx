import type { SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * The agent map's mark: one node handing off to two — the main agent
 * delegating to its sub-agents, read as a small flow graph. Strokes in
 * `currentColor` on the 24-unit grid with stroke width 2 and round caps, like
 * the lucide icons beside it in the composer.
 */
export function AgentMapIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      {/* The main agent, on the left. */}
      <rect x="2" y="9" width="6" height="6" rx="1.5" />
      {/* The two sub-agents it hands off to. */}
      <rect x="16" y="3" width="6" height="6" rx="1.5" />
      <rect x="16" y="15" width="6" height="6" rx="1.5" />
      {/* The hand-off: out of the main agent, splitting to both. */}
      <path d="M8 12h5" />
      <path d="M16 6h-1a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1" />
    </svg>
  );
}
