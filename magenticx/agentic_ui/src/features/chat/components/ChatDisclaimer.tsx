import { cn } from "@/shared/lib/utils";

// At the foot of every chat screen. One constant, so the wording is changed in
// one place.
export const CHAT_DISCLAIMER = "mAgenticX is an AI and can make mistakes. Check important answers.";

/**
 * The disclaimer, pinned to the bottom edge of the chat card: the last row of
 * its column, under the composer (or the voice bar, or an approval). Outside
 * the messages' scroll area and the composer's lift, so it never scrolls, never
 * rises with the empty screen's composer, and never covers the messages, the
 * suggestions or the "/" menu. Plain text, not a tooltip; clears the home
 * indicator on phones, where the card is full-bleed.
 */
export function ChatDisclaimer({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "mx-auto w-full max-w-3xl shrink-0 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {CHAT_DISCLAIMER}
    </p>
  );
}
