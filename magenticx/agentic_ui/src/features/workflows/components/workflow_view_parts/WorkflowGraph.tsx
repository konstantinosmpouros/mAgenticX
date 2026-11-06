import "@xyflow/react/dist/style.css";
import "@/styles/agent-map-flow.css";
import "@/styles/workflow-flow.css";

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { useReducedMotion } from "framer-motion";

import type {
  WorkflowNodeKindInfo,
  WorkflowRunView,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";
import { graphFitView } from "@/features/workflows/lib/consts";
import {
  buildWorkflowFlow,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "@/features/workflows/lib/graph";
import { WORKFLOW_EDGE_TYPE, WORKFLOW_NODE_TYPE } from "@/features/workflows/lib/nodeCard";
import { WorkflowEdge } from "../workflow_parts/WorkflowEdge";
import { WorkflowNodeCard } from "../workflow_parts/WorkflowNodeCard";

// The workflow view's graph: the spec drawn read-only with React Flow (lazy:
// this module, the library and its stylesheets load the first time a workflow
// opens) on the agent builder's canvas (dot grid, controls, attribution —
// agent-map-flow.css), with the shared node card and edge the builder uses
// (workflow_parts/, styled by workflow-flow.css). Left to right: the spec's own
// positions when they read cleanly, else lib/layout's auto-layout; loops close
// with an arc under the cards. The run's overlay comes from lib/graph. Pan and
// zoom only; a click (or Enter on a focused node) selects that node's latest
// execution. It fits itself on open and again when the node count changes,
// never on a status change — the user's pan stays.

const NODE_TYPES: NodeTypes = { [WORKFLOW_NODE_TYPE]: WorkflowNodeCard };
const EDGE_TYPES: EdgeTypes = { [WORKFLOW_EDGE_TYPE]: WorkflowEdge };

const ARIA_LABELS = {
  "node.a11yDescription.default": "Press Enter to show this node's latest execution.",
  "node.a11yDescription.keyboardDisabled": "Press Enter to show this node's latest execution.",
  "controls.ariaLabel": "Zoom controls",
};

export type WorkflowGraphProps = {
  spec: WorkflowSpec;
  view: WorkflowRunView | null;
  catalog: WorkflowNodeKindInfo[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  /** The workflow's live schedule: the schedule trigger's card shows its next run. */
  schedule?: WorkflowSchedule | null;
  /**
   * How much of the canvas's right edge something covers (px) — the builder's
   * History drawer while a version is previewed — so the graph frames clear of it.
   */
  rightInset?: number;
};

function GraphCanvas({
  spec,
  view,
  catalog,
  selectedNodeId,
  onSelectNode,
  schedule = null,
  rightInset = 0,
}: WorkflowGraphProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { fitView } = useReactFlow();
  const fitOptions = React.useMemo(() => graphFitView(rightInset), [rightInset]);
  const { nodes, edges } = React.useMemo(
    () =>
      buildWorkflowFlow({ spec, view, catalog, selectedNodeId, animate: !reduceMotion, schedule }),
    [spec, view, catalog, selectedNodeId, reduceMotion, schedule],
  );
  const duration = reduceMotion ? 0 : 300;

  // Re-frame when nodes come or go (another version), never on a status change.
  const count = nodes.length;
  const fittedCount = React.useRef(count);
  React.useEffect(() => {
    if (count === fittedCount.current) return;
    fittedCount.current = count;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ ...fitOptions, duration });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [count, duration, fitView, fitOptions]);

  const nodeIdFromEvent = (event: React.SyntheticEvent): string | null => {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains("react-flow__node")) return null;
    return target.getAttribute("data-id");
  };

  return (
    <div
      className="h-full w-full"
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const id = nodeIdFromEvent(event);
        if (!id) return;
        event.preventDefault();
        onSelectNode(id);
      }}
    >
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        className="agent-map-flow workflow-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        fitView
        fitViewOptions={fitOptions}
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
        // MIT licensed; the attribution stays (React Flow asks that only Pro
        // subscribers remove it), restyled to sit quietly in a corner.
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
          fitViewOptions={{ ...fitOptions, duration }}
          className="agent-map-flow-controls"
        />
      </ReactFlow>
    </div>
  );
}

/** The graph; default export for React.lazy. */
export default function WorkflowGraph(props: WorkflowGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
