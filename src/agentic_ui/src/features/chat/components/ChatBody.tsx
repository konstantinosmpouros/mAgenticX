import React from "react";
import type { ComponentType } from "react";
import { useReducedMotion } from "framer-motion";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { ArrowDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Agent, MessageOut, RunTimeline, ThinkingState } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import type { AttachmentLike } from "./message_parts/MessageAttachments";
import { ChatMessage } from "./ChatMessage";
import { ConversationRail } from "./message_parts/ConversationRail";

// Distance (px) of the newest REAL content below the fold before the
// jump-to-bottom button appears.
const JUMP_BUTTON_DISTANCE = 160;
// Within this many px of the newest content, drifting back down re-attaches the follow.
const RESTICK_DISTANCE = 36;
// Any upward wheel/trackpad delta past this detaches — tiny so one light nudge frees it.
const UNPIN_WHEEL_DELTA = 1;
// Upward finger travel (px) that counts as a detach on touch.
const UNPIN_TOUCH_DELTA = 6;
// Upward scroll (px) from keyboard/scrollbar/trackpad that counts as a detach — small,
// so "move up a bit" always unsticks, including during the anchored-gap phase.
const UNPIN_SCROLL_DELTA = 3;
// A scroll event landing within this many px of our last programmatic write is treated
// as our own echo, not a user scroll.
const PROGRAMMATIC_ECHO_PX = 2;
// Gap kept above the question while it sits anchored at the top during streaming.
const SCROLL_PADDING_TOP = 24;
// Gap kept below the newest line so it never butts against the composer.
const BOTTOM_BREATHING_ROOM = 48;
// Ride-along uses an exponential approach (fraction of the remaining distance closed
// per frame at 60fps) — ideal for a target that keeps moving as the answer streams.
const EASE_FOLLOW = 0.26;
// Below this many px from the target the ride-along tween snaps and stops.
const SETTLE_EPSILON = 0.5;
// Deliberate moves (turn start, re-stick, jump button) use a FIXED-DURATION
// ease-in-out so a large jump reads as a smooth, controlled glide instead of an
// exponential approach that covers most of the distance in the first frame (a
// near-teleport).
//
// The duration is NOT flat. Scroll distance here is unbounded — one screen or
// fifty — so a single number makes the *velocity* vary wildly: a long trip
// blurs past while a short one crawls. It scales with distance and clamps at
// both ends instead.
type GlideCurve = { minMs: number; maxMs: number; msPerPx: number };

// Turn start and settle-at-end. Automatic, so it stays tighter at the top end —
// the answer should not sit behind a second of animation on every single reply.
const TURN_GLIDE: GlideCurve = { minMs: 520, maxMs: 900, msPerPx: 0.28 };
// The jump-to-bottom button. User-initiated and the longest trip in the app, so
// it gets room to read as a deliberate move you can follow with your eye.
const BUTTON_GLIDE: GlideCurve = { minMs: 600, maxMs: 1200, msPerPx: 0.32 };

const glideDuration = (distancePx: number, curve: GlideCurve) =>
  Math.min(curve.maxMs, curve.minMs + distancePx * curve.msPerPx);

type ChatBody = {
  messages: MessageOut[];
  showMessageTokenUsage?: boolean;
  loadingConversation: boolean;
  expandedThinking: Record<string, boolean>;
  isImageFile: (attachment: AttachmentLike) => boolean;
  onDownloadAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onPreviewAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onImageClick: (imageUrl: string) => void;
  onToggleThinking: (messageId: string, next?: boolean) => void;
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onReportMessage?: (message: MessageOut) => void;
  conversationIsReported?: boolean;
  stickyUserBarId: string | null;
  onFlashUserActionBar: (messageId: string) => void;
  AiTransitionIndicator?: ComponentType;
  thinkingState: ThinkingState | null;
  // The active run's assistant placeholder id. Fallback identity for the
  // streaming reply when thinkingState hasn't activated yet (pre-first-signal)
  // or was lost (e.g. reload mid-run) — keeps the reply's action bar hidden and
  // its live timeline attached for the run's entire lifetime.
  activeRunAssistantMessageId?: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  resolveMessageAgent?: (message: MessageOut) => { name: string; Icon: LucideIcon };
  onScrolledPastTop?: (isScrolled: boolean) => void;
  branchChildrenMap?: Record<string, MessageOut[]>;
  branchSelections?: Record<string, number>;
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
  branchRootKey?: string;
  activeBranchPath?: string[];
  editingMessageId?: string | null;
  editingDraft?: string;
  editingBusy?: boolean;
  onRequestEdit?: (message: MessageOut) => void;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  onRetryMessage?: (message: MessageOut) => void;
  onForkMessage?: (message: MessageOut) => void;
  onShareMessage?: (message: MessageOut) => void;
  onReadAloud?: (message: MessageOut) => void;
  speakingMessageId?: string | null;
  readOnly?: boolean;
  isStreaming?: boolean;
  // Incrementally-folded timeline of the conversation's active run; handed
  // only to the streaming target message.
  liveTimeline?: RunTimeline | null;
  scrollResetKey?: string | null;
};

export default function ChatBody({
  messages,
  showMessageTokenUsage = false,
  loadingConversation,
  expandedThinking,
  isImageFile,
  onDownloadAttachment,
  onPreviewAttachment,
  onImageClick,
  onToggleThinking,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  conversationIsReported = false,
  stickyUserBarId,
  onFlashUserActionBar,
  AiTransitionIndicator,
  thinkingState,
  activeRunAssistantMessageId = null,
  messagesEndRef,
  AgentIcon,
  currentAgent,
  resolveMessageAgent,
  onScrolledPastTop,
  branchChildrenMap = {},
  branchSelections = {},
  onSelectBranch,
  branchRootKey = "__root__",
  activeBranchPath,
  editingMessageId,
  editingDraft,
  editingBusy,
  onRequestEdit,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
  onRetryMessage,
  onForkMessage,
  onShareMessage,
  onReadAloud,
  speakingMessageId,
  readOnly = false,
  isStreaming,
  liveTimeline = null,
  scrollResetKey,
}: ChatBody) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  // Spacer rendered just past the real content end. While a run streams it grows
  // to give the answer room to breathe (and to let the question sit at the top);
  // it relaxes to 0 at rest. Height is driven imperatively so per-token stream
  // ticks never trigger a React re-render.
  const bottomSpacerRef = React.useRef<HTMLDivElement | null>(null);
  // Last scrollTop we OBSERVED in a scroll event — the reference for "which way did
  // the user just move". Updated only by handleScroll.
  const previousScrollTopRef = React.useRef(0);
  // The exact scrollTop value WE last wrote programmatically (snap/glide/spring). A
  // scroll event landing within a couple px of this is our own echo, not the user —
  // position-based, so it works even during a fast stream (no fragile time window that
  // a per-token tick could keep alive and thereby block a real scrollbar/keyboard move).
  const lastWrittenTopRef = React.useRef(0);
  const scrollFrameRef = React.useRef<number | null>(null);
  // The custom scroll tween shares one rAF handle (animFrameRef): either a ride-along
  // spring easing toward targetScrollRef, or a fixed-duration glide. Driven ourselves
  // instead of native scrollTo({behavior:"smooth"}) because the spring must retarget
  // mid-flight (every stream token) and every move must be cancelable by a user gesture.
  const animFrameRef = React.useRef<number | null>(null);
  const targetScrollRef = React.useRef(0);
  // True while a fixed-duration glide owns the scroll — ride-along ticks defer to it so
  // the deliberate move plays out uninterrupted, and any user gesture cancels it.
  const glidingRef = React.useRef(false);
  const suppressFollowRef = React.useRef(false);
  const pendingGlideRef = React.useRef(false);
  // Previous streaming state, so the settle-at-bottom glide fires once when the run
  // ends rather than on every later re-render (which would fight the user's scroll).
  const wasStreamingRef = React.useRef(false);
  const prevStreamingIdRef = React.useRef<string | null>(null);
  const touchYRef = React.useRef(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = React.useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);
  const prefersReducedMotion = useReducedMotion();

  const streamingMessageId = React.useMemo(() => {
    // The active run is authoritative: its assistant placeholder is the
    // streaming reply for the run's ENTIRE lifetime — including the transition
    // phase before the agent's first signal, when thinkingState still holds
    // the PREVIOUS turn's (done) branchPath and would misidentify the target.
    if (activeRunAssistantMessageId) {
      return activeRunAssistantMessageId;
    }
    if (thinkingState?.branchPath && thinkingState.branchPath.length > 0) {
      return thinkingState.branchPath[thinkingState.branchPath.length - 1];
    }
    return null;
  }, [activeRunAssistantMessageId, thinkingState?.branchPath]);

  // The turn we anchor to the top while streaming: the user message that started
  // the run (the streaming reply's parent), falling back to the reply itself.
  const anchorMessageId = React.useMemo(() => {
    if (!streamingMessageId) return null;
    const streaming = messages.find((m) => m.id === streamingMessageId);
    return streaming?.parentMessageId ?? streamingMessageId;
  }, [streamingMessageId, messages]);

  // Measure the viewport + key content offsets in scroll coordinates. The real
  // content bottom is read from messagesEndRef, which sits ABOVE the streaming
  // spacer, so it stays independent of the current spacer height.
  const measure = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const H = viewport.clientHeight;
    const scrollTop = viewport.scrollTop;
    const vTop = viewport.getBoundingClientRect().top;
    const endEl = messagesEndRef.current;
    const contentBottom = endEl
      ? endEl.getBoundingClientRect().top - vTop + scrollTop
      : viewport.scrollHeight;
    let anchorTop: number | null = null;
    if (anchorMessageId && columnRef.current) {
      const anchorEl = columnRef.current.querySelector(`[data-message-id="${anchorMessageId}"]`);
      if (anchorEl) {
        anchorTop = (anchorEl as HTMLElement).getBoundingClientRect().top - vTop + scrollTop;
      }
    }
    return { H, scrollTop, contentBottom, anchorTop };
  }, [anchorMessageId, messagesEndRef]);

  // Distance from the ACTUAL scroll bottom — where the pinned view sits in BOTH anchor
  // and follow modes (we always scroll to the max reachable target). Uses scrollHeight
  // (spacer included) so re-stick means "back at the pinned view" and the jump button
  // reflects how far the user has scrolled away from it.
  //
  // NB: measuring from the real *content* bottom instead was the gap-phase bug — during
  // the reserved-gap phase the content is above the fold, so that distance is ~0 no
  // matter where you scroll, which re-pinned the instant the user paused scrolling up.
  const distanceFromBottom = React.useCallback(() => {
    const v = viewportRef.current;
    if (!v) return 0;
    return Math.max(0, v.scrollHeight - v.scrollTop - v.clientHeight);
  }, []);

  const setSpacerHeight = React.useCallback((px: number) => {
    const el = bottomSpacerRef.current;
    if (el) el.style.height = `${Math.max(0, Math.round(px))}px`;
  }, []);

  const stopScrollAnim = React.useCallback(() => {
    if (animFrameRef.current !== null) {
      window.cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    glidingRef.current = false;
  }, []);

  const snapScrollTo = React.useCallback(
    (target: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      stopScrollAnim();
      const to = Math.max(0, target);
      viewport.scrollTop = to;
      lastWrittenTopRef.current = to;
    },
    [stopScrollAnim],
  );

  // Deliberate move: a FIXED-DURATION ease-in-out from the current position to the
  // target. Used for the entrance, re-stick and the jump button so a big jump feels
  // like a smooth, controlled glide. Owns the scroll (glidingRef) so ride-along ticks
  // don't fight it; any user gesture calls stopScrollAnim() to cancel it instantly.
  const glideScrollTo = React.useCallback(
    (target: number, durationMs: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const to = Math.max(0, target);
      const from = viewport.scrollTop;
      if (prefersReducedMotion || Math.abs(to - from) < 1) {
        snapScrollTo(to);
        return;
      }
      stopScrollAnim();
      glidingRef.current = true;
      const startedAt = window.performance.now();
      const step = (nowTs: number) => {
        const vp = viewportRef.current;
        if (!vp) {
          animFrameRef.current = null;
          glidingRef.current = false;
          return;
        }
        const t = Math.min(1, (nowTs - startedAt) / durationMs);
        // easeInOutCubic — gentle acceleration and deceleration at both ends.
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const pos = from + (to - from) * eased;
        vp.scrollTop = pos;
        lastWrittenTopRef.current = pos;
        if (t >= 1) {
          vp.scrollTop = to;
          lastWrittenTopRef.current = to;
          animFrameRef.current = null;
          glidingRef.current = false;
          return;
        }
        animFrameRef.current = window.requestAnimationFrame(step);
      };
      animFrameRef.current = window.requestAnimationFrame(step);
    },
    [prefersReducedMotion, stopScrollAnim, snapScrollTo],
  );

  // Ride-along: exponential approach toward an ever-moving target. Retargeting is just
  // updating targetScrollRef — the running loop picks it up, so the motion stays
  // continuous as the stream appends. Defers to an in-flight glide.
  const springScrollTo = React.useCallback(
    (target: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      targetScrollRef.current = Math.max(0, target);
      if (prefersReducedMotion) {
        snapScrollTo(targetScrollRef.current);
        return;
      }
      if (glidingRef.current) return; // a deliberate glide owns the scroll right now
      if (animFrameRef.current !== null) return; // spring already running — it picks up the new target

      const step = () => {
        const vp = viewportRef.current;
        if (!vp) {
          animFrameRef.current = null;
          return;
        }
        const diff = targetScrollRef.current - vp.scrollTop;
        if (Math.abs(diff) <= SETTLE_EPSILON) {
          // Settled: write the exact target (usually a no-op) and stop. Critically we
          // do NOT keep any programmatic window alive here — so between tokens a real
          // scrollbar/keyboard move up is recognised immediately during the gap phase.
          vp.scrollTop = targetScrollRef.current;
          lastWrittenTopRef.current = targetScrollRef.current;
          animFrameRef.current = null;
          return;
        }
        const next = vp.scrollTop + diff * EASE_FOLLOW;
        vp.scrollTop = next;
        lastWrittenTopRef.current = next;
        animFrameRef.current = window.requestAnimationFrame(step);
      };
      animFrameRef.current = window.requestAnimationFrame(step);
    },
    [prefersReducedMotion, snapScrollTo],
  );

  // Single source of truth for "keep the stream in view": sizes the spacer and moves
  // to the right target for the current mode — hold the question at the top while the
  // answer is short, ride the bottom (with breathing room) once it fills the viewport,
  // plain bottom otherwise. Mode picks the motion: "glide"/"glideButton" for deliberate
  // fixed-duration moves, "follow" for per-token ride-along, "instant" for switches.
  const followTick = React.useCallback(
    (mode: "glide" | "glideButton" | "follow" | "instant") => {
      const viewport = viewportRef.current;
      const m = measure();
      if (!viewport || !m) return;

      let spacer = 0;
      let target: number;
      const canAnchor = isStreaming && !prefersReducedMotion && m.anchorTop != null;
      if (canAnchor) {
        const anchorTop = m.anchorTop as number;
        const contentBelowAnchor = Math.max(0, m.contentBottom - anchorTop);
        const anchorSpace = m.H - SCROLL_PADDING_TOP;
        if (contentBelowAnchor < anchorSpace) {
          // Answer still shorter than the viewport — hold the question near the top
          // and let the reply fill the space below it.
          spacer = anchorSpace - contentBelowAnchor;
          target = anchorTop - SCROLL_PADDING_TOP;
        } else {
          // Answer fills the viewport — ride the bottom with breathing room.
          spacer = BOTTOM_BREATHING_ROOM;
          target = m.contentBottom + spacer - m.H;
        }
      } else if (isStreaming && !prefersReducedMotion) {
        spacer = BOTTOM_BREATHING_ROOM;
        target = m.contentBottom + spacer - m.H;
      } else {
        spacer = 0;
        target = m.contentBottom - m.H;
      }

      setSpacerHeight(spacer);
      setShowJumpToBottom(false);
      const to = Math.max(0, target);
      if (mode === "instant") {
        snapScrollTo(to);
      } else if (mode === "follow") {
        springScrollTo(to);
      } else {
        const distance = Math.abs(to - viewport.scrollTop);
        glideScrollTo(
          to,
          glideDuration(distance, mode === "glideButton" ? BUTTON_GLIDE : TURN_GLIDE),
        );
      }
    },
    [
      measure,
      isStreaming,
      prefersReducedMotion,
      setSpacerHeight,
      snapScrollTo,
      springScrollTo,
      glideScrollTo,
    ],
  );

  const scheduleFollow = React.useCallback(
    (mode: "glide" | "glideButton" | "follow" | "instant" = "follow") => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        // A pending glide (turn start / re-stick) upgrades a plain follow so the
        // deliberate move keeps its gentle fixed-duration easing even though the
        // ride-along effect is what actually fires.
        let resolved = mode;
        if (pendingGlideRef.current) {
          if (resolved === "follow") resolved = "glide";
          pendingGlideRef.current = false;
        }
        followTick(resolved);
      });
    },
    [followTick],
  );

  React.useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (animFrameRef.current !== null) {
        window.cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  // Conversation switch / initial load: reset to a clean pinned-at-bottom state
  // with no leftover spacer from a previous stream.
  React.useEffect(() => {
    stopScrollAnim();
    setIsPinnedToBottom(true);
    setShowJumpToBottom(false);
    setSpacerHeight(0);
    prevStreamingIdRef.current = null;
    scheduleFollow("instant");
  }, [scrollResetKey, scheduleFollow, setSpacerHeight, stopScrollAnim]);

  // A new reply began: re-pin and glide so the question rises to the top with the
  // answer area open below it (the "scroll a bit more" entrance).
  React.useEffect(() => {
    if (!isStreaming || !streamingMessageId) {
      prevStreamingIdRef.current = streamingMessageId;
      return;
    }
    if (prevStreamingIdRef.current !== streamingMessageId) {
      prevStreamingIdRef.current = streamingMessageId;
      suppressFollowRef.current = false;
      setIsPinnedToBottom(true);
      scheduleFollow("glide");
    }
  }, [isStreaming, streamingMessageId, scheduleFollow]);

  // Ride the stream while pinned. Once the user detaches (isPinnedToBottom false)
  // nothing here re-pins them — only a deliberate return to the bottom does — so a
  // light scroll up breaks free instead of fighting the follow.
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Skip the follow for the render caused by a manual branch switch — the list
    // changed because the user navigated siblings, not because the stream appended.
    if (suppressFollowRef.current) {
      suppressFollowRef.current = false;
      setShowJumpToBottom(distanceFromBottom() > JUMP_BUTTON_DISTANCE);
      return;
    }

    // Only ride the stream while it's actually running and the user hasn't
    // detached. At rest we never auto-scroll on a re-render (a like, a token-usage
    // toggle, …) — settling at the bottom is owned by the reset / run-finished
    // effects — we only keep the jump button in sync.
    if (!isStreaming || !isPinnedToBottom) {
      setShowJumpToBottom(distanceFromBottom() > JUMP_BUTTON_DISTANCE);
      return;
    }

    scheduleFollow("follow");
  }, [
    messages,
    thinkingState,
    liveTimeline,
    isStreaming,
    isPinnedToBottom,
    distanceFromBottom,
    scheduleFollow,
  ]);

  // Run finished: drop the breathing room so the resting layout looks normal,
  // keeping the final answer where it is.
  React.useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = Boolean(isStreaming);
    // Only act on the run's END transition — never on later re-renders, or a stray
    // messages/callback change would keep yanking the user back down after they've
    // scrolled up to read.
    if (isStreaming || !wasStreaming) return;
    setSpacerHeight(0);
    if (isPinnedToBottom) scheduleFollow("glide");
  }, [isStreaming, isPinnedToBottom, scheduleFollow, setSpacerHeight]);

  const handleJumpToBottom = React.useCallback(() => {
    setIsPinnedToBottom(true);
    scheduleFollow("glideButton");
  }, [scheduleFollow]);

  const handleSelectBranch = React.useCallback(
    (parentId: string | null, branchIndex: number) => {
      // Flag the imminent message-list change as a manual branch switch so the
      // follow effect skips its auto-scroll (preserves the user's position).
      suppressFollowRef.current = true;
      onSelectBranch?.(parentId, branchIndex);
    },
    [onSelectBranch],
  );

  // A manual wheel ALWAYS cancels an in-flight glide (up, or down while gliding) so the
  // user is never fighting our tween — including the non-streaming jump-button glide.
  // Any upward intent also detaches the follow, whether or not a run is streaming, so
  // the user can freely scroll up after clicking the button too.
  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const up = event.deltaY < -UNPIN_WHEEL_DELTA;
      const down = event.deltaY > UNPIN_WHEEL_DELTA;
      if (up || (down && glidingRef.current)) stopScrollAnim();
      if (up) setIsPinnedToBottom(false);
    },
    [stopScrollAnim],
  );

  const handleTouchStart = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY ?? 0;
  }, []);

  // Finger dragging DOWN reveals earlier content (scrolling up). Same rules as the
  // wheel: cancel an in-flight glide on any drag, detach on upward drag — always.
  const handleTouchMove = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY ?? 0;
      const delta = y - touchYRef.current;
      touchYRef.current = y;
      const up = delta > UNPIN_TOUCH_DELTA;
      const down = delta < -UNPIN_TOUCH_DELTA;
      if (up || (down && glidingRef.current)) stopScrollAnim();
      if (up) setIsPinnedToBottom(false);
    },
    [stopScrollAnim],
  );

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const cur = viewport.scrollTop;
      onScrolledPastTop?.(cur > 4);

      // Our own programmatic scroll lands within a couple px of the value we just
      // wrote — that's an echo, not the user, so it never (un)pins.
      const isEcho = Math.abs(cur - lastWrittenTopRef.current) < PROGRAMMATIC_ECHO_PX;
      const movedUp = previousScrollTopRef.current - cur;
      previousScrollTopRef.current = cur;
      if (isEcho) return;

      const distance = distanceFromBottom();
      setShowJumpToBottom(distance > JUMP_BUTTON_DISTANCE);

      if (movedUp > UNPIN_SCROLL_DELTA) {
        // A genuine upward move — even a small one — detaches, regardless of streaming.
        // Covers scrollbar, keyboard and trackpad (wheel + touch are handled above) and
        // works during the anchored-gap phase because no programmatic window blocks it.
        stopScrollAnim();
        setIsPinnedToBottom(false);
        return;
      }
      if (distance <= RESTICK_DISTANCE && !isPinnedToBottom) {
        // Drifted back to the pinned position (near the actual scroll bottom) — re-attach
        // and glide the rest of the way, then ride the stream again. Measuring from the
        // scroll bottom (not the content bottom) is what lets the user STAY detached in
        // the gap phase instead of being re-pinned the moment they stop scrolling up.
        if (isStreaming) pendingGlideRef.current = true;
        setIsPinnedToBottom(true);
      }
    },
    [distanceFromBottom, isStreaming, isPinnedToBottom, onScrolledPastTop, stopScrollAnim],
  );

  React.useEffect(() => {
    if (!onScrolledPastTop) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    onScrolledPastTop(viewport.scrollTop > 4);
  }, [messages.length, onScrolledPastTop]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ScrollArea
        className="h-full"
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        viewportRef={viewportRef}
      >
        <div
          ref={columnRef}
          className="w-full max-w-3xl mx-auto p-3 md:p-6 space-y-4 md:space-y-6 messages-container transition-smooth"
        >
          {loadingConversation && (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-fade-in">
                  <div className="flex justify-end mb-4">
                    <div className="max-w-[85%] md:max-w-[70%]">
                      <div className="loading-skeleton h-20 rounded-2xl"></div>
                    </div>
                  </div>
                  <div className="flex justify-start">
                    <div className="max-w-[85%] md:max-w-[70%]">
                      <div className="loading-skeleton h-16 rounded-2xl"></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loadingConversation &&
            messages.map((message) => {
              const isEditingMessage = editingMessageId === message.id;

              const userActionVisibilityClass = `transition-opacity ${
                stickyUserBarId === message.id
                  ? "opacity-100 pointer-events-auto"
                  : "opacity-0 group-hover/message:opacity-100 hover:opacity-100 pointer-events-none group-hover/message:pointer-events-auto hover:pointer-events-auto"
              }`;

              const parentId = message.parentMessageId ?? null;

              const branchOptions = parentId
                ? branchChildrenMap[parentId]
                : branchChildrenMap[branchRootKey];

              const branchSelection = parentId
                ? (branchSelections[parentId] ?? 0)
                : (branchSelections[branchRootKey] ?? 0);

              return (
                <div
                  key={message.id}
                  data-message-id={message.id}
                  className="animate-message-in space-y-2"
                >
                  <ChatMessage
                    message={message}
                    showMessageTokenUsage={showMessageTokenUsage}
                    isEditing={isEditingMessage}
                    editingDraft={editingDraft}
                    editingBusy={editingBusy}
                    onChangeEditDraft={onChangeEditDraft}
                    onCancelEdit={onCancelEdit}
                    onSubmitEdit={onSubmitEdit}
                    AgentIcon={AgentIcon}
                    currentAgent={currentAgent}
                    resolveMessageAgent={resolveMessageAgent}
                    copiedId={copiedId}
                    onCopy={onCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    onReportMessage={onReportMessage}
                    conversationIsReported={conversationIsReported}
                    onRetryMessage={onRetryMessage}
                    onForkMessage={onForkMessage}
                    onShareMessage={onShareMessage}
                    onReadAloud={onReadAloud}
                    speakingMessageId={speakingMessageId}
                    readOnly={readOnly}
                    isStreaming={isStreaming}
                    onFlashUserActionBar={onFlashUserActionBar}
                    onRequestEdit={onRequestEdit}
                    userActionVisibilityClass={userActionVisibilityClass}
                    thinkingState={thinkingState}
                    expandedThinking={expandedThinking}
                    onToggleThinking={onToggleThinking}
                    activeBranchPath={activeBranchPath}
                    streamingMessageId={streamingMessageId}
                    liveTimeline={streamingMessageId === message.id ? liveTimeline : null}
                    isImageFile={isImageFile}
                    onDownloadAttachment={onDownloadAttachment}
                    onPreviewAttachment={onPreviewAttachment}
                    onImageClick={onImageClick}
                    branchData={{
                      parentId,
                      options: branchOptions,
                      selectionIndex: branchSelection,
                      onSelectBranch: handleSelectBranch,
                    }}
                  />
                </div>
              );
            })}

          {AiTransitionIndicator ? <AiTransitionIndicator /> : null}

          <div ref={messagesEndRef} />
          {/* Streaming breathing-room / top-anchor slack. Height is set imperatively
              (never CSS-animated — the no-animating-height rule); !mt-0 stops the
              space-y stack adding a gap when it's collapsed to 0 at rest. */}
          <div ref={bottomSpacerRef} aria-hidden="true" className="!mt-0" style={{ height: 0 }} />
        </div>
      </ScrollArea>
      {!loadingConversation && (
        <ConversationRail messages={messages} viewportRef={viewportRef} columnRef={columnRef} />
      )}
      <button
        type="button"
        aria-label="Jump to latest message"
        title="Jump to latest message"
        onClick={handleJumpToBottom}
        className={cn(
          "absolute bottom-4 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full",
          "border border-border/70 bg-background/85 text-foreground shadow-lg shadow-black/20 backdrop-blur-md",
          "transition-[opacity,transform,background-color,color] duration-500 ease-out hover:bg-background/92 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          showJumpToBottom
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-4 scale-90 opacity-0",
        )}
      >
        <ArrowDown className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
