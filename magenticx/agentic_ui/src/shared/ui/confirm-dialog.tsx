import { type ReactNode, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/utils";

/**
 * One confirmation dialog for destructive actions.
 *
 * Every destructive surface in the app had rolled its own — most commonly an
 * inline "click delete twice" built from a local id in component state, which
 * is easy to trigger by accident and looks different everywhere it appears.
 *
 * Built on the existing `dialog` primitive rather than pulling in
 * `@radix-ui/react-alert-dialog`: the behaviour needed here (modal, focus trap,
 * escape to dismiss) is already there, and adding a dependency to restate it
 * would be cost without benefit.
 *
 * The action runs inside the dialog so the button can own its own pending
 * state — the caller does not have to thread `busy` through from above, and the
 * dialog stays open (and disabled) until the work settles.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Resolves when the action is done; the dialog closes on success only. */
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      // Always clear: if the action threw, the caller surfaces the error and
      // the dialog stays open so the user can retry rather than losing context.
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md rounded-[1.4rem]">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {destructive ? (
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <AlertTriangle size={17} aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0 space-y-1.5 text-left">
              <DialogTitle className="text-base">{title}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded-xl border border-border/60 bg-background/60 px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/60"
                : "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/60",
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
