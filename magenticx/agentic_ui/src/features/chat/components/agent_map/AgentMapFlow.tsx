import "@xyflow/react/dist/style.css";
import "@/styles/agent-map-flow.css";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
  type EdgeTypes,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { useReducedMotion } from "framer-motion";
import { Bot, History, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Orb } from "@/shared/ui/orb";
import {
  agentNodeDuration,
  answerItemId,
  type AgentMap,
  type AgentMapAnswer,
} from "@/features/chat/lib/agentMap";
import {
  answerFlowNodeIds,
  buildAgentMapFlow,
  flowFrameNodeIds,
  plural,
  previewText,
  questionPreview,
  TASK_PREVIEW_LENGTH,
  type AgentFlowAnswerNode,
  type AgentFlowEdge,
  type AgentFlowNode,
  type AgentFlowSavedView,
  type AgentFlowRootNode,
  type AgentFlowSubagentNode,
} from "@/features/chat/lib/agentMapFlow";
import { STATUS_META } from "@/features/chat/components/message_parts/subagentStatus";

// The agent map's flow view: the tree view's map as a top-down graph, drawn
// with React Flow (lazy: this module, the library and its stylesheet load
// the first time the flow view shows). Laid out by lib/agentMapFlow — the main
// agent on top, its answers under it (a Q label each, on the edge), their
// sub-agents below — and styled by the theme (styles/agent-map-flow.css).
// Pan and zoom, no dragging or joining. Hover or keyboard focus shows a tip
// above a node: an answer's question, a sub-agent's instructions.
// A sub-agent opens the same detail as in the tree, by click or by Enter on
// its focused node; an answer (or the main agent) frames its own branch (or
// the whole map). It fits itself on open and again when a node arrives or
// leaves — a live run's sub-agent starting — but not on every status change.

const FIT_VIEW = { padding: 0.12, minZoom: 0.3, maxZoom: 1 };
const FIT_DURATION = 320;

type FlowContextValue = { now: number };
const FlowContext = React.createContext<FlowContextValue>({ now: 0 });

const normalizeName = (value: string) => value.toLowerCase().replace(/[-_\s]+/g, "");

// Edges need a handle at each end; the graph is read-only, so they stay hidden.
function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="agent-map-flow-handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="agent-map-flow-handle"
      />
    </>
  );
}

function RootFlowNode({ data }: NodeProps<AgentFlowRootNode>) {
  return (
    <>
      <div className="agent-map-flow-card flex h-full w-full items-center gap-3 rounded-2xl border border-border/70 bg-card px-3">
        <Orb size={34} state={data.runningCount ? "thinking" : "idle"} className="flex-shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-foreground">
            {data.agentName}
          </p>
          <p className="truncate text-[11px] text-muted-foreground tabular-nums">
            Main agent · {data.subagentCount} sub-agent{data.subagentCount === 1 ? "" : "s"}
            {data.runningCount ? (
              <span className="text-[hsl(var(--subagent-active))]">
                {" "}
                · {data.runningCount} working
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <Handles />
    </>
  );
}

/**
 * An answer: only its label (Q1) on the edge, no card — lit while it is live.
 * Its question shows in the hover tip (FlowTip); the node's aria-label
 * carries the whole question.
 */
function AnswerFlowNode({ data }: NodeProps<AgentFlowAnswerNode>) {
  const { answer } = data;
  return (
    <>
      <div className="flex h-full w-full items-center justify-center">
        <span
          className={cn(
            "text-xs font-semibold leading-none tabular-nums",
            answer.live ? "text-[hsl(var(--subagent-active))]" : "text-primary",
          )}
        >
          Q{answer.number}
        </span>
      </div>
      <Handles />
    </>
  );
}

/** The tree's sub-agent card (AgentNodeCard), compact: two lines in a box. */
function SubagentFlowNode({ data }: NodeProps<AgentFlowSubagentNode>) {
  const { now } = React.useContext(FlowContext);
  const { node } = data;
  const meta = node.status ? STATUS_META[node.status] : null;
  const active = node.status === "running";
  const duration = agentNodeDuration(node, now);
  const showType = Boolean(node.type && normalizeName(node.type) !== normalizeName(node.title));
  return (
    <>
      <div
        className="subagent-card group/node h-full w-full rounded-2xl"
        data-active={active ? "true" : "false"}
      >
        <div
          className={cn(
            "agent-map-flow-card relative flex h-full flex-col justify-center gap-1 overflow-hidden rounded-2xl border px-3",
            "bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.6)_100%)]",
            "transition-[border-color,box-shadow] duration-200 supports-[hover:hover]:group-hover/node:border-primary/40",
            active ? "border-transparent" : "border-border/70",
          )}
        >
          <span className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-gradient-to-b from-primary/[0.05] to-transparent" />
          <span className="relative flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full",
                active
                  ? "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]"
                  : "bg-primary/[0.1] text-primary",
              )}
            >
              <Bot className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
              {node.title}
            </span>
          </span>
          <span className="relative flex min-w-0 items-center gap-2 pl-8 text-[11px] tabular-nums text-muted-foreground">
            {showType ? (
              <span className="min-w-0 truncate text-[9px] font-medium uppercase tracking-[0.14em] text-primary/80">
                {node.type}
              </span>
            ) : null}
            {node.toolCount ? (
              <span
                className="flex flex-shrink-0 items-center gap-1"
                title={`${node.toolCount} tool call${node.toolCount === 1 ? "" : "s"}`}
              >
                <Wrench className="h-2.5 w-2.5" aria-hidden />
                {node.toolCount}
              </span>
            ) : null}
            {duration ? <span className="flex-shrink-0">{duration}</span> : null}
            {!showType && !node.toolCount && !duration && node.task ? (
              <span className="min-w-0 truncate">{node.task}</span>
            ) : null}
            {meta ? (
              <span
                className={cn(
                  "ml-auto flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10.5px] font-medium",
                  meta.chip,
                )}
              >
                {meta.icon}
                {meta.label}
              </span>
            ) : null}
          </span>
        </div>
      </div>
      <Handles />
    </>
  );
}

const NODE_TYPES: NodeTypes = {
  agentRoot: RootFlowNode,
  agentAnswer: AnswerFlowNode,
  agentSubagent: SubagentFlowNode,
};

/**
 * A parent → child edge, between the layout's anchors (lib/agentMapFlow):
 * straight down to a child right under its parent, else one split halfway
 * down the gap, its corners rounded (no `offset` stub, which would leave the
 * bends a pixel or two to round in).
 */
function AgentEdge({ data, style, markerEnd }: EdgeProps<AgentFlowEdge>) {
  if (!data) return null;
  const [path] = getSmoothStepPath({
    sourceX: data.from.x,
    sourceY: data.from.y,
    sourcePosition: Position.Bottom,
    targetX: data.to.x,
    targetY: data.to.y,
    targetPosition: Position.Top,
    borderRadius: 14,
    offset: 0,
  });
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} interactionWidth={0} />;
}

const EDGE_TYPES: EdgeTypes = { agentEdge: AgentEdge };

// ------------------------------------------------------
// The hover tip
// ------------------------------------------------------

type FlowTipContent = { caption?: string; text: string; detail?: string };

/** What a node's tip says: an answer's question, a sub-agent's instructions. */
function tipFor(node: AgentFlowNode): FlowTipContent | null {
  if (node.type === "agentAnswer") {
    const { answer } = node.data;
    return {
      text: questionPreview(answer.question),
      detail: plural(answer.subagentCount, "sub-agent"),
    };
  }
  if (node.type === "agentSubagent" && node.data.node.task) {
    return { caption: "Instructions", text: previewText(node.data.node.task, TASK_PREVIEW_LENGTH) };
  }
  return null;
}

const TIP_GAP = 8;
const TIP_MARGIN = 8;

/**
 * A node's tip, above it — below when there is no room — drawn in a portal at
 * the screen's size: never clipped by the canvas, readable at any zoom, and
 * transparent to the pointer so it never gets in the way of a pan. Hidden from
 * screen readers: the node's aria-label already says the whole text.
 */
function FlowTip({ anchor, content }: { anchor: DOMRect; content: FlowTipContent }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const above = anchor.top - TIP_GAP - height >= TIP_MARGIN;
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - width / 2, TIP_MARGIN),
      window.innerWidth - width - TIP_MARGIN,
    );
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(above ? anchor.top - TIP_GAP - height : anchor.bottom + TIP_GAP)}px`;
    element.dataset.side = above ? "top" : "bottom";
  }, [anchor, content]);
  return createPortal(
    <div ref={ref} className="agent-map-flow-tip" aria-hidden>
      {content.caption ? (
        <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {content.caption}
        </span>
      ) : null}
      <span className="block">{content.text}</span>
      {content.detail ? (
        <span className="block tabular-nums text-muted-foreground">{content.detail}</span>
      ) : null}
    </div>,
    document.body,
  );
}

const ARIA_LABELS = {
  "node.a11yDescription.default":
    "Press Enter to open a sub-agent, or to frame an answer's branch.",
  "node.a11yDescription.keyboardDisabled": "Press Enter to open a sub-agent.",
  "controls.ariaLabel": "Zoom controls",
};

export type AgentMapFlowProps = {
  map: AgentMap;
  agentName: string;
  /** The answers shown (the latest ones; earlier ones behind "Show earlier"). */
  answers: AgentMapAnswer[];
  hiddenAnswers: number;
  onShowEarlier: () => void;
  onOpenNode: (id: string) => void;
  onFocusChange: (id: string) => void;
  now: number;
  /** Where the user left the view (pan, zoom), to come back to after a detail. */
  savedView?: AgentFlowSavedView | null;
  onViewChange?: (view: AgentFlowSavedView) => void;
};

function FlowCanvas({
  map,
  agentName,
  answers,
  hiddenAnswers,
  onShowEarlier,
  onOpenNode,
  onFocusChange,
  now,
  savedView,
  onViewChange,
}: AgentMapFlowProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { fitView } = useReactFlow();
  const { nodes, edges } = React.useMemo(
    () => buildAgentMapFlow(map, { agentName, answers, animate: !reduceMotion }),
    [map, agentName, answers, reduceMotion],
  );
  const answerById = React.useMemo(
    () => new Map(answers.map((answer) => [answerItemId(answer), answer])),
    [answers],
  );
  const context = React.useMemo(() => ({ now }), [now]);
  const duration = reduceMotion ? 0 : FIT_DURATION;
  const containerRef = React.useRef<HTMLDivElement>(null);

  // What to frame, for the canvas's size now: the whole map, or — when that
  // would shrink the cards past reading — the main agent and the latest branch.
  const frameOptions = () => {
    const element = containerRef.current;
    const viewport = { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 };
    const ids = flowFrameNodeIds({ nodes, edges }, answers, viewport, FIT_VIEW.padding);
    return { ...FIT_VIEW, nodes: ids?.map((id) => ({ id })) };
  };

  // Back from a sub-agent's detail with the same nodes: where the user left it.
  const [restore] = React.useState(() =>
    savedView && savedView.count === nodes.length ? savedView : null,
  );

  // The canvas is measured before React Flow mounts (a layout effect, before
  // the first paint), so its first fit is already the right one.
  const [initialFit, setInitialFit] = React.useState<ReturnType<typeof frameOptions> | null>(null);
  React.useLayoutEffect(() => {
    setInitialFit(frameOptions());
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Then again only when the node count changes (a sub-agent starting, earlier
  // answers shown): a status flipping keeps the user's pan and zoom.
  const count = nodes.length;
  const fittedCount = React.useRef(count);
  React.useEffect(() => {
    if (count === fittedCount.current) return;
    fittedCount.current = count;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ ...frameOptions(), duration });
    });
    return () => window.cancelAnimationFrame(frame);
    // frameOptions reads the nodes this count belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, duration, fitView]);

  const activate = (node: AgentFlowNode) => {
    setTip(null);
    onFocusChange(node.id);
    if (node.type === "agentSubagent") {
      onOpenNode(node.id);
      return;
    }
    const answer = node.type === "agentAnswer" ? answerById.get(node.id) : undefined;
    void fitView({
      ...FIT_VIEW,
      duration,
      nodes: answer ? answerFlowNodeIds(answer).map((id) => ({ id })) : undefined,
    });
  };

  // The tip of the node under the pointer or the keyboard focus, anchored
  // to where that node is on screen now; a pan or zoom hides it.
  const [tip, setTip] = React.useState<{ anchor: DOMRect; content: FlowTipContent } | null>(null);
  const showTip = (node: AgentFlowNode, element: Element) => {
    const content = tipFor(node);
    setTip(content ? { anchor: element.getBoundingClientRect(), content } : null);
  };
  const hideTip = () => setTip(null);

  const nodeFromEvent = (event: React.SyntheticEvent) => {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains("react-flow__node")) return null;
    const id = target.getAttribute("data-id");
    return nodes.find((node) => node.id === id) ?? null;
  };

  // A tip on keyboard focus, not on the focus a click leaves behind.
  const focusVisible = (element: HTMLElement) => {
    try {
      return element.matches(":focus-visible");
    } catch {
      return true;
    }
  };

  return (
    <FlowContext.Provider value={context}>
      <div
        ref={containerRef}
        className="h-full w-full"
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const node = nodeFromEvent(event);
          if (!node) return;
          event.preventDefault();
          activate(node);
        }}
        onFocus={(event) => {
          const node = nodeFromEvent(event);
          if (!node) return;
          onFocusChange(node.id);
          if (focusVisible(event.target)) showTip(node, event.target);
        }}
        onBlur={(event) => {
          if (nodeFromEvent(event)) hideTip();
        }}
      >
        {initialFit ? (
          <ReactFlow<AgentFlowNode, AgentFlowEdge>
            className="agent-map-flow"
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodeClick={(_, node) => activate(node)}
            onNodeMouseEnter={(event, node) => showTip(node, event.currentTarget)}
            onNodeMouseLeave={hideTip}
            onMoveStart={hideTip}
            fitView={!restore}
            fitViewOptions={initialFit}
            defaultViewport={
              restore ? { x: restore.x, y: restore.y, zoom: restore.zoom } : undefined
            }
            onMoveEnd={(_, viewport) => onViewChange?.({ ...viewport, count: nodes.length })}
            minZoom={0.2}
            maxZoom={1.75}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            ariaLabelConfig={ARIA_LABELS}
            // MIT licensed; the attribution stays (React Flow asks that only
            // Pro subscribers remove it), restyled to sit quietly in a corner.
            proOptions={{ hideAttribution: false }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1.2}
              className="agent-map-flow-background"
            />
            <Controls
              position="bottom-left"
              showInteractive={false}
              fitViewOptions={{ ...FIT_VIEW, duration }}
              className="agent-map-flow-controls"
            />
            {hiddenAnswers > 0 ? (
              <Panel position="top-left">
                <button
                  type="button"
                  onClick={onShowEarlier}
                  className="flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-3 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                >
                  <History className="h-3.5 w-3.5" aria-hidden />
                  Show {hiddenAnswers} earlier answer{hiddenAnswers === 1 ? "" : "s"}
                </button>
              </Panel>
            ) : null}
          </ReactFlow>
        ) : null}
        {tip ? <FlowTip anchor={tip.anchor} content={tip.content} /> : null}
      </div>
    </FlowContext.Provider>
  );
}

/** The flow view; default export for React.lazy. */
export default function AgentMapFlow(props: AgentMapFlowProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
