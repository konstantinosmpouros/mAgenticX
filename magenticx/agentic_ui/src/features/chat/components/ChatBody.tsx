import React from "react";
import { useReducedMotion } from "framer-motion";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { ArrowDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Agent, MessageOut, RunTimeline, ThinkingState } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import type { AttachmentLike } from "./message_parts/MessageAttachments";
import { ChatMessage } from "./ChatMessage";
import { AiTransitionIndicator } from "./AiTransitionIndicator";
import { CompactionDivider } from "./message_parts/CompactionDivider";
import { ConversationRail } from "./message_parts/ConversationRail";

import { findStreamAnchor, streamScrollTarget } from "@/features/chat/lib/streamScroll";

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
// Ride-along is a critically damped spring (no overshoot) toward a target that keeps
// moving as the answer streams. Its velocity carries over between frames and
// retargets, so each streamed line eases the view along instead of kicking it: an
// exponential approach (a fixed share of the distance per frame) jumped from rest to
// full speed on every chunk, which read as a tremble. ~0.5s to settle.
const FOLLOW_STIFFNESS = 12;
// Below this distance (px) and speed (px/s) the spring snaps to its target and stops.
const SETTLE_EPSILON = 0.5;
const SETTLE_SPEED = 4;
// The most time (ms) one animation frame may advance a scroll tween.
const MAX_FRAME_MS = 25;
// Deliberate moves (turn start, jump button) use a FIXED-DURATION ease-in-out so a
// large jump reads as a smooth, controlled glide — starting and ending at rest —
// instead of an approach that covers most of the distance in the first frame.
//
// The duration is NOT flat. Scroll distance here is unbounded — one screen or
// fifty — so a single number makes the *velocity* vary wildly: a long trip
// blurs past while a short one crawls. It scales with distance and clamps at
// both ends instead.
type GlideCurve = { minMs: number; maxMs: number; msPerPx: number };

// Turn start: the sent question rising to the top. Automatic, so it stays tighter
// at the top end — the answer should not sit behind a second of animation on every
// single reply.
const TURN_GLIDE: GlideCurve = { minMs: 520, maxMs: 900, msPerPx: 0.28 };
// The jump-to-bottom button. User-initiated and the longest trip in the app, so
// it gets room to read as a deliberate move you can follow with your eye.
const BUTTON_GLIDE: GlideCurve = { minMs: 600, maxMs: 1200, msPerPx: 0.32 };

const glideDuration = (distancePx: number, curve: GlideCurve) =>
  Math.min(curve.maxMs, curve.minMs + distancePx * curve.msPerPx);

// How the next scheduled move travels. Several requests can land in one frame (a
// turn starting is also a message-list change); the strongest wins, so a glide is
// never downgraded to a plain follow by the render that comes with it.
type ScrollMode = "follow" | "glide" | "glideButton" | "instant";
const MODE_PRIORITY: Record<ScrollMode, number> = {
  follow: 0,
  glide: 1,
  glideButton: 2,
  instant: 3,
};


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
  /** The bridge orb between sending and the agent's first signal. */
  showAiTransition?: boolean;
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
  // The answer a manual compaction is running after (plan 34): its divider
  // shows "Compacting…" until the compaction is recorded on the answer.
  compactingMessageId?: string | null;
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
  showAiTransition = false,
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
  compactingMessageId = null,
}: ChatBody) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  // Spacer rendered just past the real content end. While a run streams it grows
  // to give the answer room to breathe (and to let the question sit at the top).
  // Height is driven imperatively so per-token stream ticks never trigger a React
  // re-render.
  const bottomSpacerRef = React.useRef<HTMLDivElement | null>(null);
  // Last scrollTop we OBSERVED in a scroll event — the reference for "which way did
  // the user just move". Updated only by handleScroll.
  const previousScrollTopRef = React.useRef(0);
  // The exact scrollTop value WE last wrote programmatically (snap/glide/spring). A
  // scroll event landing within a couple px of this is our own echo, not the user —
  // position-based, so it works even during a fast stream (no fragile time window that
  // a per-token tick could keep alive and thereby block a real scrollbar/keyboard move).
  const lastWrittenTopRef = React.useRef(0);
  // Where the view last was, whoever moved it (our writes and scroll events).
  const lastKnownTopRef = React.useRef(0);
  const scrollFrameRef = React.useRef<number | null>(null);
  const pendingModeRef = React.useRef<ScrollMode | null>(null);
  // The ONE owner of the scroll position: a single rAF handle shared by the
  // ride-along spring and the fixed-duration glides, so two writers can never
  // fight. Driven ourselves instead of native scrollTo({behavior:"smooth"}) because
  // the spring must retarget mid-flight (every stream token) and every move must be
  // cancelable by a user gesture.
  const animFrameRef = React.useRef<number | null>(null);
  const targetScrollRef = React.useRef(0);
  const velocityRef = React.useRef(0);
  // True while a fixed-duration glide owns the scroll — ride-along ticks only retarget
  // and resize the spacer, so the deliberate move plays out uninterrupted; any user
  // gesture cancels it.
  const glidingRef = React.useRef(false);
  const suppressFollowRef = React.useRef(false);
  // The turn the view last glided to, so the glide fires once per turn.
  const turnKeyRef = React.useRef<string | null>(null);
  const prevResetKeyRef = React.useRef<string | null | undefined>(undefined);
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

  // Row keys. The optimistic echo (`temp-…`) is replaced by the stored message
  // when the run starts — same text, same slot. Keyed as the echo was, the row is
  // not remounted: a remount replayed its entrance animation (the question blinked
  // out and back) and made the turn look new to the scroll logic.
  const rowKeyByIdRef = React.useRef(new Map<string, string>());
  const committedIdsRef = React.useRef<string[]>([]);
  const rowKeys = React.useMemo(() => {
    const keyById = rowKeyByIdRef.current;
    const previous = committedIdsRef.current;
    const ids = new Set(messages.map((m) => m.id));
    return messages.map((message, index) => {
      const known = keyById.get(message.id);
      if (known) return known;
      const before = previous[index];
      if (message.sender === "user" && before?.startsWith("temp-") && !ids.has(before)) {
        const key = keyById.get(before) ?? before;
        keyById.set(message.id, key);
        return key;
      }
      return message.id;
    });
  }, [messages]);
  React.useEffect(() => {
    committedIdsRef.current = messages.map((m) => m.id);
  }, [messages]);

  // The question the live reply answers, held near the top while it streams.
  const anchorMessageId = React.useMemo(
    () =>
      isStreaming
        ? findStreamAnchor(
            messages,
            activeRunAssistantMessageId ?? (thinkingState?.isActive ? streamingMessageId : null),
          )
        : null,
    [isStreaming, messages, activeRunAssistantMessageId, thinkingState?.isActive, streamingMessageId],
  );
  const anchorIndex = anchorMessageId ? messages.findIndex((m) => m.id === anchorMessageId) : -1;
  const turnKey = anchorIndex >= 0 ? rowKeys[anchorIndex] : null;

  // Measure the viewport + key content offsets in scroll coordinates. Layout
  // offsets (offsetTop within the column), not getBoundingClientRect: a row that
  // is still playing its entrance animation is translated, and measuring the
  // transform aimed the view a few px off, then corrected it — a visible tremble.
  // The real content bottom is read from messagesEndRef, which sits ABOVE the
  // streaming spacer, so it stays independent of the current spacer height.
  const measure = React.useCallback(() => {
    const viewport = viewportRef.current;
    const column = columnRef.current;
    if (!viewport || !column) return null;
    const H = viewport.clientHeight;
    const scrollTop = viewport.scrollTop;
    const columnTop =
      column.getBoundingClientRect().top - viewport.getBoundingClientRect().top + scrollTop;
    const endEl = messagesEndRef.current;
    const contentBottom = endEl ? columnTop + endEl.offsetTop : viewport.scrollHeight;
    let anchorTop: number | null = null;
    if (anchorMessageId) {
      const anchorEl = column.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchorMessageId)}"]`,
      );
      if (anchorEl) anchorTop = columnTop + anchorEl.offsetTop;
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
    velocityRef.current = 0;
  }, []);

  const writeScrollTop = React.useCallback((top: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = top;
    lastWrittenTopRef.current = top;
    lastKnownTopRef.current = top;
  }, []);

  const snapScrollTo = React.useCallback(
    (target: number) => {
      stopScrollAnim();
      targetScrollRef.current = Math.max(0, target);
      writeScrollTop(targetScrollRef.current);
    },
    [stopScrollAnim, writeScrollTop],
  );

  // Ride-along: a critically damped spring toward targetScrollRef. Retargeting is
  // just updating the ref — the running loop picks it up with its velocity intact,
  // so the motion stays continuous as the stream appends. Defers to a running glide.
  const springScrollTo = React.useCallback(
    (target: number) => {
      targetScrollRef.current = Math.max(0, target);
      if (prefersReducedMotion) {
        snapScrollTo(targetScrollRef.current);
        return;
      }
      if (animFrameRef.current !== null) return; // a glide or the spring is running — it picks up the target

      let lastTs: number | null = null;
      const step = (nowTs: number) => {
        const vp = viewportRef.current;
        if (!vp) {
          animFrameRef.current = null;
          return;
        }
        // Clamp the step (as the glide does) so a late frame or a backgrounded
        // tab never makes it leap.
        const dt = lastTs === null ? 1 / 60 : Math.min(MAX_FRAME_MS, nowTs - lastTs) / 1000;
        lastTs = nowTs;
        const target = targetScrollRef.current;
        // From where we last wrote, not vp.scrollTop: the browser rounds the scroll
        // offset to device pixels, and integrating from the rounded value stalls.
        const offset = lastWrittenTopRef.current - target;
        const v = velocityRef.current;
        if (Math.abs(offset) <= SETTLE_EPSILON && Math.abs(v) <= SETTLE_SPEED) {
          // Settled: write the exact target and stop. Critically we do NOT keep any
          // programmatic window alive here — so between tokens a real scrollbar or
          // keyboard move up is recognised immediately during the gap phase.
          writeScrollTop(target);
          velocityRef.current = 0;
          animFrameRef.current = null;
          return;
        }
        // Exact critically damped step: no overshoot, stable at any frame time.
        const w = FOLLOW_STIFFNESS;
        const decay = Math.exp(-w * dt);
        const drift = v + w * offset;
        writeScrollTop(target + (offset + drift * dt) * decay);
        velocityRef.current = (v - w * drift * dt) * decay;
        animFrameRef.current = window.requestAnimationFrame(step);
      };
      animFrameRef.current = window.requestAnimationFrame(step);
    },
    [prefersReducedMotion, snapScrollTo, writeScrollTop],
  );

  // Deliberate move: a FIXED-DURATION ease-in-out from the current position to the
  // target, starting and ending at rest. Owns the scroll (glidingRef) so ride-along
  // ticks don't fight it; when it lands, the spring takes over from rest if the
  // stream has moved the target meanwhile. Any user gesture calls stopScrollAnim().
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
      targetScrollRef.current = to;
      glidingRef.current = true;
      let elapsed = 0;
      let lastTs = window.performance.now();
      const step = (nowTs: number) => {
        if (!viewportRef.current) {
          animFrameRef.current = null;
          glidingRef.current = false;
          return;
        }
        // The glide's own clock advances at most a couple of frames per frame:
        // when a busy frame (the list re-rendering as the run starts) is late,
        // the move slows for a beat instead of leaping to catch up.
        elapsed += Math.min(MAX_FRAME_MS, Math.max(0, nowTs - lastTs));
        lastTs = nowTs;
        const t = Math.min(1, elapsed / durationMs);
        // easeInOutSine — soft at both ends, and an even pace between: a cubic's
        // peak speed (3x the average) read as a lurch mid-way on a long move.
        const eased = (1 - Math.cos(Math.PI * t)) / 2;
        writeScrollTop(from + (to - from) * eased);
        if (t < 1) {
          animFrameRef.current = window.requestAnimationFrame(step);
          return;
        }
        animFrameRef.current = null;
        glidingRef.current = false;
        if (Math.abs(targetScrollRef.current - to) >= 1) springScrollTo(targetScrollRef.current);
      };
      animFrameRef.current = window.requestAnimationFrame(step);
    },
    [prefersReducedMotion, stopScrollAnim, snapScrollTo, springScrollTo, writeScrollTop],
  );

  // Single source of truth for "keep the stream in view": sizes the spacer and moves
  // to the right target (streamScrollTarget). The mode picks the motion: "glide" /
  // "glideButton" for deliberate fixed-duration moves, "follow" for per-token
  // ride-along, "instant" for switches. Reduced motion takes the same spots instantly.
  const followTick = React.useCallback(
    (mode: ScrollMode) => {
      const viewport = viewportRef.current;
      const m = measure();
      if (!viewport || !m) return;

      let spacer = 0;
      let target: number;
      if (isStreaming) {
        ({ target, spacer } = streamScrollTarget({
          viewportHeight: m.H,
          scrollTop: m.scrollTop,
          // Where the view is heading, so a running move is never pulled back.
          heading: animFrameRef.current !== null ? targetScrollRef.current : m.scrollTop,
          contentBottom: m.contentBottom,
          anchorTop: m.anchorTop,
          // Only a deliberate move (the turn's glide, the button) goes back up.
          hold: mode === "follow",
        }));
      } else {
        target = m.contentBottom - m.H;
      }

      setSpacerHeight(spacer);
      setShowJumpToBottom(false);
      const to = Math.max(0, target);
      if (mode === "instant") {
        snapScrollTo(to);
      } else if (mode === "follow" || glidingRef.current) {
        // A running glide keeps the scroll; the spring takes the new target after it.
        if (glidingRef.current) targetScrollRef.current = to;
        else springScrollTo(to);
      } else {
        const distance = Math.abs(to - viewport.scrollTop);
        glideScrollTo(
          to,
          glideDuration(distance, mode === "glideButton" ? BUTTON_GLIDE : TURN_GLIDE),
        );
      }
    },
    [measure, isStreaming, setSpacerHeight, snapScrollTo, springScrollTo, glideScrollTo],
  );

  // The scheduled frame calls the LATEST followTick (its measurement closes over the
  // current anchor), not the one captured when the frame was requested.
  const followTickRef = React.useRef(followTick);
  followTickRef.current = followTick;
  // One measurement per frame however many requests land in it; the strongest
  // requested mode wins (MODE_PRIORITY).
  const scheduleFollow = React.useCallback((mode: ScrollMode = "follow") => {
    const pending = pendingModeRef.current;
    pendingModeRef.current =
      pending && MODE_PRIORITY[pending] > MODE_PRIORITY[mode] ? pending : mode;
    if (scrollFrameRef.current !== null) return; // already scheduled for this frame
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const resolved = pendingModeRef.current ?? "follow";
      pendingModeRef.current = null;
      followTickRef.current(resolved);
    });
  }, []);

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

  // We own the scroll position, so the browser's scroll anchoring must not also
  // adjust it when rows above the fold change size: its correction landed as an
  // unexplained jump and read as the user scrolling.
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.style.overflowAnchor = "none";
  }, []);

  // Conversation switch / initial load: reset to a clean pinned-at-bottom state
  // with no leftover spacer from a previous stream. Not when a new chat's first
  // message makes its conversation (no id -> the temporary shell "" -> the stored
  // id): that is the same screen, mid-send, and a reset would cut the move short.
  React.useEffect(() => {
    const previous = prevResetKeyRef.current;
    prevResetKeyRef.current = scrollResetKey;
    const sameNewChat =
      (previous === "" && Boolean(scrollResetKey)) ||
      ((previous === null || previous === undefined) && scrollResetKey === "");
    if (previous !== undefined && sameNewChat) return;
    stopScrollAnim();
    turnKeyRef.current = null;
    rowKeyByIdRef.current.clear();
    setIsPinnedToBottom(true);
    setShowJumpToBottom(false);
    setSpacerHeight(0);
    scheduleFollow("instant");
  }, [scrollResetKey, scheduleFollow, setSpacerHeight, stopScrollAnim]);

  // A new turn began (a send, a retry, an edit): re-pin and glide so the question
  // rises to the top with the answer area open below it. Keyed on the turn, not on
  // the reply's id, which changes once the run starts — one glide per turn.
  React.useEffect(() => {
    if (!isStreaming) {
      turnKeyRef.current = null;
      return;
    }
    if (!turnKey || turnKeyRef.current === turnKey) return;
    turnKeyRef.current = turnKey;
    suppressFollowRef.current = false;
    setIsPinnedToBottom(true);
    scheduleFollow("glide");
  }, [isStreaming, turnKey, scheduleFollow]);

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
    // toggle, …) — settling at the bottom is owned by the reset effect — we only
    // keep the jump button in sync.
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

  // Content shrinking under the view while a run streams — a retry's old answer
  // giving way to the new reply — would make the browser clamp the view up a
  // step before any follow could react. Before paint, the spacer takes up the
  // slack and the view stays where it was; the turn's glide then moves it.
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const spacerEl = bottomSpacerRef.current;
    if (!isStreaming || !viewport || !spacerEl) return;
    const m = measure();
    if (!m) return;
    const keep = lastKnownTopRef.current;
    const needed = keep + m.H - m.contentBottom;
    if (needed > (parseFloat(spacerEl.style.height) || 0)) setSpacerHeight(needed);
    if (viewport.scrollTop < keep - 1) writeScrollTop(keep);
  }, [messages, liveTimeline, isStreaming, measure, setSpacerHeight, writeScrollTop]);

  // Size changes that are not renders of this list — the composer shrinking back
  // to one line after a send, a window resize, an image or a diagram finishing its
  // layout — also move the target while streaming, so the follow re-measures.
  React.useEffect(() => {
    const viewport = viewportRef.current;
    const column = columnRef.current;
    if (!isStreaming || !isPinnedToBottom || !viewport || !column) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleFollow("follow"));
    observer.observe(viewport);
    observer.observe(column);
    return () => observer.disconnect();
  }, [isStreaming, isPinnedToBottom, scheduleFollow]);

  // Run finished: nothing moves. The spacer keeps exactly the room the view
  // needs where it is (and where a running move is heading); dropping it to 0
  // shortened the page under the view and the browser clamped it down a step.
  const wasStreamingRef = React.useRef(false);
  React.useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = Boolean(isStreaming);
    if (isStreaming || !wasStreaming) return;
    const m = measure();
    if (!m) return;
    const heading = animFrameRef.current !== null ? targetScrollRef.current : m.scrollTop;
    setSpacerHeight(Math.max(0, Math.max(m.scrollTop, heading) + m.H - m.contentBottom));
  }, [isStreaming, measure, setSpacerHeight]);

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
      lastKnownTopRef.current = cur;

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
        // Drifted back to the pinned position (near the actual scroll bottom) — re-attach;
        // the follow eases the rest of the way, then rides the stream again. Measuring
        // from the scroll bottom (not the content bottom) is what lets the user STAY
        // detached in the gap phase instead of being re-pinned the moment they stop
        // scrolling up.
        setIsPinnedToBottom(true);
      }
    },
    [distanceFromBottom, isPinnedToBottom, onScrolledPastTop, stopScrollAnim],
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
          className="relative w-full max-w-3xl mx-auto p-3 md:p-6 space-y-4 md:space-y-6 messages-container transition-smooth"
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
            messages.map((message, index) => {
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
                  key={rowKeys[index]}
                  data-message-id={message.id}
                  // `empty:hidden`: the live reply renders nothing before its
                  // first block, and its row then takes no room (or gap), so the
                  // answer starts where the thinking orb sits.
                  className="animate-message-in space-y-2 empty:hidden"
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
                  {compactingMessageId === message.id ? (
                    <CompactionDivider trigger="manual" status="running" />
                  ) : message.compaction && !message.compaction.undoneAt ? (
                    <CompactionDivider
                      trigger="manual"
                      status="done"
                      freed={message.compaction.freed}
                      tokensBefore={message.compaction.tokensBefore}
                      tokensAfter={message.compaction.tokensAfter}
                      summarizedMessages={message.compaction.summarizedMessages}
                      keptMessages={message.compaction.keptMessages}
                      summary={message.compaction.summary}
                    />
                  ) : null}
                </div>
              );
            })}

          <AiTransitionIndicator visible={showAiTransition} />

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
