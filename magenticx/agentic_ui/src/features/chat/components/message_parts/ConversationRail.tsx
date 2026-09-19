import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";
import type { MessageOut } from "@/shared/lib/types";
import { useConversationRail } from "@/features/chat/hooks/useConversationRail";
import {
  CARD_CLEARANCE_PX,
  groupIntoRailEntries,
  magnification,
  magnifyScale,
} from "@/features/chat/lib/conversationRail";

type ConversationRailProps = {
  messages: MessageOut[];
  viewportRef: React.RefObject<HTMLDivElement | null>;
  columnRef: React.RefObject<HTMLDivElement | null>;
};

// Turns below which the rail is not worth drawing. A two-turn thread is fully
// visible by scrolling; the rail only earns its place once the thread is long
// enough that finding a point in it is a task.
const MIN_ENTRIES = 3;

/**
 * Right-edge conversation scroll-rail (thread minimap).
 *
 * One tick per **turn** — the prompts sent together plus the replies to them —
 * with the in-view turn highlighted. Bringing the cursor near the rail
 * magnifies the ticks around it, dock-style; hovering one previews that
 * exchange in a card to its left; clicking jumps to the top of the turn.
 *
 * The rail fades out whenever the right gutter shrinks enough that it would
 * crowd the right-aligned message column, so it never overlaps a message.
 */
export function ConversationRail({ messages, viewportRef, columnRef }: ConversationRailProps) {
  const entries = groupIntoRailEntries(messages);
  const messageIds = messages.map((message) => message.id);
  const { activeId, hidden, scrollToMessage } = useConversationRail({
    viewportRef,
    columnRef,
    messageIds,
  });
  const reduceMotion = useReducedMotion();

  // Which tick the pointer is nearest. Drives the preview card only — the
  // magnification deliberately does NOT go through state (see below).
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // The magnification is written straight to the DOM inside a rAF rather than
  // held in React state. A pointermove fires far more often than a frame, and
  // re-rendering every tick on each one would make a long thread stutter —
  // exactly the threads the rail exists for. State changes only when the
  // *nearest tick* changes, which is once per 8px of travel.
  const tickRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const frameRef = useRef<number | null>(null);
  const pointerYRef = useRef<number | null>(null);

  const paint = useCallback(() => {
    frameRef.current = null;
    const pointerY = pointerYRef.current;
    for (const tick of tickRefs.current) {
      if (!tick) continue;
      if (pointerY === null) {
        // Hand the tick back to its class-driven resting state.
        tick.style.transform = "";
        tick.style.opacity = "";
        continue;
      }
      const box = tick.getBoundingClientRect();
      const distance = pointerY - (box.top + box.height / 2);
      tick.style.transform = `scaleX(${magnifyScale(distance)})`;
      // Near ticks brighten with the same curve, so the bulge reads as one
      // gesture rather than as width alone.
      tick.style.opacity = String(0.7 + 0.3 * magnification(distance));
    }
  }, []);

  const schedulePaint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (reduceMotion) return;
      pointerYRef.current = event.clientY;
      schedulePaint();
    },
    [reduceMotion, schedulePaint],
  );

  const handlePointerLeave = useCallback(() => {
    setHoveredIndex(null);
    pointerYRef.current = null;
    schedulePaint();
  }, [schedulePaint]);

  // A pending frame after unmount would write to detached nodes.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  if (entries.length < MIN_ENTRIES) return null;

  // Scroll-spy reports a *message*; the active tick is the turn holding it.
  const activeIndex = entries.findIndex(
    (entry) => activeId !== null && entry.messageIds.includes(activeId),
  );
  const preview = hoveredIndex === null ? null : entries[hoveredIndex];

  return (
    <nav
      aria-label="Conversation turns"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={cn(
        "pointer-events-none absolute right-4 top-1/2 z-20 flex max-h-[60vh] -translate-y-1/2",
        "flex-col items-end justify-center overflow-visible",
        "transition-opacity duration-300 ease-out motion-reduce:transition-none",
        hidden ? "opacity-0" : "opacity-100",
      )}
    >
      {entries.map((entry, index) => {
        const isActive = index === activeIndex;
        // An unanswered turn is an interrupted one. Its tick stays short so the
        // rail shows, at a glance, where a prompt went without a reply.
        const width = entry.answered ? "w-5" : "w-2.5";

        return (
          <button
            key={entry.anchorId}
            type="button"
            aria-label={`Jump to turn ${index + 1} of ${entries.length}`}
            aria-current={isActive ? "true" : undefined}
            onClick={() => scrollToMessage(entry.anchorId)}
            onPointerEnter={() => setHoveredIndex(index)}
            onFocus={() => setHoveredIndex(index)}
            onBlur={() => setHoveredIndex(null)}
            disabled={hidden}
            className={cn(
              // Wider than the tick it holds, right-aligned: the extra width is
              // the approach zone, so the bulge starts before the cursor is
              // literally on a 2px bar. It stays under the 44px gutter the rail
              // reserves, so it never blocks a click on a message.
              "group pointer-events-auto flex h-2 w-10 items-center justify-end focus-visible:outline-none",
              hidden && "pointer-events-none",
            )}
          >
            <span
              ref={(node) => {
                tickRefs.current[index] = node;
              }}
              className={cn(
                "block h-[2px] origin-right rounded-full",
                // Short on purpose: the inline transform is rewritten every
                // frame, so a long transition would lag the cursor. 100ms only
                // smooths the step between frames and the return to rest.
                "transition-[background-color,opacity,transform] duration-100 ease-out",
                "motion-reduce:transition-none",
                width,
                // The active turn keeps its brighter, wider resting state, so
                // the rail still says where you are when the cursor is away.
                isActive
                  ? "scale-x-[1.35] bg-foreground opacity-100"
                  : "bg-muted-foreground/40 opacity-70",
                "group-focus-visible:scale-x-[1.35] group-focus-visible:bg-foreground group-focus-visible:opacity-100",
              )}
            />
          </button>
        );
      })}

      {preview ? (
        <div
          // Opens leftward: the rail is pinned to the viewport's right edge, so
          // a card on its right would be off-screen. `pointer-events-none`
          // keeps it from stealing the pointer as it tracks down the rail —
          // without it, the card sliding under the cursor would fire
          // `pointerleave` on the tick and flicker the preview away.
          className={cn(
            "pointer-events-none absolute w-56 space-y-1 rounded-xl border border-border/60",
            "bg-popover/95 px-3 py-3 shadow-lg backdrop-blur-sm",
          )}
          style={{
            // Derived from the magnification so the two can never overlap.
            right: CARD_CLEARANCE_PX,
            // Anchored to the hovered tick rather than centred on the rail, so
            // the card reads as belonging to that turn. Percentages keep it
            // correct at any entry count without measuring the DOM.
            top: `${((hoveredIndex! + 0.5) / entries.length) * 100}%`,
            transform: "translateY(-50%)",
          }}
          role="tooltip"
        >
          {preview.prompts.map((line, lineIndex) => (
            <p
              key={`prompt-${lineIndex}`}
              className="truncate text-xs font-medium text-foreground"
            >
              {line}
            </p>
          ))}
          {preview.replies.map((line, lineIndex) => (
            <p key={`reply-${lineIndex}`} className="truncate text-xs text-muted-foreground">
              {line}
            </p>
          ))}
          {preview.prompts.length === 0 && preview.replies.length === 0 ? (
            <p className="truncate text-xs italic text-muted-foreground">No text in this turn</p>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
