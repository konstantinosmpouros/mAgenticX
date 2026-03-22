import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Agent, ThinkingState } from '@/lib/types';
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
  allowMissingAgentId?: string | null;
}) {
  const {
    isLoggedIn,
    userId,
    agents,
    selectedAgent,
    setSelectedAgent,
    allowMissingAgentId,
  } = params;

  useEffect(() => {
    if (isLoggedIn && userId && agents.length > 0) {
      const exists = agents.some(a => a.id === selectedAgent);
      if (!exists) {
        if (allowMissingAgentId && selectedAgent === allowMissingAgentId) {
          return;
        }
        setSelectedAgent(agents[0].id);
      }
    }
  }, [isLoggedIn, userId, agents, selectedAgent, allowMissingAgentId, setSelectedAgent]);
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
// Centered composer layout effect
// ---------------------------------------------------------------------------
type CenteredComposerLayoutArgs = {
  isMessagesEmpty: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  currentMessage: string;
  attachmentsCount: number;
};

const DEFAULT_TEXTAREA_MAX = 168;
const FLOATING_MAX_RATIO = 0.68;
const MIN_TEXTAREA_HEIGHT = 48;
const FLOATING_ANCHOR_RATIO = 0.35;

export function useCenteredComposerLayout({
  isMessagesEmpty,
  textareaRef,
  currentMessage,
  attachmentsCount,
}: CenteredComposerLayoutArgs) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [centerAnchorOffset, setCenterAnchorOffset] = useState<number | null>(null);
  const [floatingMaxHeight, setFloatingMaxHeight] = useState<number>(DEFAULT_TEXTAREA_MAX);

  const textareaMaxHeight = isMessagesEmpty ? floatingMaxHeight : DEFAULT_TEXTAREA_MAX;
  const effectiveTextareaMax = Math.max(textareaMaxHeight, MIN_TEXTAREA_HEIGHT);

  const emptyWrapperStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isMessagesEmpty || centerAnchorOffset === null) return undefined;
    const anchorPercent = FLOATING_ANCHOR_RATIO * 100;
    return {
      transform: 'translateX(-50%)',
      top: `calc(${anchorPercent}% - ${centerAnchorOffset}px)`,
    };
  }, [isMessagesEmpty, centerAnchorOffset]);

  useEffect(() => {
    if (!isMessagesEmpty) {
      setCenterAnchorOffset(null);
      return;
    }
    if (centerAnchorOffset !== null) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCenterAnchorOffset(rect.height / 2);
  }, [isMessagesEmpty, centerAnchorOffset]);

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
