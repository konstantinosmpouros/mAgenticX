import type * as React from "react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowExecutionStatus } from "@/shared/lib/types";
import { kindMeta } from "@/features/workflows/lib/kinds";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { PALETTE_TILE } from "@/features/workflows/lib/builder/consts";

const SIZES = {
  sm: { box: "h-7 w-7 rounded-lg", glyph: "h-3.5 w-3.5" },
  md: { box: "h-9 w-9 rounded-[0.7rem]", glyph: "h-[1.05rem] w-[1.05rem]" },
} as const;

/**
 * A step kind's icon tile in its accent (the palette's and the canvas's
 * look), for the run view's timeline and details header. `children` sit over
 * its corner (a status badge).
 */
export function KindTile({
  kind,
  size = "sm",
  className,
  children,
}: {
  kind: string;
  size?: keyof typeof SIZES;
  className?: string;
  children?: React.ReactNode;
}) {
  const meta = kindMeta(kind);
  const Glyph = meta.icon;
  const sizes = SIZES[size];
  return (
    <span
      aria-hidden
      className={cn(PALETTE_TILE, "relative", sizes.box, className)}
      style={{ "--wf-accent": meta.accent } as React.CSSProperties}
    >
      <Glyph className={sizes.glyph} />
      {children}
    </span>
  );
}

/** A step's kind tile with its status as a badge on the corner (icon and colour). */
export function StepTile({ kind, status }: { kind: string; status: WorkflowExecutionStatus }) {
  const meta = EXECUTION_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <KindTile kind={kind}>
      <span
        className={cn(
          "absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-background",
          meta.dot,
        )}
      >
        <Icon
          aria-hidden
          strokeWidth={3}
          className={cn("h-2 w-2 text-background", meta.spin && "motion-safe:animate-spin")}
        />
      </span>
    </KindTile>
  );
}
