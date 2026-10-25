import type { Edge, Node } from "@xyflow/react";

import {
  AGENT_MAP_ROOT_ID,
  answerItemId,
  type AgentMap,
  type AgentMapAnswer,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";

// The agent map's flow view (components/agent_map/AgentMapFlow): the same tree
// as the tree view, drawn as a top-down graph — the main agent on top, its
// answers in a row under it, each answer's sub-agents under the answer, nested
// sub-agents under theirs.
//
//                    [ Main agent ]
//            ┌──────────────┴──────────────┐
//         [ Q1 ]                         [ Q3 ]
//      ┌─────┴─────┐                        │
//  [Researcher] [Writer]                [Analyst]
//      │
//  [Fact checker]
//
// Pure: the map comes in, positioned nodes and edges come out; only types are
// taken from React Flow, so the library itself stays in the view's lazy chunk.

// ------------------------------------------------------
// Layout
// ------------------------------------------------------

/**
 * A node's box, as the flow view draws it. An answer is only its label (Q1)
 * on the edge, so its box is the label's: the edges end just above and below
 * the letters instead of running through them.
 */
export const FLOW_NODE_SIZE = {
  root: { width: 264, height: 56 },
  answer: { width: 40, height: 22 },
  subagent: { width: 200, height: 62 },
} as const;

export type LayoutOptions = {
  /** Between sibling subtrees. */
  siblingGap: number;
  /** Between the answers' subtrees — wider, so the answers read as groups. */
  groupGap: number;
  /** Between one row and the next. */
  levelGap: number;
};

export const FLOW_LAYOUT: LayoutOptions = { siblingGap: 16, groupGap: 32, levelGap: 44 };

export type LayoutTree = {
  id: string;
  width: number;
  height: number;
  children: LayoutTree[];
};

export type LayoutBox = { x: number; y: number; width: number; height: number; depth: number };

/**
 * A layered tree layout, top-down and deterministic. Every row (depth) starts
 * below the tallest box of the row above. Across, each subtree takes the room
 * of its widest row; siblings sit side by side, `siblingGap` apart (`groupGap`
 * under the root), and a parent is centred over its children — on the middle
 * of its first and last child, kept within its own subtree's room. Leaves
 * never overlap: a subtree's room is at least its own width and its children's
 * together. Positions are each box's top-left corner, rounded to whole pixels.
 */
export function layoutTree(
  root: LayoutTree,
  options: LayoutOptions = FLOW_LAYOUT,
): Map<string, LayoutBox> {
  const span = new Map<LayoutTree, number>();
  const childrenSpan = new Map<LayoutTree, number>();
  const gapUnder = (node: LayoutTree) => (node === root ? options.groupGap : options.siblingGap);

  // Pass 1: how wide each subtree is, and the tallest box of each row.
  const rowHeights: number[] = [];
  const measure = (node: LayoutTree, depth: number): number => {
    rowHeights[depth] = Math.max(rowHeights[depth] ?? 0, node.height);
    let children = 0;
    node.children.forEach((child, index) => {
      children += measure(child, depth + 1) + (index ? gapUnder(node) : 0);
    });
    childrenSpan.set(node, children);
    const own = Math.max(node.width, children);
    span.set(node, own);
    return own;
  };
  measure(root, 0);

  const rowTop: number[] = [0];
  for (let depth = 1; depth < rowHeights.length; depth += 1) {
    rowTop[depth] = rowTop[depth - 1] + rowHeights[depth - 1] + options.levelGap;
  }

  // Pass 2: place each subtree in its room, left to right.
  const boxes = new Map<string, LayoutBox>();
  const place = (node: LayoutTree, left: number, depth: number): number => {
    const room = span.get(node) ?? node.width;
    let center = left + room / 2;
    if (node.children.length) {
      const block = childrenSpan.get(node) ?? 0;
      let cursor = left + (room - block) / 2;
      const centers = node.children.map((child) => {
        const childCenter = place(child, cursor, depth + 1);
        cursor += (span.get(child) ?? child.width) + gapUnder(node);
        return childCenter;
      });
      const middle = (centers[0] + centers[centers.length - 1]) / 2;
      center = Math.min(Math.max(middle, left + node.width / 2), left + room - node.width / 2);
    }
    boxes.set(node.id, {
      x: Math.round(center - node.width / 2),
      y: Math.round(rowTop[depth]),
      width: node.width,
      height: node.height,
      depth,
    });
    return center;
  };
  place(root, 0, 0);
  return boxes;
}

// ------------------------------------------------------
// The map as React Flow nodes and edges
// ------------------------------------------------------

export type AgentFlowRootData = {
  agentName: string;
  subagentCount: number;
  answerCount: number;
  runningCount: number;
};
export type AgentFlowAnswerData = { answer: AgentMapAnswer };
export type AgentFlowSubagentData = { node: AgentMapNode };

export type AgentFlowRootNode = Node<AgentFlowRootData, "agentRoot">;
export type AgentFlowAnswerNode = Node<AgentFlowAnswerData, "agentAnswer">;
export type AgentFlowSubagentNode = Node<AgentFlowSubagentData, "agentSubagent">;
export type AgentFlowNode = AgentFlowRootNode | AgentFlowAnswerNode | AgentFlowSubagentNode;

/** How an edge reads: by the sub-agent (or answer) it leads into. */
export type AgentFlowEdgeTone = "running" | "done" | "failed" | "idle";
export type AgentFlowEdgeData = {
  tone: AgentFlowEdgeTone;
  /** The parent's bottom centre and the child's top centre, from the layout. */
  from: { x: number; y: number };
  to: { x: number; y: number };
};
/**
 * A smooth-step edge drawn between the layout's own anchors, not React Flow's
 * measured handles: those are read once, through any CSS scale still settling
 * on the panel (it opens from 96.5%), so boxes of different widths came out a
 * few pixels apart and a straight line under the narrow Q label grew elbows.
 */
export type AgentFlowEdge = Edge<AgentFlowEdgeData, "agentEdge">;

export type AgentMapFlow = { nodes: AgentFlowNode[]; edges: AgentFlowEdge[] };

/** The flow view's pan and zoom, and how many nodes it showed then. */
export type AgentFlowSavedView = { x: number; y: number; zoom: number; count: number };

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** How much of a question an answer's hover tip shows. */
export const QUESTION_PREVIEW_LENGTH = 120;
/** How much of a sub-agent's instructions its card's hover tip shows. */
export const TASK_PREVIEW_LENGTH = 200;

/** A text's start for a hover tip: one line, an ellipsis when cut. */
export function previewText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  // By code point, so an emoji is never cut in half.
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : text;
}

/** A question's start for the answer's tip. */
export function questionPreview(question: string, max = QUESTION_PREVIEW_LENGTH): string {
  return previewText(question, max) || "Untitled question";
}

function toneOf(node: AgentMapNode): AgentFlowEdgeTone {
  if (node.status === "running") return "running";
  if (node.status === "done") return "done";
  if (node.status === "failed") return "failed";
  return "idle";
}

/** Shared by every node: shown, not dragged, joined or selected. */
const STATIC = { draggable: false, connectable: false, selectable: false } as const;

/**
 * The map as a positioned graph: nodes in reading order (main agent, then each
 * answer followed by its sub-agents depth first — the tab order), one edge per
 * parent → child. An edge into a running sub-agent, or into an answer one is
 * working under, is lit and — unless `animate` is off (reduced motion) —
 * animated; into a finished one it is the brand colour, a failed one a red tint.
 */
export function buildAgentMapFlow(
  map: AgentMap,
  options: { agentName: string; answers?: AgentMapAnswer[]; animate?: boolean },
): AgentMapFlow {
  const answers = options.answers ?? map.answers;
  const animate = options.animate ?? true;

  const subtree = (node: AgentMapNode): LayoutTree => ({
    id: node.id,
    ...FLOW_NODE_SIZE.subagent,
    children: node.children.map(subtree),
  });
  const boxes = layoutTree({
    id: AGENT_MAP_ROOT_ID,
    ...FLOW_NODE_SIZE.root,
    children: answers.map((answer) => ({
      id: answerItemId(answer),
      ...FLOW_NODE_SIZE.answer,
      children: answer.nodes.map(subtree),
    })),
  });
  const at = (id: string) => {
    const box = boxes.get(id);
    return {
      position: { x: box?.x ?? 0, y: box?.y ?? 0 },
      width: box?.width,
      height: box?.height,
    };
  };

  const nodes: AgentFlowNode[] = [
    {
      id: AGENT_MAP_ROOT_ID,
      type: "agentRoot",
      ...at(AGENT_MAP_ROOT_ID),
      ...STATIC,
      ariaLabel: `${options.agentName}, main agent, ${plural(map.subagentCount, "sub-agent")}`,
      data: {
        agentName: options.agentName,
        subagentCount: map.subagentCount,
        answerCount: map.answers.length,
        runningCount: map.runningCount,
      },
    },
  ];
  const edges: AgentFlowEdge[] = [];
  const edge = (source: string, target: string, tone: AgentFlowEdgeTone): AgentFlowEdge => {
    const parent = boxes.get(source);
    const child = boxes.get(target);
    const from = {
      x: (parent?.x ?? 0) + (parent?.width ?? 0) / 2,
      y: (parent?.y ?? 0) + (parent?.height ?? 0),
    };
    const childX = (child?.x ?? 0) + (child?.width ?? 0) / 2;
    return {
      id: `${source}->${target}`,
      source,
      target,
      type: "agentEdge",
      animated: animate && tone === "running",
      focusable: false,
      selectable: false,
      className: `agent-map-flow-edge is-${tone}`,
      data: {
        tone,
        from,
        // A child within a pixel of straight under its parent (rounding) is
        // joined by a straight line, never a hairline step.
        to: { x: Math.abs(childX - from.x) < 1 ? from.x : childX, y: child?.y ?? 0 },
      },
    };
  };

  const visit = (list: AgentMapNode[], parent: string) => {
    for (const node of list) {
      nodes.push({
        id: node.id,
        type: "agentSubagent",
        ...at(node.id),
        ...STATIC,
        ariaLabel: `${node.title}${node.status ? `, ${node.status.replace("_", " ")}` : ""}${node.task ? `: ${node.task}` : ""}`,
        data: { node },
      });
      edges.push(edge(parent, node.id, toneOf(node)));
      visit(node.children, node.id);
    }
  };
  for (const answer of answers) {
    const id = answerItemId(answer);
    nodes.push({
      id,
      type: "agentAnswer",
      ...at(id),
      ...STATIC,
      ariaLabel: `Question ${answer.number}: ${answer.question || "untitled"}, ${plural(answer.subagentCount, "sub-agent")}`,
      data: { answer },
    });
    edges.push(edge(AGENT_MAP_ROOT_ID, id, answer.runningCount > 0 ? "running" : "idle"));
    visit(answer.nodes, id);
  }
  return { nodes, edges };
}

/** An answer's node and all its sub-agents' — what "zoom to this answer" frames. */
export function answerFlowNodeIds(answer: AgentMapAnswer): string[] {
  const ids = [answerItemId(answer)];
  const visit = (list: AgentMapNode[]) => {
    for (const node of list) {
      ids.push(node.id);
      visit(node.children);
    }
  };
  visit(answer.nodes);
  return ids;
}

// ------------------------------------------------------
// What the view frames on open
// ------------------------------------------------------

/** Below this zoom a card's text is too small to read. */
export const READABLE_ZOOM = 0.72;

type Box = { x: number; y: number; width: number; height: number };

function boundsOf(
  nodes: Array<{ position: { x: number; y: number }; width?: number; height?: number }>,
): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.position.x);
    top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + (node.width ?? 0));
    bottom = Math.max(bottom, node.position.y + (node.height ?? 0));
  }
  return nodes.length
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: 0, y: 0, width: 0, height: 0 };
}

/** The zoom that fits these nodes in a viewport (React Flow's fitView arithmetic). */
export function zoomToFit(
  nodes: AgentFlowNode[],
  viewport: { width: number; height: number },
  padding: number,
): number {
  const bounds = boundsOf(nodes);
  if (!bounds.width || !bounds.height) return 1;
  return Math.min(
    viewport.width / (bounds.width * (1 + padding)),
    viewport.height / (bounds.height * (1 + padding)),
  );
}

/**
 * What to frame on open: the first of these that fits at a readable size —
 * the whole map (null), the main agent with the latest answer's branch (the
 * live one, else the last), that branch alone — or, when none does (a phone,
 * a wide branch), that branch anyway. The newest work reads first; the zoom
 * controls' "fit view" shows the rest.
 */
export function flowFrameNodeIds(
  flow: AgentMapFlow,
  answers: AgentMapAnswer[],
  viewport: { width: number; height: number },
  padding: number,
): string[] | null {
  if (!answers.length || !viewport.width || !viewport.height) return null;
  const readable = (ids: string[] | null) => {
    const shown = ids ? flow.nodes.filter((node) => ids.includes(node.id)) : flow.nodes;
    return zoomToFit(shown, viewport, padding) >= READABLE_ZOOM;
  };
  if (readable(null)) return null;
  const latest =
    [...answers].reverse().find((answer) => answer.live) ?? answers[answers.length - 1];
  const branch = answerFlowNodeIds(latest);
  const withRoot = [AGENT_MAP_ROOT_ID, ...branch];
  if (answers.length > 1 && readable(withRoot)) return withRoot;
  return branch;
}
