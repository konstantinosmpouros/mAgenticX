import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import { ArrowLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { EASE_ENTER, PANEL_TIMING } from "@/shared/lib/motion/panels";
import { AgentMapIcon } from "@/shared/ui/agent-map-icon";
import { Orb } from "@/shared/ui/orb";
import {
  AGENT_MAP_ROOT_ID,
  answerItemId,
  type AgentMap,
  type AgentMapAnswer,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";
import type { AgentFlowSavedView } from "@/features/chat/lib/agentMapFlow";
import { useAgentMapView, type AgentMapViewMode } from "@/features/chat/hooks/useAgentMapView";
import { AgentMapTree } from "./AgentMapTree";
import { AgentMapDetail } from "./AgentMapDetail";
import { AgentMapViewSwitch } from "./AgentMapViewSwitch";
import { ComposerPanel } from "../ComposerPanel";

// The agent map's panel, in the composer panels' shell (../ComposerPanel):
// above the composer on a desktop, a bottom sheet on a phone, modal. Two
// views slide sideways between each other — the map, and one sub-agent's
// detail — with Esc and Back stepping out of the detail first. The map is the
// tree or the flow graph (the header's switch, remembered per browser); the
// two cross-fade. The tree's open branches, focused row and scroll position
// are kept while away.

const ANSWER_PAGE = 25;

// The flow view brings React Flow along: its own chunk, fetched the first time
// it shows (or the switch is hovered).
const loadAgentMapFlow = () => import("./AgentMapFlow");
const AgentMapFlow = React.lazy(loadAgentMapFlow);

/** How a view comes and goes: sideways (into a detail and out), or a cross-fade (tree and flow). */
type ViewMotion = { direction: number; fade: boolean };

const SLIDE: Variants = {
  enter: ({ direction, fade }: ViewMotion) =>
    fade ? { x: 0, opacity: 0 } : { x: direction * 44, opacity: 0 },
  center: { x: 0, opacity: 1, transition: { duration: 0.34, ease: EASE_ENTER } },
  exit: ({ direction, fade }: ViewMotion) =>
    fade
      ? { x: 0, opacity: 0, transition: { duration: 0.22, ease: "easeOut" } }
      : { x: direction * -44, opacity: 0, transition: { duration: 0.2, ease: "easeIn" } },
};
const FADE: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

type View = { kind: "tree" } | { kind: "detail"; nodeId: string; trail: string[] };

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
  const [view, setView] = React.useState<View>({ kind: "tree" });
  const [mode, setMode] = useAgentMapView();
  const [viewMotion, setViewMotion] = React.useState<ViewMotion>({ direction: 1, fade: false });
  const setDirection = (direction: number) => setViewMotion({ direction, fade: false });
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = React.useState(AGENT_MAP_ROOT_ID);
  const [answerLimit, setAnswerLimit] = React.useState(ANSWER_PAGE);
  const [revealed, setRevealed] = React.useState(false);
  const treeScrollRef = React.useRef(0);
  const flowViewRef = React.useRef<AgentFlowSavedView | null>(null);
  const focusedRef = React.useRef(focusedId);
  focusedRef.current = focusedId;
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

  // Closing resets to the map (tree or flow, as chosen); the open branches and
  // scroll stay for next time. After the panel has left, so it keeps its view
  // while it fades out.
  React.useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(
      () => {
        setView({ kind: "tree" });
        setViewMotion({ direction: 1, fade: false });
        setRevealed(false);
      },
      Math.max(PANEL_TIMING.panel.exit, PANEL_TIMING.sheet.exit) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [open]);

  // Each view, once it has slid in, takes the focus: the tree its active row,
  // the flow the node last focused, the detail its Back button — the element
  // that was clicked is gone. Not after the view switch changed the view: the
  // focus stays on the switch.
  const focusView = React.useCallback(() => {
    const root = contentRef.current;
    if (!root) return;
    if (document.activeElement?.closest("[data-agent-map-switch]")) return;
    const flowNode =
      typeof CSS !== "undefined" && CSS.escape
        ? `[data-agent-map-view="current"] .react-flow__node[data-id="${CSS.escape(focusedRef.current)}"]`
        : null;
    const target =
      root.querySelector<HTMLElement>(
        '[data-agent-map-view="current"] [role="treeitem"][tabindex="0"]',
      ) ??
      (flowNode ? root.querySelector<HTMLElement>(flowNode) : null) ??
      root.querySelector<HTMLElement>("[data-agent-map-back]") ??
      root.querySelector<HTMLElement>('[data-agent-map-view="current"]');
    target?.focus({ preventScroll: true });
  }, []);

  const changeMode = (next: AgentMapViewMode) => {
    if (next === mode) return;
    setViewMotion((current) => ({ ...current, fade: true }));
    setMode(next);
  };

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
  // Nothing to map: the empty state, whichever view is chosen.
  const showFlow = mode === "flow" && map.answers.length > 0;

  return (
    <ComposerPanel
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      // Nothing to map: a calm, shorter card.
      compact={!map.answers.length}
      contentRef={contentRef}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        window.requestAnimationFrame(focusView);
      }}
      onEscapeKeyDown={(event) => {
        if (view.kind === "detail") {
          event.preventDefault();
          back();
        }
      }}
      // The tree's rows cascade in once the panel has settled.
      onEntered={() => setRevealed(true)}
    >
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
        mode={mode}
        onModeChange={changeMode}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} custom={viewMotion}>
          {showingDetail && entry ? (
            <ScrollView
              key={`detail:${entry.node.id}`}
              variants={variants}
              motion={viewMotion}
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
          ) : showFlow ? (
            <ScrollView
              key="flow"
              variants={variants}
              motion={viewMotion}
              bare
              onEntered={focusView}
            >
              <React.Suspense fallback={<FlowLoading />}>
                <AgentMapFlow
                  map={map}
                  agentName={agentName}
                  answers={shownAnswers}
                  hiddenAnswers={map.answers.length - shownAnswers.length}
                  onShowEarlier={() => setAnswerLimit((limit) => limit + ANSWER_PAGE)}
                  onOpenNode={openNode}
                  onFocusChange={setFocusedId}
                  now={now}
                  savedView={flowViewRef.current}
                  onViewChange={(saved) => (flowViewRef.current = saved)}
                />
              </React.Suspense>
            </ScrollView>
          ) : (
            <ScrollView
              key="tree"
              variants={variants}
              motion={viewMotion}
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
    </ComposerPanel>
  );
}

/** One view's scroll area (`bare`: a plain fill); it slides in and out with the view. */
function ScrollView({
  variants,
  motion: viewMotion,
  bare = false,
  initialScrollTop = 0,
  onScrollTop,
  onEntered,
  children,
}: {
  variants: Variants;
  motion: ViewMotion;
  bare?: boolean;
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
      custom={viewMotion}
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
      className={cn(
        "absolute inset-0 focus:outline-none",
        !bare && "scrollbar-muted overflow-y-auto overscroll-contain px-4 pb-4 pt-1 sm:px-5",
      )}
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
  mode,
  onModeChange,
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
  mode: AgentMapViewMode;
  onModeChange: (mode: AgentMapViewMode) => void;
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
              <AgentMapIcon className="h-4 w-4" />
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
            {map.answers.length ? (
              <AgentMapViewSwitch
                value={mode}
                onChange={onModeChange}
                onPreload={() => void loadAgentMapFlow()}
                className="ml-auto"
              />
            ) : null}
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

/** While the flow view's chunk loads (the first time only). */
function FlowLoading() {
  return (
    <div role="status" className="flex h-full items-center justify-center">
      <span
        aria-hidden
        className="h-5 w-5 rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/70 motion-safe:animate-spin"
      />
      <span className="sr-only">Loading the flow view</span>
    </div>
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
