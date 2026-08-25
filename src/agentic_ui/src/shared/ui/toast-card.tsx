import type { ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  Loader2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast as sonnerToast } from "sonner";

import { cn } from "@/shared/lib/utils";

/**
 * ToastCard — the single, branded surface every toast renders through.
 *
 * We drive the whole toast system with Sonner's `toast.custom()` (see
 * shared/hooks/use-toast + shared/ui/sonner) so Sonner owns stacking, the
 * fold-on-hover behaviour, swipe-to-dismiss, hover-pause and the ARIA live
 * region, while this component owns the *look*: a neutral card with a
 * variant-coloured icon chip and a thin countdown bar pinned to the bottom edge
 * that depletes left→right over the toast's lifetime. The look is intentionally
 * "subtle/branded" — only the icon and bar carry the status colour, matching the
 * rest of the app's calm InfoCard/SoftPanel chrome.
 */
export type ToastVariant = "default" | "info" | "success" | "warning" | "destructive" | "loading";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastCardProps {
  /** Sonner's toast id — used by the close button to dismiss this toast. */
  id: string | number;
  variant: ToastVariant;
  title?: ReactNode;
  description?: ReactNode;
  /** Auto-dismiss window in ms; `Infinity` for a persistent toast. Drives the
   *  countdown bar's animation duration so the bar and the timer agree. */
  duration: number;
  action?: ToastAction;
}

/** Per-variant icon + chip/bar colours. Class strings are spelled out in full
 *  (never interpolated) so Tailwind's JIT can see and generate them. */
const VARIANTS: Record<ToastVariant, { Icon: LucideIcon; chip: string; bar: string }> = {
  default: { Icon: Bell, chip: "bg-primary/12 text-primary", bar: "bg-primary" },
  info: { Icon: Info, chip: "bg-info/12 text-info", bar: "bg-info" },
  success: { Icon: CheckCircle2, chip: "bg-success/15 text-success", bar: "bg-success" },
  warning: { Icon: AlertTriangle, chip: "bg-warning/15 text-warning", bar: "bg-warning" },
  destructive: {
    Icon: AlertCircle,
    chip: "bg-destructive/12 text-destructive",
    bar: "bg-destructive",
  },
  loading: { Icon: Loader2, chip: "bg-muted text-muted-foreground", bar: "bg-primary" },
};

export function ToastCard({ id, variant, title, description, duration, action }: ToastCardProps) {
  const { Icon, chip, bar } = VARIANTS[variant];
  const isLoading = variant === "loading";
  // A finite, non-loading toast gets the depleting countdown; loading toasts
  // have no fixed expiry, so they get an indeterminate sliding segment.
  const showCountdown = !isLoading && Number.isFinite(duration);

  return (
    <div className="relative flex w-full items-start gap-3 overflow-hidden rounded-xl border border-border bg-background p-4 pr-10 text-foreground shadow-lg">
      <span className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg", chip)}>
        <Icon className={cn("size-[18px]", isLoading && "animate-spin")} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-semibold leading-5 text-foreground">{title}</p>}
        {description && (
          <p className="mt-0.5 break-words text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        )}
        {action && (
          <button
            type="button"
            onClick={() => {
              action.onClick();
              sonnerToast.dismiss(id);
            }}
            className="mt-2 inline-flex h-8 items-center rounded-lg border border-border bg-transparent px-3 text-xs font-semibold text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
          >
            {action.label}
          </button>
        )}
      </div>

      {/* Close: 28px visual, expanded to a ~44px hit target via the ::after
                overlay so touch targets stay accessible without visual bulk. */}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => sonnerToast.dismiss(id)}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-muted-foreground/70 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        <X className="size-4" aria-hidden />
      </button>

      {showCountdown && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-xl"
        >
          <span
            className={cn("toast-progress-bar block h-full w-full", bar)}
            style={{ animationDuration: `${duration}ms` }}
          />
        </span>
      )}
      {isLoading && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-xl"
        >
          <span className={cn("toast-progress-indeterminate block h-full", bar)} />
        </span>
      )}
    </div>
  );
}
