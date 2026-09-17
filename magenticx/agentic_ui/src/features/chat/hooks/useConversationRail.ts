import { useCallback, useEffect, useState } from "react";

// Minimum right-side gutter (px) between the centered message column and the
// viewport edge before the rail would crowd/overlap the (right-aligned) user
// bubbles. Below this the rail hides entirely rather than ever overlapping.
const OVERLAP_RESERVE_PX = 44;

type ConversationRailOptions = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  columnRef: React.RefObject<HTMLDivElement | null>;
  messageIds: string[];
};

type ConversationRailState = {
  activeId: string | null;
  hidden: boolean;
  scrollToMessage: (id: string) => void;
};

// Drives the conversation scroll-rail: tracks which message is in view
// (scroll-spy), hides the rail when the right gutter is too small to clear the
// message column, and exposes a click-to-jump scroller. DOM is read through the
// scroll viewport so it stays correct inside the nested ScrollArea.
export function useConversationRail({
  viewportRef,
  columnRef,
  messageIds,
}: ConversationRailOptions): ConversationRailState {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  // Re-bind the observers whenever the active-branch list changes identity
  // (branch switch, streamed append) so new/removed message nodes are tracked.
  const idsKey = messageIds.join("|");

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || messageIds.length === 0) return;

    // id -> top offset relative to the viewport, for every message currently
    // crossing the top band; the topmost one is the "active" message.
    const visibleTops = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        const viewportTop = viewport.getBoundingClientRect().top;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleTops.set(id, entry.boundingClientRect.top - viewportTop);
          } else {
            visibleTops.delete(id);
          }
        }
        let nextActive: string | null = null;
        let smallestTop = Infinity;
        for (const [id, top] of visibleTops) {
          if (top < smallestTop) {
            smallestTop = top;
            nextActive = id;
          }
        }
        if (nextActive) setActiveId(nextActive);
      },
      // Thin band near the top of the viewport so exactly the message the user
      // is reading registers as active.
      { root: viewport, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    const nodes = viewport.querySelectorAll<HTMLElement>("[data-message-id]");
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [viewportRef, idsKey, messageIds.length]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const column = columnRef.current;
    if (!viewport || !column) return;

    const measure = () => {
      const gutter = viewport.getBoundingClientRect().right - column.getBoundingClientRect().right;
      setHidden(gutter < OVERLAP_RESERVE_PX);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(column);
    return () => observer.disconnect();
  }, [viewportRef, columnRef]);

  const scrollToMessage = useCallback(
    (id: string) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const target = viewport.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!target) return;
      const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTo({
        top: viewport.scrollTop + delta - 12,
        behavior: prefersReduced ? "auto" : "smooth",
      });
      setActiveId(id);
    },
    [viewportRef],
  );

  return { activeId, hidden, scrollToMessage };
}
