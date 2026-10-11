import { forwardRef } from "react";

import type { DraftCommand } from "@/features/chat/lib/slashCommands";
import { cn } from "@/shared/lib/utils";

/**
 * The composer draft with its slash command highlighted in place (plan 35).
 *
 * Custom because a `<textarea>` cannot style part of its own text, and the
 * alternative — a contentEditable editor — would replace the composer's input
 * handling wholesale (paste, dictation, IME, undo). So this is the standard
 * mirror: the same text, in the same box with the same font, padding and
 * wrapping, laid *under* the textarea, whose own text turns transparent while a
 * command is present (the caret and selection stay the textarea's). The parent
 * keeps the two scrolled together and passes the textarea's scrollbar width so
 * both wrap at the same column.
 */
export const DraftHighlight = forwardRef<
  HTMLDivElement,
  { text: string; found: DraftCommand; className?: string; scrollbarWidth: number }
>(function DraftHighlight({ text, found, className, scrollbarWidth }, ref) {
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words", className)}
      style={{ paddingRight: `calc(1rem + ${scrollbarWidth}px)` }}
    >
      {text.slice(0, found.start)}
      {/* Highlighted without padding or margin — anything that takes space
          would push the mirror out of line with the textarea above it. */}
      <mark className="rounded-[0.3rem] bg-primary/20 text-primary shadow-[0_0_0_2px_hsl(var(--primary)/0.2)]">
        {text.slice(found.start, found.end)}
      </mark>
      {text.slice(found.end)}
      {/* A trailing newline needs a character after it to take up its line. */}
      {"​"}
    </div>
  );
});
