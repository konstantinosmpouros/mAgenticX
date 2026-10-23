import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import type { Agent } from "@/shared/lib/types";
import type { RefObject } from "react";

// ---------------------------------------------------------------------------
// Ensure that a default agent is selected effect
// ---------------------------------------------------------------------------
export function useEnsureDefaultAgentEffect(params: {
  isLoggedIn: boolean;
  userId: string | null;
  agents: Agent[];
  selectedAgent: string;
  setSelectedAgent: (v: string) => void;
}) {
  const { isLoggedIn, userId, agents, selectedAgent, setSelectedAgent } = params;
  // Apply the default agent exactly once per login session — only on the
  // first arrival of the agents list and only when no selection exists yet.
  // After that the effect never touches selectedAgent, so a restored stale
  // id, an inactive-agent placeholder for an old conversation, or a user who
  // explicitly cleared the selection are all left alone instead of being
  // snapped back to agents[0].
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!isLoggedIn || !userId) {
      // Re-arm on logout so the next login can apply the default again.
      appliedRef.current = false;
      return;
    }
    if (appliedRef.current) return;
    if (agents.length === 0) return;
    appliedRef.current = true;
    if (!selectedAgent) {
      setSelectedAgent(agents[0].id);
    }
  }, [isLoggedIn, userId, agents, selectedAgent, setSelectedAgent]);
}

// ---------------------------------------------------------------------------
// Header divider appearance effect
// ---------------------------------------------------------------------------
export function useHeaderDividerEffect() {
  const [headerHasDivider, setHeaderHasDivider] = useState(false);

  const handleHeaderScrollState = useCallback((scrolled: boolean) => {
    setHeaderHasDivider(scrolled);
  }, []);

  return { headerHasDivider, handleHeaderScrollState };
}

// ---------------------------------------------------------------------------
// Sidebar click interaction effect
// ---------------------------------------------------------------------------
export function useSidebarInteractionEffect(params: {
  isCollapsed: boolean;
  toggleSidebar: () => void;
}) {
  const { isCollapsed, toggleSidebar } = params;
  const [isLogoHovered, setIsLogoHovered] = useState(false);

  useEffect(() => {
    if (!isCollapsed) {
      setIsLogoHovered(false);
    }
  }, [isCollapsed]);

  const handleSidebarMouseEnter = useCallback(() => {
    if (isCollapsed) {
      setIsLogoHovered(true);
    }
  }, [isCollapsed]);

  const handleSidebarMouseLeave = useCallback(() => {
    setIsLogoHovered(false);
  }, []);

  const toggleCollapsedOnBlankArea = useCallback(() => {
    if (isCollapsed) {
      toggleSidebar();
    }
  }, [isCollapsed, toggleSidebar]);

  return {
    isLogoHovered,
    handleSidebarMouseEnter,
    handleSidebarMouseLeave,
    toggleCollapsedOnBlankArea,
  };
}

// ---------------------------------------------------------------------------
// Sticky user action bar effect
// ---------------------------------------------------------------------------
export function useStickyUserBarEffect(params: {
  setStickyUserBarId: (id: string | null) => void;
}) {
  const { setStickyUserBarId } = params;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const flashUserActionBar = useCallback(
    (id: string, ms = 3000) => {
      setStickyUserBarId(id);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setStickyUserBarId(null), ms);
    },
    [setStickyUserBarId],
  );

  return { flashUserActionBar };
}

// ---------------------------------------------------------------------------
// Centered composer layout effect
// ---------------------------------------------------------------------------
type CenteredComposerLayoutArgs = {
  isMessagesEmpty: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  currentMessage: string;
  attachmentsCount: number;
};

const DEFAULT_TEXTAREA_MAX = 280;
const FLOATING_MAX_RATIO = 0.68;
const MIN_TEXTAREA_HEIGHT = 48;
// The empty screen's group (greeting, composer, disclaimer, suggestions) is
// centered with this share of the free height above it (a little above the
// middle) ...
const GROUP_ANCHOR_RATIO = 0.42;
// ... and never closer than this to the top of the area.
const GROUP_MIN_MARGIN = 12;
const MOBILE_TEXTAREA_MAX_RATIO = 0.42;
const DESKTOP_TEXTAREA_MAX_RATIO = 0.5;
const DESKTOP_TEXTAREA_MIN_WIDTH = 768;

export function useCenteredComposerLayout({
  isMessagesEmpty,
  textareaRef,
  currentMessage,
  attachmentsCount,
}: CenteredComposerLayoutArgs) {
  // A callback ref held in state: the composer mounts after this hook does (once
  // the session is known), and the measurement must start when it appears.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [floatingMaxHeight, setFloatingMaxHeight] = useState<number>(DEFAULT_TEXTAREA_MAX);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number>(DEFAULT_TEXTAREA_MAX);
  // How far the composer is lifted from its place at the bottom to sit in the
  // middle of the empty screen; null when there are messages (no lift).
  const [liftY, setLiftY] = useState<number | null>(null);

  const textareaMaxHeight = isMessagesEmpty ? floatingMaxHeight : DEFAULT_TEXTAREA_MAX;
  const effectiveTextareaMax = Math.max(
    Math.min(textareaMaxHeight, viewportMaxHeight),
    MIN_TEXTAREA_HEIGHT,
  );

  // The composer never changes how it is positioned: it always sits at the
  // bottom of the chat area (above the disclaimer, which stays at the very
  // bottom), and the empty screen lifts it with a vertical offset. Moving
  // between a conversation and a new chat is then one animated offset, never a
  // switch of layout (absolute <-> sticky) that cannot be animated.
  //
  // While the composer is at rest (nothing typed or attached) its target top
  // follows the measured heights: the greeting above it (marked
  // `data-composer-above`) and the container's own content (composer, starter
  // suggestions) are centered together in the space above the disclaimer, so
  // they never overlap at any window size — and the same spot is reached
  // whether the screen mounted on a hard refresh or through "New chat". Once
  // the user types, that top is frozen, so the box only ever grows downward.
  const composerRestingRef = useRef(true);
  composerRestingRef.current = currentMessage.trim() === "" && attachmentsCount === 0;
  const targetTopRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!isMessagesEmpty) {
      targetTopRef.current = null;
      setLiftY(null);
      setFloatingMaxHeight(DEFAULT_TEXTAREA_MAX);
      return;
    }
    const el = containerEl;
    const area = el?.parentElement;
    if (!el || !area) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());

    const measure = () => {
      // Layout sizes, not getBoundingClientRect: the lift is a transform.
      const height = el.offsetHeight;
      // The box's place at rest: its offset in the area (the area is its
      // offset parent), above whatever follows it there.
      const restTop = el.offsetTop;
      const slotBottom = restTop + height;
      if (slotBottom <= 0 || height <= 0) return;
      // The greeting and the composer box sit inside the container's padding.
      const style = getComputedStyle(el);
      const padTop = parseFloat(style.paddingTop) || 0;
      const padBottom = parseFloat(style.paddingBottom) || 0;
      const above = el.querySelector<HTMLElement>("[data-composer-above]");
      if (above) observer?.observe(above);
      const greeting = above?.offsetHeight ?? 0;
      if (composerRestingRef.current || targetTopRef.current === null) {
        const group = greeting + (height - padTop - padBottom);
        const groupTop = Math.max(GROUP_MIN_MARGIN, (slotBottom - group) * GROUP_ANCHOR_RATIO);
        // The composer itself never drops below its place at rest.
        targetTopRef.current = Math.min(groupTop + greeting - padTop, restTop);
      }
      const targetTop = targetTopRef.current;
      const next = Math.round(targetTop - restTop);
      setLiftY((prev) => (prev === next ? prev : next));
      const spaceBelow = slotBottom - (targetTop + height);
      setFloatingMaxHeight(spaceBelow > 0 ? spaceBelow * FLOATING_MAX_RATIO : DEFAULT_TEXTAREA_MAX);
    };

    measure();
    if (!observer) return;
    observer.observe(el);
    observer.observe(area);
    // What follows the box (the disclaimer) moves its place at rest when it
    // rewraps, without the box or the area changing size.
    for (const sibling of Array.from(area.children)) {
      if (sibling !== el) observer.observe(sibling);
    }
    return () => observer.disconnect();
  }, [isMessagesEmpty, containerEl]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const computeViewportMaxHeight = () => {
      const viewportRatio =
        window.innerWidth >= DESKTOP_TEXTAREA_MIN_WIDTH
          ? DESKTOP_TEXTAREA_MAX_RATIO
          : MOBILE_TEXTAREA_MAX_RATIO;

      setViewportMaxHeight(Math.max(MIN_TEXTAREA_HEIGHT, window.innerHeight * viewportRatio));
    };

    computeViewportMaxHeight();
    window.addEventListener("resize", computeViewportMaxHeight);

    return () => {
      window.removeEventListener("resize", computeViewportMaxHeight);
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.maxHeight = `${effectiveTextareaMax}px`;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, effectiveTextareaMax);
    const clampedHeight = Math.max(nextHeight, MIN_TEXTAREA_HEIGHT);
    textarea.style.height = `${clampedHeight}px`;
  }, [textareaRef, currentMessage, attachmentsCount, effectiveTextareaMax, isMessagesEmpty]);

  return {
    containerRef: setContainerEl,
    liftY,
    textareaMaxHeight: effectiveTextareaMax,
  };
}
