import "@xyflow/react/dist/style.css";
import "@/styles/agent-map-flow.css";
import "@/styles/agent-builder-flow.css";

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
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
import { AlertTriangle, Bot, Copy, Layers, Plus, Trash2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { AgentDraft } from "@/shared/lib/types";
import {
  GHOST_ID,
  buildBuilderFlow,
  neighbourOf,
  type BuilderEdgeData,
  type BuilderFlowEdge,
  type BuilderFlowNode,
  type BuilderGhostNode,
  type BuilderNodeData,
  type BuilderRootNode,
  type BuilderSubagentNode,
} from "@/features/agents/lib/builderFlow";
import { ROOT_UID } from "@/features/agents/lib/agentIssues";

// The builder's canvas: the agent and its team as a graph to build on (lazy:
// this module, React Flow and its stylesheet load when the builder opens).
// Laid out by lib/builderFlow — no dragging, every position comes from the
// tree — and styled by the theme (styles/agent-map-flow.css, whose canvas it
// shares with the agent map, and styles/agent-builder-flow.css).
//
// A node is picked by click, or by keyboard: Tab or the arrows between nodes,
// Enter to move into the inspector, Delete to remove (with a confirm). Its
// actions — duplicate, delete, and the + that adds a sub-agent under it — come
// up on hover, focus or selection. It fits the tree on open and whenever a node
// arrives or leaves.

const FIT_VIEW = { padding: 0.1, minZoom: 0.3, maxZoom: 1 };
const FIT_DURATION = 360;

export type BuilderCanvasProps = {
  draft: AgentDraft;
  selectedUid: string;
  /** A model id as a label. */
  modelLabel: (id: string) => string;
  issueCounts: ReadonlyMap<string, number>;
  errorNodes: ReadonlySet<string>;
  /** The import result's preview: pick a node to read it, nothing to change. */
  readOnly?: boolean;
  onSelect: (uid: string) => void;
  onAddChild?: (parentUid: string) => void;
  onDuplicate?: (uid: string) => void;
  /** `keyboard` when it came from the Delete key, which always confirms first. */
  onDelete?: (uid: string, options: { keyboard: boolean }) => void;
  /** Enter on a node: move into the inspector. */
  onActivate?: (uid: string) => void;
  /** Bumped to bring a node into view (an issue picked from the list). */
  reveal?: { uid: string; at: number } | null;
  /** Changed when the canvas itself changes size (the phone's sheet opening): fit again. */
  refit?: string | null;
  /** The canvas's accessible name. */
  label?: string;
};

type CanvasActions = Pick<
  BuilderCanvasProps,
  "onSelect" | "onAddChild" | "onDuplicate" | "onDelete"
>;
const ActionsContext = React.createContext<CanvasActions>({ onSelect: () => {} });

// Edges need a handle at each end; nothing is joined by hand, so they stay hidden.
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="agent-map-flow-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="agent-map-flow-handle" />
    </>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function IssueBadge({ count, error }: { count: number; error: boolean }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        "flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums",
        error
          ? "bg-destructive/12 text-destructive"
          : "bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]",
      )}
      title={plural(count, "issue")}
    >
      <AlertTriangle className="h-3 w-3" aria-hidden />
      {count}
    </span>
  );
}

/** Stop a click on a node's own control from also picking (or panning) the node. */
const own = (event: React.SyntheticEvent) => event.stopPropagation();

const ACTION_BUTTON =
  "nodrag nopan flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/** Duplicate and delete, floating above a sub-agent's card. */
function NodeToolbar({ data }: { data: BuilderNodeData }) {
  const { onDuplicate, onDelete } = React.useContext(ActionsContext);
  const name = data.name.trim() || "this sub-agent";
  return (
    <div className="agent-builder-reveal absolute -top-3.5 right-3 z-10 flex items-center gap-0.5 rounded-full border border-border/70 bg-card px-0.5 py-0.5 shadow-[0_6px_16px_-10px_hsl(var(--foreground)/0.4)]">
      <button
        type="button"
        className={ACTION_BUTTON}
        aria-label={`Duplicate ${name}`}
        title="Duplicate"
        onClick={(event) => {
          own(event);
          onDuplicate?.(data.uid);
        }}
      >
        <Copy className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        className={cn(ACTION_BUTTON, "hover:text-destructive")}
        aria-label={`Delete ${name}`}
        title="Delete"
        onClick={(event) => {
          own(event);
          onDelete?.(data.uid, { keyboard: false });
        }}
      >
        <Trash2 className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

/** The + under a node — or, at the third level, why there is none. */
function AddUnder({ data }: { data: BuilderNodeData }) {
  const { onAddChild } = React.useContext(ActionsContext);
  if (data.canAdd) {
    const name = data.name.trim() || (data.depth ? "this sub-agent" : "the agent");
    return (
      <button
        type="button"
        className="agent-builder-reveal nodrag nopan absolute -bottom-3 left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-primary/40 bg-card text-primary shadow-[0_4px_12px_-6px_hsl(var(--primary)/0.6)] transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        aria-label={`Add a sub-agent under ${name}`}
        title="Add a sub-agent"
        onClick={(event) => {
          own(event);
          onAddChild?.(data.uid);
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="agent-builder-reveal nodrag nopan absolute -bottom-2.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-border/70 bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label="Level 3 of 3: no sub-agents below this one"
          onClick={own}
        >
          <Layers className="h-2.5 w-2.5" aria-hidden />3 of 3 levels
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[16rem] text-xs leading-relaxed">
        Three levels is the most. A sub-agent this deep does its work itself — it can&apos;t have a
        team of its own.
      </TooltipContent>
    </Tooltip>
  );
}

function RootNode({ data }: NodeProps<BuilderRootNode>) {
  const Glyph = mapIcon(data.icon || "Bot");
  const meta = [
    data.model,
    data.tools ? plural(data.tools as number, "tool") : "built-in tools",
    data.childCount ? plural(data.childCount, "sub-agent") : null,
  ].filter(Boolean);
  return (
    <>
      <div
        className="agent-builder-node group/node relative h-full w-full"
        data-selected={data.selected ? "true" : "false"}
        data-errors={data.hasErrors ? "true" : "false"}
      >
        <div className="agent-map-flow-card agent-builder-card relative flex h-full items-center gap-3 overflow-hidden rounded-[1.15rem] border border-border/70 bg-card px-3.5">
          <span className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-primary/[0.07] to-transparent" />
          <span className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
            <Glyph className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="relative min-w-0 flex-1">
            <span className="block text-[9.5px] font-semibold uppercase tracking-[0.16em] text-primary/80">
              Main agent
            </span>
            <span
              className={cn(
                "block truncate text-[14px] font-semibold tracking-tight",
                data.name.trim() ? "text-foreground" : "italic text-muted-foreground",
              )}
            >
              {data.name.trim() || "Untitled agent"}
            </span>
            <span className="block truncate text-[11px] tabular-nums text-muted-foreground">
              {meta.join(" · ")}
            </span>
          </span>
          <span className="relative self-start pt-2.5">
            <IssueBadge count={data.issueCount} error={data.hasErrors} />
          </span>
        </div>
        {data.readOnly ? null : <AddUnder data={data} />}
      </div>
      <Handles />
    </>
  );
}

function SubagentNode({ data }: NodeProps<BuilderSubagentNode>) {
  const meta = [
    data.model,
    data.tools === "inherit" ? "inherits tools" : plural(data.tools, "tool"),
    data.childCount ? plural(data.childCount, "sub-agent") : null,
  ].filter(Boolean);
  return (
    <>
      <div
        className="agent-builder-node group/node relative h-full w-full"
        data-selected={data.selected ? "true" : "false"}
        data-errors={data.hasErrors ? "true" : "false"}
      >
        <div
          className={cn(
            "agent-map-flow-card agent-builder-card relative flex h-full flex-col justify-center gap-1 overflow-hidden rounded-[1.05rem] border border-border/70 px-3",
            "bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.6)_100%)]",
          )}
        >
          <span className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-gradient-to-b from-primary/[0.05] to-transparent" />
          <span className="relative flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/[0.1] text-primary">
              <Bot className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] font-semibold",
                data.name.trim() ? "text-foreground" : "font-medium italic text-muted-foreground",
              )}
            >
              {data.name.trim() || "Unnamed sub-agent"}
            </span>
            <IssueBadge count={data.issueCount} error={data.hasErrors} />
          </span>
          <span className="relative block truncate pl-8 text-[11px] tabular-nums text-muted-foreground">
            {meta.join(" · ")}
          </span>
        </div>
        {data.readOnly ? null : (
          <>
            <NodeToolbar data={data} />
            <AddUnder data={data} />
          </>
        )}
      </div>
      <Handles />
    </>
  );
}

/** "Add a sub-agent", under an agent with no team yet. */
function GhostNode({ data }: NodeProps<BuilderGhostNode>) {
  const { onAddChild } = React.useContext(ActionsContext);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="agent-builder-ghost nodrag nopan flex h-full w-full items-center justify-center gap-2 rounded-[1.05rem] border border-dashed border-primary/40 bg-primary/[0.03] text-[13px] font-medium text-primary/85 hover:border-primary/60 hover:bg-primary/[0.07] hover:text-primary"
        onClick={(event) => {
          own(event);
          onAddChild?.(data.parentUid);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add a sub-agent
      </button>
      <Handles />
    </>
  );
}

const NODE_TYPES: NodeTypes = {
  builderRoot: RootNode,
  builderSubagent: SubagentNode,
  builderGhost: GhostNode,
};

/** A parent → child edge between the layout's anchors, its corners rounded. */
function BuilderEdge({ data, style }: EdgeProps<BuilderFlowEdge>) {
  if (!data) return null;
  const { from, to } = data as BuilderEdgeData;
  const [path] = getSmoothStepPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: Position.Bottom,
    targetX: to.x,
    targetY: to.y,
    targetPosition: Position.Top,
    borderRadius: 16,
    offset: 0,
  });
  return <BaseEdge path={path} style={style} interactionWidth={0} />;
}

const EDGE_TYPES: EdgeTypes = { builderEdge: BuilderEdge };

const ARIA_LABELS = {
  "node.a11yDescription.default":
    "Arrow keys move between agents, Enter edits the one in focus, Delete removes it.",
  "node.a11yDescription.keyboardDisabled": "Arrow keys move between agents.",
  "controls.ariaLabel": "Zoom controls",
};

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function Canvas({
  draft,
  selectedUid,
  modelLabel,
  issueCounts,
  errorNodes,
  readOnly = false,
  onSelect,
  onAddChild,
  onDuplicate,
  onDelete,
  onActivate,
  reveal,
  refit = null,
  label = "Agent and its team",
}: BuilderCanvasProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { fitView, getViewport, setCenter } = useReactFlow();
  const duration = reduceMotion ? 0 : FIT_DURATION;
  const containerRef = React.useRef<HTMLDivElement>(null);

  const flow = React.useMemo(
    () =>
      buildBuilderFlow(draft, {
        modelLabel,
        issueCounts,
        errorNodes,
        selectedUid,
        readOnly,
      }),
    [draft, modelLabel, issueCounts, errorNodes, selectedUid, readOnly],
  );
  const actions = React.useMemo<CanvasActions>(
    () => ({ onSelect, onAddChild, onDuplicate, onDelete }),
    [onSelect, onAddChild, onDuplicate, onDelete],
  );

  // Fit again whenever a node arrives or leaves; an edit inside a node keeps
  // the user's pan and zoom.
  const count = flow.nodes.length;
  const fitted = React.useRef(count);
  React.useEffect(() => {
    if (count === fitted.current) return;
    fitted.current = count;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ ...FIT_VIEW, duration });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [count, duration, fitView]);

  // The canvas resized under the tree (the sheet's height animates): fit once it settles.
  const refitted = React.useRef(refit);
  React.useEffect(() => {
    if (refit === refitted.current) return;
    refitted.current = refit;
    const timer = window.setTimeout(() => void fitView({ ...FIT_VIEW, duration }), reduceMotion ? 0 : 320);
    return () => window.clearTimeout(timer);
  }, [refit, duration, fitView, reduceMotion]);

  // Bring a node into view when asked (an issue picked from the list), at
  // the current zoom, only if it is not on screen already.
  React.useEffect(() => {
    if (!reveal) return;
    const node = flow.nodes.find((n) => n.id === reveal.uid);
    const element = containerRef.current;
    if (!node || !element) return;
    const { x, y, zoom } = getViewport();
    const left = node.position.x * zoom + x;
    const top = node.position.y * zoom + y;
    const right = left + (node.width ?? 0) * zoom;
    const bottom = top + (node.height ?? 0) * zoom;
    if (left >= 0 && top >= 0 && right <= element.clientWidth && bottom <= element.clientHeight) {
      return;
    }
    void setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: Math.max(zoom, 0.7), duration },
    );
    // Only when asked: `at` changes with each request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.at]);

  const focusNode = (id: string) => {
    const element = containerRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"]`,
    );
    element?.focus();
  };

  const idFromEvent = (event: React.SyntheticEvent): string | null => {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains("react-flow__node")) return null;
    return target.getAttribute("data-id");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const id = idFromEvent(event);
    if (!id) return;
    if (id === GHOST_ID) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onAddChild?.(ROOT_UID);
      }
      return;
    }
    if (ARROWS.has(event.key)) {
      const next = neighbourOf(flow, id, event.key as "ArrowUp");
      event.preventDefault();
      if (next) {
        onSelect(next);
        focusNode(next);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      onSelect(id);
      onActivate?.(id);
    } else if ((event.key === "Delete" || event.key === "Backspace") && !readOnly) {
      if (id === ROOT_UID) return;
      event.preventDefault();
      onDelete?.(id, { keyboard: true });
    }
  };

  // Keyboard focus picks the node, so Tab through the tree keeps the inspector
  // in step; a click picks it through onNodeClick.
  const onFocus = (event: React.FocusEvent) => {
    const id = idFromEvent(event);
    if (!id || id === GHOST_ID) return;
    let visible = true;
    try {
      visible = (event.target as HTMLElement).matches(":focus-visible");
    } catch {
      // An engine without :focus-visible: treat focus as the keyboard's.
    }
    if (visible) onSelect(id);
  };

  return (
    <ActionsContext.Provider value={actions}>
      <div
        ref={containerRef}
        className="h-full w-full"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <ReactFlow<BuilderFlowNode, BuilderFlowEdge>
          className="agent-map-flow agent-builder-flow"
          aria-label={label}
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeClick={(_, node) => {
            if (node.id === GHOST_ID) onAddChild?.(ROOT_UID);
            else onSelect(node.id);
          }}
          fitView
          fitViewOptions={FIT_VIEW}
          minZoom={0.25}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          autoPanOnNodeFocus
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
        </ReactFlow>
      </div>
    </ActionsContext.Provider>
  );
}

/** The builder's canvas; default export for React.lazy. */
export default function BuilderCanvas(props: BuilderCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
