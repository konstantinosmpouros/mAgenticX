import * as React from "react";

import { cn } from "@/shared/lib/utils";

type PlanProgressRingProps = {
  completed: number;
  total: number;
  /** Edge length in px. */
  size: number;
  strokeWidth?: number;
  className?: string;
  /** Drawn in the middle (an icon). */
  children?: React.ReactNode;
};

/**
 * How much of a plan is done, as a ring that fills clockwise from the top —
 * the composer's context ring's shape, in the brand colour. Decorative: the
 * button or heading around it says the numbers.
 */
export function PlanProgressRing({
  completed,
  total,
  size,
  strokeWidth = 2.5,
  className,
  children,
}: PlanProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(Math.max(completed / total, 0), 1) : 0;
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex flex-shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="absolute inset-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-primary/15"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          // A round cap on an empty arc would still draw a dot.
          strokeLinecap={fraction > 0 ? "round" : "butt"}
          className="stroke-primary transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      {children}
    </span>
  );
}
