import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import { ArrowLeft, ChevronRight, Network, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { EASE_ENTER, PANEL_TIMING, RADIX_MOTION } from "@/shared/lib/motion/panels";
import { Orb } from "@/shared/ui/orb";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { returnFocusOnlyForKeyboard } from "@/shared/lib/focus-return";
import {
  AGENT_MAP_ROOT_ID,
  answerItemId,
  type AgentMap,
  type AgentMapAnswer,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";
import { AgentMapTree } from "./AgentMapTree";
import { AgentMapDetail } from "./AgentMapDetail";

// The agent map's panel. On a desktop it floats above the composer, as wide as
// the composer, rising out of it; on a phone it is a bottom sheet. Modal (a
// Radix dialog): Esc or a click outside closes it, focus stays inside and goes
// back to the button only after keyboard use (shared/lib/focus-return). Two
// views slide sideways between each other — the tree, and one sub-agent's
// detail — with Esc and Back stepping out of the detail first. The tree's
// open branches, focused row and scroll position are kept while away.

const ANSWER_PAGE = 25;
const PANEL_GAP = 12;
const PANEL_MIN_HEIGHT = 300;
const PANEL_MAX_HEIGHT = 640;
// Room left above the panel for the header bar.
const HEADER_ROOM = 76;

const SLIDE: Variants = {
  enter: (direction: number) => ({ x: direction * 44, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { duration: 0.34, ease: EASE_ENTER } },
  exit: (direction: number) => ({
    x: direction * -44,
    opacity: 0,
    transition: { duration: 0.2, ease: "easeIn" },
  }),
};
const FADE: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

type View = { kind: "tree" } | { kind: "detail"; nodeId: string; trail: string[] };

type Placement = { left: number; width: number; bottom: number; height: number };

/** Above the composer the button sits in, as wide as it, as tall as fits. */
function placeAbove(anchor: HTMLElement | null): Placement | null {
  if (!anchor) return null;
  const shell = (anchor.closest(".composer-shell") as HTMLElement | null) ?? anchor;
  const rect = shell.getBoundingClientRect();
  const viewport = window.innerWidth;
  const width = Math.min(Math.max(rect.width, 480), viewport - 32);
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, 16),
    viewport - width - 16,
  );
  const room = rect.top - PANEL_GAP - HEADER_ROOM;
  const height = Math.min(Math.max(room, PANEL_MIN_HEIGHT), PANEL_MAX_HEIGHT);
  return { left, width, bottom: window.innerHeight - rect.top + PANEL_GAP, height };
}

/** A clock for running sub-agents' elapsed time; still while none runs. */
function useNow(ticking: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

type NodeEntry = { node: AgentMapNode; answer: AgentMapAnswer; ancestors: AgentMapNode[] };

function indexNodes(map: AgentMap): Map<string, NodeEntry> {
  const index = new Map<string, NodeEntry>();
  for (const answer of map.answers) {
    const visit = (nodes: AgentMapNode[], ancestors: AgentMapNode[]) => {
      for (const node of nodes) {
        index.set(node.id, { node, answer, ancestors });
        visit(node.children, [...ancestors, node]);
      }
    };
    visit(answer.nodes, []);
  }
  return index;
}

type AgentMapPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  map: AgentMap;
  agentName: string;
  /** The button the panel opens from; the panel sits above its composer. */
  anchorRef: React.RefObject<HTMLElement>;
};

export function AgentMapPanel({
  open,
  onOpenChange,
  map,
  agentName,
  anchorRef,
}: AgentMapPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const isMobile = useIsMobile();
  const [view, setView] = React.useState<View>({ kind: "tree" });
  const [direction, setDirection] = React.useState(1);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = React.useState(AGENT_MAP_ROOT_ID);
  const [answerLimit, setAnswerLimit] = React.useState(ANSWER_PAGE);
  const [revealed, setRevealed] = React.useState(false);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const treeScrollRef = React.useRef(0);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const now = useNow(open && map.runningCount > 0);

  const nodes = React.useMemo(() => indexNodes(map), [map]);
  const shownAnswers = React.useMemo(
    () => map.answers.slice(Math.max(map.answers.length - answerLimit, 0)),
    [map.answers, answerLimit],
  );
  const entry = view.kind === "detail" ? (nodes.get(view.nodeId) ?? null) : null;
  // The sub-agent left the branch (an edit, a switch): back to the tree.
  const showingDetail = view.kind === "detail" && entry !== null;

  React.useLayoutEffect(() => {
    if (!open || isMobile) return;
    const place = () => setPlacement(placeAbove(anchorRef.current));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, isMobile, anchorRef]);

  // Closing resets to the tree; the open branches and scroll stay for next time.
  // After the panel has left, so it keeps its view while it fades out.
  React.useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(
      () => {
        setView({ kind: "tree" });
        setDirection(1);
        setRevealed(false);
      },
      Math.max(PANEL_TIMING.panel.exit, PANEL_TIMING.sheet.exit) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [open]);

  // Each view, once it has slid in, takes the focus: the tree its active row,
  // the detail its Back button — the element that was clicked is gone.
  const focusView = React.useCallback(() => {
    const root = contentRef.current;
    if (!root) return;
    const target =
      root.querySelector<HTMLElement>(
        '[data-agent-map-view="current"] [role="treeitem"][tabindex="0"]',
      ) ??
      root.querySelector<HTMLElement>("[data-agent-map-back]") ??
      root.querySelector<HTMLElement>('[data-agent-map-view="current"]');
    target?.focus({ preventScroll: true });
  }, []);

  const openNode = (nodeId: string) => {
    setDirection(1);
    setView((current) => ({
      kind: "detail",
      nodeId,
      trail: current.kind === "detail" ? [...current.trail, current.nodeId] : [],
    }));
  };

  const showTree = (focus?: string) => {
    if (focus) setFocusedId(focus);
    setDirection(-1);
    setView({ kind: "tree" });
  };

  const back = () => {
    if (view.kind !== "detail") return;
    const previous = view.trail[view.trail.length - 1];
    if (previous && nodes.has(previous)) {
      setDirection(-1);
      setView({ kind: "detail", nodeId: previous, trail: view.trail.slice(0, -1) });
    } else {
      showTree(view.nodeId);
    }
  };

  // Breadcrumb jump to a sub-agent above this one.
  const jumpTo = (nodeId: string) => {
    if (view.kind !== "detail") return;
    const at = view.trail.indexOf(nodeId);
    setDirection(-1);
    setView({
      kind: "detail",
      nodeId,
      trail: at >= 0 ? view.trail.slice(0, at) : [],
    });
  };

  const toggle = React.useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const variants = reduceMotion ? FADE : SLIDE;
  const desktopStyle: React.CSSProperties | undefined =
    !isMobile && placement
      ? {
          left: placement.left,
          width: placement.width,
          bottom: placement.bottom,
          // Nothing to map: a calm, shorter card.
          height: map.answers.length ? placement.height : Math.min(placement.height, 380),
        }
      : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Appears and leaves with the shared panel motion (shared/lib/motion/panels):
            a panel on a desktop, a bottom sheet on a phone. */}
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[92]",
            isMobile ? "bg-black/45" : "bg-[hsl(var(--background)/0.35)] backdrop-blur-[2px]",
            RADIX_MOTION.backdrop,
          )}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(focusView);
          }}
          onCloseAutoFocus={returnFocusOnlyForKeyboard}
          onEscapeKeyDown={(event) => {
            if (view.kind === "detail") {
              event.preventDefault();
              back();
            }
          }}
          style={desktopStyle}
          className={cn(
            "fixed z-[92] flex flex-col overflow-hidden border border-border/70 bg-card text-card-foreground focus:outline-none",
            "shadow-[0_28px_70px_-24px_hsl(var(--foreground)/0.35),0_2px_8px_hsl(var(--foreground)/0.06)]",
            isMobile
              ? cn(
                  "inset-x-0 bottom-0 h-[85dvh] rounded-t-[1.5rem] border-b-0",
                  RADIX_MOTION.sheet.bottom,
                )
              : cn("rounded-[1.5rem]", RADIX_MOTION.panel),
            !isMobile && !placement && "invisible",
          )}
          // The tree's rows cascade in once the panel has settled (children's
          // own animations bubble here too, hence the target check).
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setRevealed(true);
          }}
        >
          {/* A wash of the brand colour along the top edge. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/[0.07] to-transparent" />
          {isMobile ? (
            <div className="relative mx-auto mt-2.5 h-1 w-10 flex-shrink-0 rounded-full bg-muted-foreground/25" />
          ) : null}

          <PanelHeader
            view={view}
            entry={showingDetail ? entry : null}
            map={map}
            nodes={nodes}
            onBack={back}
            onShowTree={showTree}
            onJump={jumpTo}
            onClose={() => onOpenChange(false)}
            reduceMotion={reduceMotion}
          />

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence initial={false} custom={direction}>
              {showingDetail && entry ? (
                <ScrollView
                  key={`detail:${entry.node.id}`}
                  variants={variants}
                  direction={direction}
                  onEntered={focusView}
                >
                  <AgentMapDetail
                    node={entry.node}
                    answer={entry.answer}
                    ancestors={entry.ancestors}
                    agentName={agentName}
                    onOpenNode={openNode}
                    now={now}
                  />
                </ScrollView>
              ) : (
                <ScrollView
                  key="tree"
                  variants={variants}
                  direction={direction}
                  initialScrollTop={treeScrollRef.current}
                  onScrollTop={(top) => (treeScrollRef.current = top)}
                  onEntered={focusView}
                >
                  {map.answers.length ? (
                    <AgentMapTree
                      map={map}
                      agentName={agentName}
                      answers={shownAnswers}
                      hiddenAnswers={map.answers.length - shownAnswers.length}
                      onShowEarlier={() => setAnswerLimit((limit) => limit + ANSWER_PAGE)}
                      collapsed={collapsed}
                      onToggle={toggle}
                      onOpenNode={openNode}
                      focusedId={focusedId}
                      onFocusChange={setFocusedId}
                      reveal={!revealed}
                      now={now}
                    />
                  ) : (
                    <EmptyState agentName={agentName} />
                  )}
                </ScrollView>
              )}
            </AnimatePresence>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** One view's scroll area; it slides in and out with the view. */
function ScrollView({
  variants,
  direction,
  initialScrollTop = 0,
  onScrollTop,
  onEntered,
  children,
}: {
  variants: Variants;
  direction: number;
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
  onEntered?: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current && initialScrollTop) ref.current.scrollTop = initialScrollTop;
    // Restore once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <motion.div
      ref={ref}
      custom={direction}
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      data-agent-map-view="current"
      tabIndex={-1}
      onAnimationComplete={(definition) => {
        if (definition === "center") onEntered?.();
      }}
      onScroll={onScrollTop ? (event) => onScrollTop(event.currentTarget.scrollTop) : undefined}
      className="scrollbar-muted absolute inset-0 overflow-y-auto overscroll-contain px-4 pb-4 pt-1 focus:outline-none sm:px-5"
    >
      {children}
    </motion.div>
  );
}

function PanelHeader({
  view,
  entry,
  map,
  nodes,
  onBack,
  onShowTree,
  onJump,
  onClose,
  reduceMotion,
}: {
  view: View;
  entry: NodeEntry | null;
  map: AgentMap;
  nodes: Map<string, NodeEntry>;
  onBack: () => void;
  onShowTree: (focus?: string) => void;
  onJump: (nodeId: string) => void;
  onClose: () => void;
  reduceMotion: boolean;
}) {
  const detail = view.kind === "detail" && entry !== null;
  const crumb =
    "min-w-0 truncate rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70";
  return (
    <div className="relative flex h-16 flex-shrink-0 items-center gap-3 px-4 sm:px-5">
      <AnimatePresence initial={false} mode="popLayout">
        {detail && entry ? (
          <motion.div
            key="detail"
            className="flex min-w-0 flex-1 items-center gap-2"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.28, ease: EASE_ENTER } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            <button
              type="button"
              data-agent-map-back
              onClick={onBack}
              aria-label="Back"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground transition-[background-color,color,transform] hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </button>
            <DialogPrimitive.Title className="sr-only">
              Agent map: {entry.node.title}
            </DialogPrimitive.Title>
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-0.5 text-[13px]">
                <li className="flex min-w-0 flex-shrink-0 items-center">
                  <button type="button" className={crumb} onClick={() => onShowTree()}>
                    Agent map
                  </button>
                </li>
                <Separator />
                <li className="flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    className={cn(crumb, "tabular-nums")}
                    onClick={() => onShowTree(answerItemId(entry.answer))}
                  >
                    Q{entry.answer.number}
                  </button>
                </li>
                {entry.ancestors.map((ancestor) => (
                  <React.Fragment key={ancestor.id}>
                    <Separator />
                    <li className="flex min-w-0 items-center">
                      <button
                        type="button"
                        className={crumb}
                        onClick={() =>
                          nodes.has(ancestor.id) ? onJump(ancestor.id) : onShowTree()
                        }
                      >
                        {ancestor.title}
                      </button>
                    </li>
                  </React.Fragment>
                ))}
                <Separator />
                <li className="flex min-w-0 items-center">
                  <span
                    aria-current="page"
                    className="min-w-0 truncate px-1.5 py-0.5 font-semibold text-foreground"
                  >
                    {entry.node.title}
                  </span>
                </li>
              </ol>
            </nav>
          </motion.div>
        ) : (
          <motion.div
            key="tree"
            className="flex min-w-0 flex-1 items-center gap-3"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.28, ease: EASE_ENTER } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary">
              <Network className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight tracking-tight text-foreground">
                Agent map
              </DialogPrimitive.Title>
              <p className="truncate text-xs text-muted-foreground tabular-nums">
                {map.subagentCount
                  ? `${map.subagentCount} sub-agent${map.subagentCount === 1 ? "" : "s"} across this conversation`
                  : "Who worked on this conversation"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close agent map"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function Separator() {
  return (
    <li role="presentation" aria-hidden className="flex flex-shrink-0 items-center">
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
    </li>
  );
}

function EmptyState({ agentName }: { agentName: string }) {
  return (
    <div className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-4 px-6 text-center">
      <Orb size={64} state="idle" />
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-semibold text-foreground">No sub-agents yet</p>
        <p className="text-sm leading-6 text-muted-foreground">
          When {agentName} hands part of an answer to a sub-agent, it appears here, with any
          sub-agents that one brings in.
        </p>
      </div>
    </div>
  );
}
