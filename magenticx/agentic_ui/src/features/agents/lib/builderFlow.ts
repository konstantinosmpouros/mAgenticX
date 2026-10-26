import type { Edge, Node } from "@xyflow/react";

import type { AgentDraft, AgentDraftSubAgent } from "@/shared/lib/types";
import { layoutTree, type LayoutOptions, type LayoutTree } from "@/features/chat/lib/agentMapFlow";
import { ROOT_UID } from "./agentIssues";
import { canAddChild } from "./agentRules";

// The builder's canvas (components/builder/canvas/BuilderCanvas): the agent and
// its team as a top-down graph — the main agent on top, its sub-agents in a row
// under it, theirs under them, three levels at most. Laid out with the agent
// map's own tree layout, so the two graphs read alike; there is no free
// dragging, every position comes from the tree.
//
//                  [ Market Researcher ]
//              ┌────────────┴────────────┐
//        [ researcher ]             [ writer ]
//              │
//       [ fact-checker ]
//
// Pure: the draft comes in, positioned nodes and edges come out; only types
// are taken from React Flow, so the library itself stays in the canvas's lazy
// chunk.

/** Each node's box. The main agent's card is the larger one. */
export const BUILDER_NODE_SIZE = {
  root: { width: 276, height: 76 },
  subagent: { width: 212, height: 66 },
  ghost: { width: 204, height: 54 },
} as const;

/** Wider rows than the agent map's: each card carries a + under it. */
export const BUILDER_LAYOUT: LayoutOptions = { siblingGap: 22, groupGap: 30, levelGap: 60 };

/** The ghost "Add a sub-agent" node shown under an agent with no team. */
export const GHOST_ID = "ghost";

export type BuilderNodeData = {
  uid: string;
  /** 0 for the main agent, 1–3 for its team. */
  depth: number;
  name: string;
  /** The node's description, for its hover tip. */
  description: string;
  /** Its model, as a label, when it differs from the agent above it (always shown on the main agent). */
  model: string | null;
  /** Its MCP tools: a count, or "inherit" for a sub-agent that keeps its parent's. */
  tools: number | "inherit";
  /** Sub-agents directly under it. */
  childCount: number;
  issueCount: number;
  /** Issues that block a save, as against warnings only. */
  hasErrors: boolean;
  selected: boolean;
  /** Whether it may have sub-agents of its own (false at the third level). */
  canAdd: boolean;
  readOnly: boolean;
  /** The main agent's icon name (a Lucide name). */
  icon?: string;
};

export type BuilderGhostData = { parentUid: string };

export type BuilderRootNode = Node<BuilderNodeData, "builderRoot">;
export type BuilderSubagentNode = Node<BuilderNodeData, "builderSubagent">;
export type BuilderGhostNode = Node<BuilderGhostData, "builderGhost">;
export type BuilderFlowNode = BuilderRootNode | BuilderSubagentNode | BuilderGhostNode;

export type BuilderEdgeData = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  ghost: boolean;
};
/**
 * A smooth-step edge drawn between the layout's own anchors, not React Flow's
 * measured handles (see the agent map's AgentFlowEdge): the boxes' sizes are
 * known here exactly, so a straight line under a node never grows elbows.
 */
export type BuilderFlowEdge = Edge<BuilderEdgeData, "builderEdge">;

export type BuilderFlow = { nodes: BuilderFlowNode[]; edges: BuilderFlowEdge[] };

export type BuilderFlowOptions = {
  /** A model id as a label. */
  modelLabel: (id: string) => string;
  /** Issues per node uid, and which of those nodes have an error among them. */
  issueCounts?: ReadonlyMap<string, number>;
  errorNodes?: ReadonlySet<string>;
  selectedUid?: string | null;
  readOnly?: boolean;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a screen reader hears for a node: its name, place and state. */
export function nodeAriaLabel(data: BuilderNodeData): string {
  const name = data.name.trim() || (data.depth ? "Unnamed sub-agent" : "Untitled agent");
  const where = data.depth ? `sub-agent, level ${data.depth} of 3` : "main agent";
  const parts = [`${name}, ${where}`];
  if (data.model) parts.push(data.model);
  parts.push(data.tools === "inherit" ? "inherits its tools" : plural(data.tools, "tool"));
  if (data.childCount) parts.push(plural(data.childCount, "sub-agent"));
  if (data.issueCount) parts.push(plural(data.issueCount, "issue"));
  return parts.join(", ");
}

/**
 * The draft as a positioned graph: nodes in reading order (the main agent,
 * then its team depth first — the tab order), one edge per parent → child, and
 * a ghost "Add a sub-agent" node when the agent has no team (not when read-only).
 */
export function buildBuilderFlow(draft: AgentDraft, options: BuilderFlowOptions): BuilderFlow {
  const readOnly = options.readOnly ?? false;
  const counts = options.issueCounts ?? new Map<string, number>();
  const errors = options.errorNodes ?? new Set<string>();
  const ghost = !readOnly && draft.subagents.length === 0;

  const subtree = (node: AgentDraftSubAgent): LayoutTree => ({
    id: node.uid,
    ...BUILDER_NODE_SIZE.subagent,
    children: (node.subagents ?? []).map(subtree),
  });
  const boxes = layoutTree(
    {
      id: ROOT_UID,
      ...BUILDER_NODE_SIZE.root,
      children: ghost
        ? [{ id: GHOST_ID, ...BUILDER_NODE_SIZE.ghost, children: [] }]
        : draft.subagents.map(subtree),
    },
    BUILDER_LAYOUT,
  );
  const at = (id: string) => {
    const box = boxes.get(id);
    return { position: { x: box?.x ?? 0, y: box?.y ?? 0 }, width: box?.width, height: box?.height };
  };
  const STATIC = { draggable: false, connectable: false, selectable: false } as const;

  const dataFor = (
    uid: string,
    depth: number,
    fields: Pick<BuilderNodeData, "name" | "description" | "model" | "tools" | "childCount" | "icon">,
  ): BuilderNodeData => ({
    uid,
    depth,
    ...fields,
    issueCount: counts.get(uid) ?? 0,
    hasErrors: errors.has(uid),
    selected: options.selectedUid === uid,
    canAdd: canAddChild(depth),
    readOnly,
  });

  const rootData = dataFor(ROOT_UID, 0, {
    name: draft.name,
    description: draft.description,
    model: options.modelLabel(draft.model),
    tools: draft.tools.length,
    childCount: draft.subagents.length,
    icon: draft.icon,
  });
  const nodes: BuilderFlowNode[] = [
    {
      id: ROOT_UID,
      type: "builderRoot",
      ...at(ROOT_UID),
      ...STATIC,
      ariaLabel: nodeAriaLabel(rootData),
      data: rootData,
    },
  ];
  const edges: BuilderFlowEdge[] = [];
  const edge = (source: string, target: string, isGhost = false): BuilderFlowEdge => {
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
      type: "builderEdge",
      focusable: false,
      selectable: false,
      className: isGhost ? "agent-builder-edge is-ghost" : "agent-builder-edge",
      data: {
        from,
        // Within a pixel of straight under its parent (rounding): straight.
        to: { x: Math.abs(childX - from.x) < 1 ? from.x : childX, y: child?.y ?? 0 },
        ghost: isGhost,
      },
    };
  };

  const visit = (list: AgentDraftSubAgent[], parent: string, depth: number, parentModel: string) => {
    for (const node of list) {
      const model = node.model || parentModel;
      const data = dataFor(node.uid, depth, {
        name: node.name,
        description: node.description,
        model: node.model && node.model !== parentModel ? options.modelLabel(node.model) : null,
        tools: node.tools.length ? node.tools.length : "inherit",
        childCount: (node.subagents ?? []).length,
      });
      nodes.push({
        id: node.uid,
        type: "builderSubagent",
        ...at(node.uid),
        ...STATIC,
        ariaLabel: nodeAriaLabel(data),
        data,
      });
      edges.push(edge(parent, node.uid));
      visit(node.subagents ?? [], node.uid, depth + 1, model);
    }
  };
  visit(draft.subagents, ROOT_UID, 1, draft.model);

  if (ghost) {
    nodes.push({
      id: GHOST_ID,
      type: "builderGhost",
      ...at(GHOST_ID),
      ...STATIC,
      ariaLabel: "Add a sub-agent",
      data: { parentUid: ROOT_UID },
    });
    edges.push(edge(ROOT_UID, GHOST_ID, true));
  }
  return { nodes, edges };
}

/**
 * The node an arrow key moves to from `id`: up to the parent, down to the first
 * child, left and right along the same row (across branches, by position).
 */
export function neighbourOf(
  flow: BuilderFlow,
  id: string,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
): string | null {
  const nodes = flow.nodes.filter((node) => node.type !== "builderGhost");
  const here = nodes.find((node) => node.id === id);
  if (!here) return null;
  if (key === "ArrowUp") return flow.edges.find((e) => e.target === id)?.source ?? null;
  if (key === "ArrowDown") {
    const child = flow.edges.find((e) => e.source === id && e.target !== GHOST_ID);
    return child?.target ?? null;
  }
  const depth = (here.data as BuilderNodeData).depth;
  const row = nodes
    .filter((node) => (node.data as BuilderNodeData).depth === depth)
    .sort((a, b) => a.position.x - b.position.x);
  const index = row.findIndex((node) => node.id === id);
  const next = row[index + (key === "ArrowLeft" ? -1 : 1)];
  return next?.id ?? null;
}
