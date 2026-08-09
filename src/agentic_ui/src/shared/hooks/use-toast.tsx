import type { ReactNode } from "react";
import { toast as sonnerToast } from "sonner";

import { ToastCard, type ToastAction, type ToastVariant } from "@/shared/ui/toast-card";

/**
 * Toast API — a thin, drop-in layer over Sonner.
 *
 * The public surface (`useToast().toast` and the standalone `toast`) keeps the
 * historical `{ title, description, variant, duration }` shape so no callsite
 * had to change when we retired the old Radix toast. Under the hood every toast
 * renders as a branded {@link ToastCard} via `toast.custom`, so Sonner drives
 * stacking / fold / swipe / hover-pause while we own the look and the countdown
 * bar. See shared/ui/sonner (the portal) and shared/ui/toast-card (the surface).
 */
export interface ToastOptions {
    title?: ReactNode;
    description?: ReactNode;
    /**
     * Status variant. Accepts the app's variants plus the legacy `"error"`
     * alias (mapped to `destructive`); anything unrecognised degrades to
     * `default`. Typed as `string` on purpose — the many structurally-typed
     * `toast` call slots across features pass a plain `string`, so widening here
     * keeps them all assignable without a churn of casts.
     */
    variant?: string;
    /** Auto-dismiss window in ms. Omit to use the per-variant default. */
    duration?: number;
    action?: ToastAction;
}

const KNOWN_VARIANTS: readonly ToastVariant[] = [
    "default",
    "info",
    "success",
    "warning",
    "destructive",
    "loading",
];

/** Errors linger a little longer than confirmations; loading never expires on
 *  its own (the caller dismisses/updates it). */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
    default: 4000,
    info: 4000,
    success: 4000,
    warning: 5000,
    destructive: 6000,
    loading: Infinity,
};

function resolveVariant(variant?: string): ToastVariant {
    if (variant === "error") return "destructive";
    if (variant && (KNOWN_VARIANTS as readonly string[]).includes(variant)) {
        return variant as ToastVariant;
    }
    return "default";
}

/**
 * Show a toast. Returns the Sonner id and a bound `dismiss` so callers can close
 * it early (e.g. resolving a loading toast).
 */
function toast(options: ToastOptions) {
    const variant = resolveVariant(options.variant);
    const duration = options.duration ?? DEFAULT_DURATION[variant];

    const id = sonnerToast.custom(
        (toastId) => (
            <ToastCard
                id={toastId}
                variant={variant}
                title={options.title}
                description={options.description}
                duration={duration}
                action={options.action}
            />
        ),
        { duration },
    );

    return { id, dismiss: () => sonnerToast.dismiss(id) };
}

/** Dismiss a single toast by id, or all toasts when called with no id. */
function dismiss(id?: string | number) {
    sonnerToast.dismiss(id);
}

/**
 * Hook form kept for API compatibility with the previous Radix implementation.
 * Sonner holds the toast state internally, so there is nothing to subscribe to
 * here — the returned handles are stable module-level functions.
 */
export function useToast() {
    return { toast, dismiss };
}

export { toast };
