import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";

/**
 * Full-screen blocker shown while the active account is being swapped.
 *
 * This is load-bearing, not decoration. Rendering it lets the shell unmount the
 * whole workspace tree, so nothing is left alive to receive a late response from
 * the account being left — which is the failure mode that would otherwise paint
 * one account's conversations under another's identity. It is deliberately
 * impossible to dismiss or interact around: until the new session is bootstrapped
 * there is no consistent state to interact with.
 */
type SwitchingAccountsProps = {
  /** Shown under the title once known, e.g. the account being entered. */
  detail?: string;
  /** Set when the switch failed, so the screen stops implying progress. */
  error?: string | null;
  onRetry?: () => void;
};

export default function SwitchingAccounts({ detail, error, onRetry }: SwitchingAccountsProps) {
  const reduceMotion = useReducedMotion();
  // The shimmer only starts after a beat: a switch that completes quickly should
  // read as an instant transition, not a flash of loading chrome.
  const [showShimmer, setShowShimmer] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShowShimmer(true), 180);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <motion.div
      // aria-live so a screen reader announces the transition; role=status keeps
      // it polite rather than interrupting.
      role="status"
      aria-live="polite"
      aria-busy={!error}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-2 bg-background px-6 text-center"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {error ? (
        <>
          <p className="text-lg font-semibold text-foreground">Could not switch accounts</p>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-xl border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Go to sign in
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p
            className={cn(
              "text-lg font-semibold text-foreground",
              showShimmer && !reduceMotion && "shimmer-text animate-shimmer-text",
            )}
          >
            Switching accounts
          </p>
          <p className="text-sm text-muted-foreground">{detail || "Please wait"}</p>
        </>
      )}
    </motion.div>
  );
}
