import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Agent, ThinkingState } from '@/shared/lib/types';
import type { CSSProperties, RefObject } from 'react';


// ---------------------------------------------------------------------------
// Auto-scroll effect
// ---------------------------------------------------------------------------
export function useAutoScrollEffect(messages: any[], thinkingState: ThinkingState | null, messagesEndRef: React.RefObject<HTMLDivElement>, shouldAutoScroll: boolean) {
  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
        inline: 'nearest',
      });
    }, 100);
  };

  useEffect(() => {
    if (!shouldAutoScroll) return;
    scrollToBottom();
  }, [messages, thinkingState, shouldAutoScroll]);
}


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

  const toggleCollapsedOnBlankArea = useCallback(
    () => {
      if (isCollapsed) {
        toggleSidebar();
      }
    },
    [isCollapsed, toggleSidebar],
  );

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
const FLOATING_ANCHOR_RATIO = 0.35;
const MOBILE_TEXTAREA_MAX_RATIO = 0.42;
const DESKTOP_TEXTAREA_MAX_RATIO = 0.5;
const DESKTOP_TEXTAREA_MIN_WIDTH = 768;

export function useCenteredComposerLayout({
  isMessagesEmpty,
  textareaRef,
  currentMessage,
  attachmentsCount,
}: CenteredComposerLayoutArgs) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [centerAnchorOffset, setCenterAnchorOffset] = useState<number | null>(null);
  const [floatingMaxHeight, setFloatingMaxHeight] = useState<number>(DEFAULT_TEXTAREA_MAX);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number>(DEFAULT_TEXTAREA_MAX);

  const textareaMaxHeight = isMessagesEmpty ? floatingMaxHeight : DEFAULT_TEXTAREA_MAX;
  const effectiveTextareaMax = Math.max(
    Math.min(textareaMaxHeight, viewportMaxHeight),
    MIN_TEXTAREA_HEIGHT,
  );

  const emptyWrapperStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isMessagesEmpty || centerAnchorOffset === null) return undefined;
    const anchorPercent = FLOATING_ANCHOR_RATIO * 100;
    return {
      transform: 'translateX(-50%)',
      top: `calc(${anchorPercent}% - ${centerAnchorOffset}px)`,
    };
  }, [isMessagesEmpty, centerAnchorOffset]);

  // Track whether the composer is at rest (nothing typed / attached). While at
  // rest, the centered anchor stays synced to the measured height via a
  // ResizeObserver below, so the empty composer lands in the SAME centered spot
  // whether it mounted on a hard refresh or via a client-side "New chat"
  // transition. (The old one-shot getBoundingClientRect ran once, before the
  // new-chat transition had settled, so it measured a shorter height and the box
  // sat too low — refresh measured the full height and sat correctly.) Once the
  // user starts typing we stop updating, freezing the top so the box only ever
  // grows downward.
  const composerRestingRef = useRef(true);
  composerRestingRef.current = currentMessage.trim() === '' && attachmentsCount === 0;

  useLayoutEffect(() => {
    if (!isMessagesEmpty) {
      setCenterAnchorOffset(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      // Frozen while the user is composing — don't re-center as the box grows.
      if (!composerRestingRef.current) return;
      const height = el.getBoundingClientRect().height;
      if (height <= 0) return;
      const next = height / 2;
      setCenterAnchorOffset((prev) =>
        prev !== null && Math.abs(prev - next) < 0.5 ? prev : next,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isMessagesEmpty]);

  useEffect(() => {
    if (!isMessagesEmpty) {
      setFloatingMaxHeight(DEFAULT_TEXTAREA_MAX);
      return;
    }
    if (typeof window === 'undefined') return;
    const el = containerRef.current;
    if (!el) return;

    const computeMaxHeight = () => {
      const rect = el.getBoundingClientRect();
      const availableSpace = window.innerHeight - rect.bottom;
      if (availableSpace > 0) {
        const target = availableSpace * FLOATING_MAX_RATIO;
        setFloatingMaxHeight(target > 0 ? target : DEFAULT_TEXTAREA_MAX);
      } else {
        setFloatingMaxHeight(DEFAULT_TEXTAREA_MAX);
      }
    };

    computeMaxHeight();

    const handleResize = () => computeMaxHeight();
    window.addEventListener('resize', handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => computeMaxHeight());
      resizeObserver.observe(el);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
    };
  }, [isMessagesEmpty]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const computeViewportMaxHeight = () => {
      const viewportRatio =
        window.innerWidth >= DESKTOP_TEXTAREA_MIN_WIDTH
          ? DESKTOP_TEXTAREA_MAX_RATIO
          : MOBILE_TEXTAREA_MAX_RATIO;

      setViewportMaxHeight(
        Math.max(MIN_TEXTAREA_HEIGHT, window.innerHeight * viewportRatio),
      );
    };

    computeViewportMaxHeight();
    window.addEventListener('resize', computeViewportMaxHeight);

    return () => {
      window.removeEventListener('resize', computeViewportMaxHeight);
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.maxHeight = `${effectiveTextareaMax}px`;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, effectiveTextareaMax);
    const clampedHeight = Math.max(nextHeight, MIN_TEXTAREA_HEIGHT);
    textarea.style.height = `${clampedHeight}px`;
  }, [
    textareaRef,
    currentMessage,
    attachmentsCount,
    effectiveTextareaMax,
    isMessagesEmpty,
  ]);

  return {
    containerRef,
    emptyWrapperStyle,
    textareaMaxHeight: effectiveTextareaMax,
  };
}
