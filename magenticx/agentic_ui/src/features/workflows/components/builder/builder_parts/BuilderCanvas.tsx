import "@xyflow/react/dist/style.css";
import "@/styles/agent-map-flow.css";
import "@/styles/workflow-flow.css";

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { useReducedMotion } from "framer-motion";
import { Eraser, LayoutGrid, Shapes, Undo2 } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type {
  WorkflowBuilderSelection,
  WorkflowCanvasMenu,
  WorkflowNodeKindInfo,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";
import type { WorkflowFlowEdge, WorkflowFlowNode } from "@/features/workflows/lib/graph";
import { NODE_CARD, WORKFLOW_EDGE_TYPE, WORKFLOW_NODE_TYPE } from "@/features/workflows/lib/nodeCard";
import { GRAPH_FIT_VIEW, graphFitView } from "@/features/workflows/lib/consts";
import { BAR_SECONDARY, PALETTE_DRAG_TYPE, PALETTE_MOTION } from "@/features/workflows/lib/builder/consts";
import { nodeLabel } from "@/features/workflows/lib/kinds";
import { SNAP_GRID } from "@/features/workflows/lib/builder/draft";
import { reuseUnchangedFlow, specToFlow } from "@/features/workflows/lib/builder/flow";
import { canConnect } from "@/features/workflows/lib/builder/graph";
import { WorkflowEdge } from "../../workflow_parts/WorkflowEdge";
import { WorkflowNodeCard } from "../../workflow_parts/WorkflowNodeCard";
import { CanvasContextMenu } from "./CanvasContextMenu";

// The builder's canvas (lazy: this module, React Flow and its stylesheets load
// when the builder opens): the draft drawn with the shared node card and edge
// in edit mode, on the agent builder's dotted canvas. Drag a step to move it
// (snapped to the grid), drag from a branch's handle to another step's left
// handle to connect them (checked as you go: no self, duplicate or second
// edge on a branch, nothing into the trigger, cycles only through a loop's
// `continue`), click or Shift-drag to select, Backspace / Delete to remove,
// pan and zoom freely. Every change goes back to the builder as a draft action.

const NODE_TYPES: NodeTypes = { [WORKFLOW_NODE_TYPE]: WorkflowNodeCard };
const EDGE_TYPES: EdgeTypes = { [WORKFLOW_EDGE_TYPE]: WorkflowEdge };
const DELETE_KEYS = ["Backspace", "Delete"];
/** A window resize frames again once it has stopped for this long (ms). */
const RESIZE_FIT_DEBOUNCE_MS = 200;
/**
 * Just after it opens the canvas is still settling (the builder's focus mode
 * folding the app sidebar away): a size change in this window (ms) frames the
 * graph again once it stops, as part of the first load.
 */
const FIRST_LOAD_SETTLE_MS = 1000;
/**
 * A canvas edge or size change smaller than this (px) is rounding, not a
 * panel or the window moving: the view is left alone (no sub-pixel nudges).
 */
const RESIZE_EPSILON_PX = 0.5;

const ARIA_LABELS = {
  "node.a11yDescription.default":
    "Enter edits this step. Arrow keys move it. Backspace or Delete removes it.",
  "node.a11yDescription.keyboardDisabled": "Enter edits this step.",
  "controls.ariaLabel": "Zoom controls",
};

export type BuilderCanvasProps = {
  spec: WorkflowSpec;
  catalog: readonly WorkflowNodeKindInfo[];
  issueCounts: ReadonlyMap<string, number>;
  errorNodes: ReadonlySet<string>;
  selection: WorkflowBuilderSelection;
  onSelectionChange: (selection: WorkflowBuilderSelection) => void;
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (connection: { source: string; target: string; branch: string | null }) => void;
  /** A connection dropped where it may not go: why. */
  onRefused: (reason: string) => void;
  onRemove: (nodeIds: string[], edgeIds: string[]) => void;
  /** A palette item dropped on the canvas, at this flow position (the card's top-left). */
  onDropKind: (kind: string, position: { x: number; y: number }) => void;
  /** Enter on a focused step: into the inspector. */
  onActivate: (nodeId: string) => void;
  onTidy: () => void;
  /** Right-click → Duplicate on a step. */
  onDuplicate: (nodeId: string) => void;
  /** Right-click → Clear canvas (the builder asks first). */
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Open the step palette (right-click → Add a step, the empty canvas's button). */
  onOpenPalette: () => void;
  /**
   * A phone: no right-click menu (a long press drags); its actions sit with
   * the zoom controls instead.
   */
  mobile?: boolean;
  /** Bumped to frame the whole graph again (after Tidy up). */
  fitSignal: number;
  /** Bumped to bring a step into view (an issue picked, a step opened). */
  reveal: { nodeId: string; at: number } | null;
  /**
   * How much of the canvas's right edge the inspector drawer covers (px):
   * framing (Tidy up, the fit-view control) and reveal keep clear of it. The
   * drawer is an overlay: a change here never moves the graph by itself.
   */
  rightInset?: number;
  /**
   * How much of the canvas's left edge the expanded step palette covers (px).
   * The palette is an overlay too: the canvas never changes size when it
   * folds or opens, so the graph never moves; only the framing keeps clear of
   * it, and the canvas's own controls (Tidy up, zoom) slide out from under it.
   */
  leftInset?: number;
  /** The saved workflow's live schedule: the schedule trigger's card shows its next run. */
  savedSchedule?: WorkflowSchedule | null;
};

function Canvas({
  spec,
  catalog,
  issueCounts,
  errorNodes,
  selection,
  onSelectionChange,
  onMove,
  onConnect,
  onRefused,
  onRemove,
  onDropKind,
  onActivate,
  onTidy,
  onDuplicate,
  onClear,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onOpenPalette,
  mobile = false,
  fitSignal,
  reveal,
  rightInset = 0,
  leftInset = 0,
  savedSchedule = null,
}: BuilderCanvasProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { fitView, screenToFlowPosition, getViewport, setCenter, setViewport } = useReactFlow();
  const duration = reduceMotion ? 0 : 300;
  const durationRef = React.useRef(duration);
  durationRef.current = duration;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fitOptions = React.useMemo(() => graphFitView(rightInset, leftInset), [rightInset, leftInset]);
  // The first framing's options: fixed at mount (a later palette or drawer
  // toggle must not hand React Flow new options, nor re-frame).
  const [initialFit] = React.useState(() => (leftInset ? graphFitView(0, leftInset) : GRAPH_FIT_VIEW));
  // The latest framing and inset, for callbacks that outlive a render (resize, timers).
  const fitOptionsRef = React.useRef(fitOptions);
  fitOptionsRef.current = fitOptions;
  const rightInsetRef = React.useRef(rightInset);
  rightInsetRef.current = rightInset;
  const leftInsetRef = React.useRef(leftInset);
  leftInsetRef.current = leftInset;
  // True while the view is the builder's own framing: nothing the user panned
  // or zoomed to is lost by framing again on a window resize.
  const autoFit = React.useRef(true);

  // The builder's handlers change with every draft (they close over it): read
  // through refs, so the cards' delete action and React Flow's connection
  // checks stay the same functions and a keystroke changes no card by itself.
  const latest = React.useRef({ spec, catalog, onRemove, onRefused });
  latest.current = { spec, catalog, onRemove, onRefused };
  const removeNode = React.useCallback((nodeId: string) => latest.current.onRemove([nodeId], []), []);
  // React Flow's SelectionListener re-emits its current selection whenever this
  // handler changes identity (it is in its effect's deps). An inline handler
  // did that on every render: a step added while another was picked had React
  // Flow, one render behind, hand the old pick back, then the new one, back
  // and forth, and the inspector swapped (and faded) on every bounce. Stable,
  // it reports only a selection that actually changed.
  const selectionHandler = React.useRef(onSelectionChange);
  selectionHandler.current = onSelectionChange;
  const emitSelection = React.useCallback(
    ({ nodes: picked, edges: pickedEdges }: { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] }) =>
      selectionHandler.current({ nodes: picked.map((node) => node.id), edges: pickedEdges.map((edge) => edge.id) }),
    [],
  );
  const removeEdge = React.useCallback((edgeId: string) => latest.current.onRemove([], [edgeId]), []);
  const previousFlow = React.useRef<{ nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } | null>(null);
  const flow = React.useMemo(() => {
    const next = reuseUnchangedFlow(
      previousFlow.current,
      specToFlow(spec, {
        catalog,
        issueCounts,
        errorNodes,
        selection,
        onDeleteNode: removeNode,
        onDeleteEdge: removeEdge,
        savedSchedule,
      }),
    );
    previousFlow.current = next;
    return next;
  }, [spec, catalog, issueCounts, errorNodes, selection, removeNode, removeEdge, savedSchedule]);

  // React Flow edits its own copy while a drag is under way; the draft is
  // written when a move settles. A new draft replaces the copy, except where a
  // node is mid-drag (its position is the pointer's until it is let go). A
  // node whose card did not change keeps its copy as it is (the same object),
  // so React Flow re-adopts and re-renders only the cards that changed.
  const [nodes, setNodes] = React.useState<WorkflowFlowNode[]>(flow.nodes);
  const [edges, setEdges] = React.useState<WorkflowFlowEdge[]>(flow.edges);
  const adoptedNodes = React.useRef(flow.nodes);
  React.useEffect(() => {
    const before = new Map(adoptedNodes.current.map((node) => [node.id, node]));
    adoptedNodes.current = flow.nodes;
    setNodes((previous) => {
      const copies = new Map(previous.map((node) => [node.id, node]));
      let changed = previous.length !== flow.nodes.length;
      const next = flow.nodes.map((node, index) => {
        const copy = copies.get(node.id);
        if (!copy) {
          changed = true;
          return node;
        }
        if (before.get(node.id) === node) {
          if (previous[index] !== copy) changed = true;
          return copy;
        }
        changed = true;
        return {
          ...node,
          ...(copy.measured ? { measured: copy.measured } : {}),
          ...(copy.dragging ? { position: copy.position, dragging: true } : {}),
        };
      });
      return changed ? next : previous;
    });
  }, [flow.nodes]);
  React.useEffect(() => setEdges(flow.edges), [flow.edges]);

  const onNodesChange = React.useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      // Removal goes through onDelete → the draft; the copy follows the draft.
      const kept = changes.filter((change) => change.type !== "remove");
      setNodes((current) => applyNodeChanges(kept, current));
      const settled: Record<string, { x: number; y: number }> = {};
      for (const change of kept) {
        if (change.type === "position" && change.position && !change.dragging) {
          settled[change.id] = change.position;
        }
      }
      if (Object.keys(settled).length) onMove(settled);
    },
    [onMove],
  );
  const onEdgesChange = React.useCallback((changes: EdgeChange<WorkflowFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes.filter((change) => change.type !== "remove"), current));
  }, []);

  const toConnection = (connection: Connection | Edge) => ({
    source: connection.source,
    target: connection.target,
    branch: connection.sourceHandle ?? null,
  });

  const isValidConnection = React.useCallback(
    (connection: Connection | Edge) =>
      canConnect(latest.current.spec, latest.current.catalog, toConnection(connection)).ok,
    [],
  );

  const onConnectEnd = React.useCallback((_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || !state.toNode || !state.fromHandle) return;
    // Dragged from a target handle: the other end is the source.
    const fromTarget = state.fromHandle.type === "target";
    const check = canConnect(latest.current.spec, latest.current.catalog, {
      source: fromTarget ? state.toNode.id : state.fromNode.id,
      target: fromTarget ? state.fromNode.id : state.toNode.id,
      branch: (fromTarget ? state.toHandle?.id : state.fromHandle.id) ?? null,
    });
    if (!check.ok) latest.current.onRefused(check.reason);
  }, []);

  // Frame again on request (Tidy up): the builder's framing from here on.
  const fitted = React.useRef(fitSignal);
  React.useEffect(() => {
    if (fitSignal === fitted.current) return;
    fitted.current = fitSignal;
    autoFit.current = true;
    const frame = window.requestAnimationFrame(() => void fitView({ ...fitOptions, duration }));
    return () => window.cancelAnimationFrame(frame);
  }, [fitSignal, duration, fitView, fitOptions]);

  // The canvas changed size: the app sidebar toggled (its edge moved), or the
  // window resized (the palette and the drawer are overlays: they never resize
  // it). The graph stays where it is on screen: the view shifts by however far
  // the canvas's edge moved, in the same frame, so nothing slides with a
  // panel. Only a real size change counts: the observer's first call, a
  // sub-pixel rounding, or a box that moved without resizing (nothing a field,
  // a tooltip or a popover does) never touches the view. Framing again is kept
  // for the first load (the canvas still settling) and a window resize, once
  // either stops, and only while the view is the builder's own.
  const openedAt = React.useRef(0);
  // The view calls, for a long-lived observer (never torn down by a render).
  const viewApi = React.useRef({ fitView, getViewport, setViewport });
  viewApi.current = { fitView, getViewport, setViewport };
  React.useEffect(() => {
    openedAt.current = Date.now();
  }, []);
  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let fitTimer = 0;
    const fitWhenSettled = () => {
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        if (autoFit.current) void viewApi.current.fitView({ ...fitOptionsRef.current, duration: durationRef.current });
      }, RESIZE_FIT_DEBOUNCE_MS);
    };
    let last = element.getBoundingClientRect();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        const box = element.getBoundingClientRect();
        // Hidden (display: none, a collapsed parent): nothing to keep in place;
        // the baseline waits for the canvas to show again.
        if (!box.width || !box.height) return;
        const resized =
          Math.abs(box.width - last.width) >= RESIZE_EPSILON_PX ||
          Math.abs(box.height - last.height) >= RESIZE_EPSILON_PX;
        if (!resized) return;
        const dx = Math.abs(box.left - last.left) >= RESIZE_EPSILON_PX ? box.left - last.left : 0;
        const dy = Math.abs(box.top - last.top) >= RESIZE_EPSILON_PX ? box.top - last.top : 0;
        const wasShown = last.width > 0 && last.height > 0;
        last = box;
        if (wasShown && (dx || dy)) {
          const view = viewApi.current.getViewport();
          void viewApi.current.setViewport({ x: view.x - dx, y: view.y - dy, zoom: view.zoom }, { duration: 0 });
        }
        if (Date.now() - openedAt.current < FIRST_LOAD_SETTLE_MS) fitWhenSettled();
      });
      observer.observe(element);
    }
    window.addEventListener("resize", fitWhenSettled);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitWhenSettled);
      window.clearTimeout(fitTimer);
    };
  }, []);

  // Bring a step into view when asked, only if it is off screen.
  const revealIfHidden = React.useCallback(
    (nodeId: string) => {
      const node = spec.nodes.find((entry) => entry.id === nodeId);
      const element = containerRef.current;
      if (!node || !element) return;
      const inset = rightInsetRef.current;
      const leftCover = Math.min(leftInsetRef.current, element.clientWidth / 2);
      const { x, y, zoom } = getViewport();
      const left = node.position.x * zoom + x;
      const top = node.position.y * zoom + y;
      // What the drawer (and the expanded palette) leave of the canvas.
      const visibleWidth = Math.max(element.clientWidth - inset, NODE_CARD.width);
      if (
        left >= leftCover &&
        top >= 0 &&
        left + NODE_CARD.width * zoom <= visibleWidth &&
        top + NODE_CARD.headerHeight * zoom <= element.clientHeight
      ) {
        return;
      }
      const nextZoom = Math.max(zoom, 0.8);
      // A view the framing would undo: the next resize or toggle leaves it be.
      autoFit.current = false;
      // Centre it in the visible part: the flow point shifts by half of what
      // covers each edge (right: the drawer; left: the expanded palette).
      void setCenter(
        node.position.x + NODE_CARD.width / 2 + (Math.min(inset, element.clientWidth / 2) - leftCover) / 2 / nextZoom,
        node.position.y + NODE_CARD.headerHeight / 2,
        { zoom: nextZoom, duration },
      );
    },
    [spec.nodes, getViewport, setCenter, duration],
  );
  const revealRef = React.useRef(revealIfHidden);
  revealRef.current = revealIfHidden;
  const revealAt = reveal?.at;
  const revealId = reveal?.nodeId;
  // The builder asks once the drawer has finished opening: one move, never per frame.
  React.useEffect(() => {
    if (revealId) revealRef.current(revealId);
  }, [revealAt, revealId]);

  // The canvas's own controls step out from under the expanded palette, in
  // step with its width (transform only; the graph itself never moves).
  const coverShift = React.useMemo<React.CSSProperties>(
    () => ({
      transform: `translateX(${Math.round(leftInset)}px)`,
      transition: reduceMotion ? "none" : `transform ${PALETTE_MOTION.durationMs}ms ${PALETTE_MOTION.cssEase}`,
    }),
    [leftInset, reduceMotion],
  );

  // ---- the right-click menu (desktop) ----
  // Two steps: the menu's anchor moves to the pointer first, and the menu opens
  // a frame later, once the anchor is there. Opened in the same render, the
  // menu was measured against the anchor's old place and flashed at the
  // canvas's top-left corner before jumping to the pointer.
  const [menu, setMenu] = React.useState<WorkflowCanvasMenu | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuFrame = React.useRef(0);
  React.useEffect(() => () => window.cancelAnimationFrame(menuFrame.current), []);
  const openMenu = React.useCallback(
    (event: React.MouseEvent | MouseEvent, target: WorkflowCanvasMenu["target"]) => {
      if (mobile) return;
      event.preventDefault();
      const box = containerRef.current?.getBoundingClientRect();
      window.cancelAnimationFrame(menuFrame.current);
      setMenuOpen(false);
      setMenu({ x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), target });
      menuFrame.current = window.requestAnimationFrame(() => setMenuOpen(true));
    },
    [mobile],
  );
  const closeMenu = React.useCallback(() => {
    window.cancelAnimationFrame(menuFrame.current);
    setMenuOpen(false);
  }, []);
  const fitAll = React.useCallback(() => {
    autoFit.current = true;
    void fitView({ ...fitOptionsRef.current, duration: durationRef.current });
  }, [fitView]);
  const menuActions = {
    openPalette: onOpenPalette,
    tidy: onTidy,
    fit: fitAll,
    selectAll: () =>
      onSelectionChange({ nodes: spec.nodes.map((node) => node.id), edges: spec.edges.map((edge) => edge.id) }),
    undo: onUndo,
    redo: onRedo,
    canUndo,
    canRedo,
    clear: onClear,
    isEmpty: spec.nodes.length === 0,
    editNode: (nodeId: string) => {
      onSelectionChange({ nodes: [nodeId], edges: [] });
      onActivate(nodeId);
    },
    duplicateNode: onDuplicate,
    remove: onRemove,
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      data-testid="workflow-canvas"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        const kind = event.dataTransfer.getData(PALETTE_DRAG_TYPE);
        if (!kind) return;
        event.preventDefault();
        const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        onDropKind(kind, { x: point.x - NODE_CARD.width / 2, y: point.y - NODE_CARD.headerHeight / 2 });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        const target = event.target as HTMLElement;
        if (!target.classList?.contains("react-flow__node")) return;
        const id = target.getAttribute("data-id");
        if (!id) return;
        event.preventDefault();
        onSelectionChange({ nodes: [id], edges: [] });
        onActivate(id);
      }}
    >
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        className="agent-map-flow workflow-flow workflow-builder-flow"
        aria-label="Workflow canvas"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={emitSelection}
        onConnect={(connection) => onConnect(toConnection(connection))}
        onPaneContextMenu={(event) => openMenu(event, { type: "pane" })}
        onNodeContextMenu={(event, node) => {
          const def = spec.nodes.find((entry) => entry.id === node.id);
          openMenu(event, { type: "node", id: node.id, label: nodeLabel(def, node.id) });
        }}
        onEdgeContextMenu={(event, edge) => openMenu(event, { type: "edge", id: edge.id })}
        onSelectionContextMenu={(event, picked) =>
          openMenu(event, { type: "selection", nodeIds: picked.map((node) => node.id), edgeIds: selection.edges })
        }
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onDelete={({ nodes: gone, edges: goneEdges }) =>
          onRemove(
            gone.map((node) => node.id),
            goneEdges.map((edge) => edge.id),
          )
        }
        connectionLineType={ConnectionLineType.Bezier}
        connectionRadius={28}
        deleteKeyCode={DELETE_KEYS}
        // Dragging a step moves it and nothing else: only a click picks it
        // (and opens the inspector); a click on the empty canvas drops the pick.
        selectNodesOnDrag={false}
        snapToGrid
        snapGrid={SNAP_GRID}
        fitView
        // The first framing only: stable, so a drawer or palette toggle changes nothing here.
        fitViewOptions={initialFit}
        onMoveStart={(event) => {
          // A pan or zoom by the user (programmatic moves carry no event).
          if (event) autoFit.current = false;
        }}
        minZoom={0.2}
        maxZoom={1.75}
        zoomOnDoubleClick={false}
        elevateEdgesOnSelect
        ariaLabelConfig={ARIA_LABELS}
        // MIT licensed; the attribution stays (React Flow asks that only Pro
        // subscribers remove it), restyled to sit quietly in a corner.
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={SNAP_GRID[0]} size={1.2} className="agent-map-flow-background" />
        <Controls
          position="bottom-left"
          showInteractive={false}
          fitViewOptions={{ ...fitOptions, duration }}
          onZoomIn={() => {
            autoFit.current = false;
          }}
          onZoomOut={() => {
            autoFit.current = false;
          }}
          onFitView={() => {
            autoFit.current = true;
          }}
          className="agent-map-flow-controls"
          style={coverShift}
        >
          {/* A phone has no right-click: the graph's actions sit with the zoom. */}
          {mobile ? (
            <>
              <ControlButton onClick={onTidy} title="Tidy up: line the steps up" aria-label="Tidy up" disabled={!spec.nodes.length}>
                <LayoutGrid aria-hidden />
              </ControlButton>
              <ControlButton onClick={onUndo} title="Undo" aria-label="Undo" disabled={!canUndo}>
                <Undo2 aria-hidden />
              </ControlButton>
              <ControlButton onClick={onClear} title="Clear the canvas" aria-label="Clear the canvas" disabled={!spec.nodes.length}>
                <Eraser aria-hidden />
              </ControlButton>
            </>
          ) : null}
        </Controls>
      </ReactFlow>
      {spec.nodes.length === 0 ? (
        // An empty canvas says where a workflow begins; it lies over the
        // canvas without taking its clicks or drops.
        <div
          className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-6"
          style={{ paddingLeft: Math.round(leftInset) + 24, paddingRight: Math.round(rightInset) + 24 }}
          data-testid="workflow-canvas-empty"
        >
          <div className="pointer-events-auto max-w-[19rem] rounded-2xl border border-dashed border-border/80 bg-card/80 px-5 py-4 text-center shadow-sm backdrop-blur">
            <p className="text-sm font-semibold text-foreground">Start with a trigger</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Add <span className="font-medium text-foreground">Manual trigger</span> or{" "}
              <span className="font-medium text-foreground">Schedule</span> from the steps. A workflow has exactly one.
            </p>
            <button type="button" onClick={onOpenPalette} className={cn(BAR_SECONDARY, "mt-3 bg-card")}>
              <Shapes className="h-3.5 w-3.5" aria-hidden />
              Open the steps
            </button>
          </div>
        </div>
      ) : null}
      <CanvasContextMenu menu={menu} open={menuOpen} onClose={closeMenu} actions={menuActions} />
    </div>
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
