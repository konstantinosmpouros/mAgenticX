import { cn } from "@/shared/lib/utils";
import type { WorkflowStatusMeta } from "@/features/workflows/lib/status";

/** A status's icon alone, coloured; it turns while running (motion allowed). */
export function StatusIcon({ meta, className }: { meta: WorkflowStatusMeta; className?: string }) {
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 flex-shrink-0",
        meta.text,
        meta.spin && "motion-safe:animate-spin",
        className,
      )}
    />
  );
}

/**
 * A status pill — icon and label, never colour alone — as the chat's
 * sub-agent chips. `iconOnly` keeps the label for screen readers only.
 */
export function StatusChip({
  meta,
  iconOnly = false,
  className,
}: {
  meta: WorkflowStatusMeta;
  iconOnly?: boolean;
  className?: string;
}) {
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium",
        meta.chip,
        className,
      )}
      title={iconOnly ? meta.label : undefined}
    >
      <Icon aria-hidden className={cn("h-3 w-3", meta.spin && "motion-safe:animate-spin")} />
      <span className={iconOnly ? "sr-only" : undefined}>{meta.label}</span>
    </span>
  );
}
