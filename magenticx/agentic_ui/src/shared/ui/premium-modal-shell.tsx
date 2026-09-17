import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * PremiumModalShell — the shared "premium dark card" modal chrome used by the
 * Share and Report dialogs, extracted so the Profile/Settings surfaces wear the
 * exact same look.
 *
 * It is deliberately ALWAYS dark: the chrome uses fixed white-on-`#151515` values
 * rather than theme tokens, and the root carries the `dark` class so any
 * token-based content rendered inside resolves to its dark palette and sits
 * correctly on the dark card regardless of the app's active light/dark theme.
 * This is the single place those fixed values live (the previous Share/Report
 * dialogs can later be re-pointed here to de-duplicate the chrome).
 */
type PremiumModalShellProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible label for the built-in close button. */
  closeLabel?: string;
  /** Width/positioning utility classes for the card wrapper (e.g. "max-w-5xl"). */
  className?: string;
  /** Hide the built-in close button when the caller renders its own. */
  showClose?: boolean;
  children: React.ReactNode;
};

export function PremiumModalShell({
  open,
  onClose,
  closeLabel = "Close",
  className,
  showClose = true,
  children,
}: PremiumModalShellProps) {
  if (!open) return null;

  return (
    <div className="dark fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 z-0 bg-black/80 backdrop-blur-md animate-in fade-in-0 duration-200"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative z-10 w-full animate-in fade-in-0 zoom-in-95 duration-200 ease-out",
          className,
        )}
      >
        <div className="relative overflow-hidden rounded-[1.6rem] border border-white/[0.14] bg-[#151515] text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/20" />
          {showClose ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={closeLabel}
              onClick={onClose}
              className="absolute right-5 top-5 z-20 h-9 w-9 rounded-full text-white/65 shadow-sm transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-0 focus-visible:outline-none"
            >
              <X size={18} />
            </Button>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
