import {
  createTimeline,
  foldTimeline,
  resolveSubagentParents,
  subagentRunStatus,
} from "@/features/inference/timeline";
import type {
  ContentBlock,
  MessageOut,
  RunTimeline,
  SubagentBlock,
  SubagentRunStatus,
  ThinkingBlock,
  TimelineBlock,
  TimelineTerminalStatus,
} from "@/shared/lib/types";

// The agent map (composer button → panel): every sub-agent the conversation's
// main agent delegated to, on the branch the user sees, as a tree.
//
//   Main agent
//   ├─ Q1 · "Compare the three vendors…"
//   │  ├─ Researcher
//   │  │  └─ Fact checker          ← nested: its namespace extends Researcher's
//   │  └─ Writer
//   └─ Q3 · "Draft the summary…"   ← answers without sub-agents are left out
//      └─ Analyst
//
// Pure: the answers' timelines come in, the tree comes out. The live answer's
// timeline is the active run's (folded as frames arrive); a settled answer's is
// replayed from its persisted events, once per event log (`foldAnswerTimeline`).

export type AgentMapNode = {
  /** Unique across the conversation: the answer's message id + the task id. */
  id: string;
  taskId: string;
  messageId: string;
  title: string;
  type?: string;
  /** What it was asked, on one line. */
  task: string;
  status: SubagentRunStatus | null;
  startedAt?: number;
  endedAt?: number;
  /** How long it worked, once settled; null while it runs or when unknown. */
  durationMs: number | null;
  toolCount: number;
  /** 1 for the main agent's own sub-agents, 2 for theirs, and so on. */
  depth: number;
  /** The folded block, for the detail view's sub-agent card. */
  block: SubagentBlock;
  children: AgentMapNode[];
};

export type AgentMapAnswer = {
  /** The answer's message id. */
  id: string;
  /** 1-based number of the question on the branch ("Q3"). */
  number: number;
  question: string;
  live: boolean;
  /** Its sub-agents at every depth. */
  subagentCount: number;
  runningCount: number;
  nodes: AgentMapNode[];
};

export type AgentMap = {
  answers: AgentMapAnswer[];
  subagentCount: number;
  runningCount: number;
};

export type AgentMapAnswerInput = {
  messageId: string;
  number: number;
  question: string;
  timeline: RunTimeline | null;
  /** Whether the run still streams into this answer. */
  live: boolean;
};

/** Tree-row ids: the main agent, and an answer (a node's own id is `node.id`). */
export const AGENT_MAP_ROOT_ID = "root";
export const answerItemId = (answer: Pick<AgentMapAnswer, "id">) => `answer:${answer.id}`;

export const EMPTY_AGENT_MAP: AgentMap = { answers: [], subagentCount: 0, runningCount: 0 };

const SETTLED = new Set<SubagentRunStatus>(["done", "failed", "cancelled"]);

const oneLine = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

function countTools(block: SubagentBlock): number {
  let count = 0;
  for (const nested of block.blocks) {
    if (nested.kind !== "thinking") continue;
    for (const item of nested.items) if (item.kind === "tool") count += 1;
  }
  return count;
}

function titleOf(block: SubagentBlock, index: number): string {
  return block.label || block.type || `Sub-agent ${index + 1}`;
}

/** One answer's sub-agents as a forest, in the order they started. */
export function buildAnswerNodes(
  messageId: string,
  timeline: RunTimeline,
  live: boolean,
): AgentMapNode[] {
  // Spawned only, as everywhere else: an unspawned block is a `task` call the
  // user refused, not a sub-agent.
  const blocks = timeline.blocks.filter(
    (block): block is SubagentBlock => block.kind === "subagent" && Boolean(block.spawned),
  );
  if (!blocks.length) return [];
  const parents = resolveSubagentParents(blocks);
  const nodes = blocks.map((block, index): AgentMapNode => {
    const status = subagentRunStatus(block, timeline, live);
    const settled = status !== null && SETTLED.has(status);
    const { startedAt, endedAt } = block;
    return {
      id: `${messageId}/${block.taskId}`,
      taskId: block.taskId,
      messageId,
      title: titleOf(block, index),
      type: block.type,
      task: oneLine(block.description || block.prompt),
      status,
      startedAt,
      endedAt,
      durationMs:
        settled &&
        typeof startedAt === "number" &&
        typeof endedAt === "number" &&
        endedAt >= startedAt
          ? endedAt - startedAt
          : null,
      toolCount: countTools(block),
      depth: 1,
      block,
      children: [],
    };
  });
  const roots: AgentMapNode[] = [];
  nodes.forEach((node, index) => {
    const parent = parents[index];
    if (parent === -1) roots.push(node);
    else nodes[parent].children.push(node);
  });
  const setDepth = (list: AgentMapNode[], depth: number) => {
    for (const node of list) {
      node.depth = depth;
      setDepth(node.children, depth + 1);
    }
  };
  setDepth(roots, 1);
  return roots;
}

/** Every node of a forest, depth first, parents before their children. */
export function flattenAgentNodes(nodes: AgentMapNode[]): AgentMapNode[] {
  const out: AgentMapNode[] = [];
  const visit = (list: AgentMapNode[]) => {
    for (const node of list) {
      out.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

// An answer is rebuilt only when its timeline (or its live flag, number or
// question) changes: a settled answer's timeline is folded once and keeps its
// identity, so a long conversation rebuilds just the answer that streams.
const answerCache = new WeakMap<RunTimeline, { key: string; answer: AgentMapAnswer | null }>();

function buildAnswer(input: AgentMapAnswerInput): AgentMapAnswer | null {
  const { timeline } = input;
  if (!timeline) return null;
  const key = `${input.messageId}|${input.number}|${input.live}|${input.question}`;
  const cached = answerCache.get(timeline);
  if (cached && cached.key === key) return cached.answer;
  const nodes = buildAnswerNodes(input.messageId, timeline, input.live);
  const all = flattenAgentNodes(nodes);
  const answer: AgentMapAnswer | null = all.length
    ? {
        id: input.messageId,
        number: input.number,
        question: oneLine(input.question),
        live: input.live,
        subagentCount: all.length,
        runningCount: all.filter((node) => node.status === "running").length,
        nodes,
      }
    : null;
  answerCache.set(timeline, { key, answer });
  return answer;
}

/** The conversation's agent map: one entry per answer that used sub-agents. */
export function buildAgentMap(inputs: AgentMapAnswerInput[]): AgentMap {
  const answers: AgentMapAnswer[] = [];
  let subagentCount = 0;
  let runningCount = 0;
  for (const input of inputs) {
    const answer = buildAnswer(input);
    if (!answer) continue;
    answers.push(answer);
    subagentCount += answer.subagentCount;
    runningCount += answer.runningCount;
  }
  return answers.length ? { answers, subagentCount, runningCount } : EMPTY_AGENT_MAP;
}

// ------------------------------------------------------
// From the visible branch's messages to the builder's input
// ------------------------------------------------------

const SUBAGENT_EVENT = "SUBAGENT_EVENT";

// Settled answers replay their events once per event log. Most answers have no
// sub-agents at all: a scan for a sub-agent envelope skips their fold entirely.
const foldCache = new WeakMap<object, { status: string; timeline: RunTimeline | null }>();

export function foldAnswerTimeline(message: MessageOut): RunTimeline | null {
  const events = message.rawEvents;
  if (!Array.isArray(events) || !events.length) return null;
  const status = message.streamingStatus ?? (message.error ? "failed" : "completed");
  const cached = foldCache.get(events);
  if (cached && cached.status === status) return cached.timeline;
  const timeline = events.some(
    (event) => event?.type === "CUSTOM" && event?.name === SUBAGENT_EVENT,
  )
    ? foldTimeline(events, { status })
    : null;
  foldCache.set(events, { status, timeline });
  return timeline;
}

/**
 * Pair each answer on the branch with the question before it. The live answer
 * (the active run's assistant message) takes the run's timeline.
 */
export function collectAgentMapAnswers(
  messages: MessageOut[],
  live: { messageId: string | null; timeline: RunTimeline | null },
  fold: (message: MessageOut) => RunTimeline | null = foldAnswerTimeline,
): AgentMapAnswerInput[] {
  const inputs: AgentMapAnswerInput[] = [];
  let number = 0;
  let question = "";
  for (const message of messages) {
    if (message.sender !== "ai") {
      number += 1;
      question = message.content ?? "";
      continue;
    }
    const isLive = Boolean(live.messageId && message.id === live.messageId && live.timeline);
    inputs.push({
      messageId: message.id,
      number: Math.max(number, 1),
      question,
      timeline: isLive ? live.timeline : fold(message),
      live: isLive,
    });
  }
  return inputs;
}

/** "<1s", "42s", "3m 05s", "1h 02m" — a sub-agent's working time. */
export function formatAgentDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a node has worked: its settled time, or the clock while it runs. */
export function agentNodeDuration(node: AgentMapNode, now: number): string | null {
  if (node.durationMs !== null) return formatAgentDuration(node.durationMs);
  if (node.status === "running" && typeof node.startedAt === "number") {
    return formatAgentDuration(Math.max(now - node.startedAt, 0));
  }
  return null;
}

// ------------------------------------------------------
// One sub-agent as a conversation (the detail view)
// ------------------------------------------------------

export type AgentTranscript = {
  /** What the agent that delegated asked it to do, in full. */
  instruction: string;
  /**
   * Its reply as a run timeline the main chat's renderers draw: its own
   * thinking and content blocks, with each sub-agent it delegated to spliced in
   * right after the `task` call that started it.
   */
  timeline: RunTimeline;
  /** Whether the reply is still arriving. */
  live: boolean;
};

const TERMINAL_STATUS: Partial<Record<SubagentRunStatus, TimelineTerminalStatus>> = {
  done: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * A node's reply in the shape the main chat renders an answer from. Its nested
 * sub-agents are separate top-level blocks in the run's timeline; here each
 * one goes right after the step where it was delegated — the `delegation` item
 * the fold left in the node's steps (by task id), or a `task` tool step in
 * order for a log that has none — splitting the thinking block there, as the
 * orchestrator's own sub-agents sit in an answer. One whose step is not found
 * goes at the end.
 */
export function agentTranscript(node: AgentMapNode): AgentTranscript {
  const live = node.status === "running";
  const children = node.children.map((child) => child.block);
  const byTask = new Map(children.map((child) => [child.taskId, child]));
  const placed = new Set<SubagentBlock>();
  const unplacedInOrder = () => children.find((child) => !placed.has(child));

  const blocks: TimelineBlock[] = [];
  for (const block of node.block.blocks) {
    if (block.kind === "content") {
      blocks.push(block as ContentBlock);
      continue;
    }
    let items: ThinkingBlock["items"] = [];
    let part = 0;
    let startedAt = block.startedAt;
    // Children delegated in one go (parallel `task` calls) follow the run of
    // steps that started them together.
    let pending: SubagentBlock[] = [];
    const flush = () => {
      if (!pending.length) return;
      blocks.push({
        ...block,
        id: part ? `${block.id}~${part}` : block.id,
        items,
        startedAt,
        endedAt: pending[0].startedAt ?? block.endedAt,
      });
      blocks.push(...pending);
      const ends = pending.map((child) => child.endedAt).filter((end) => typeof end === "number");
      startedAt = ends.length ? Math.max(...(ends as number[])) : undefined;
      items = [];
      part += 1;
      pending = [];
    };
    for (const item of block.items) {
      let child: SubagentBlock | undefined;
      if (item.kind === "delegation") {
        const direct = byTask.get(item.taskId);
        child = direct && !placed.has(direct) ? direct : undefined;
      } else if (item.kind === "tool" && item.name === "task") {
        const direct = byTask.get(item.id);
        child = direct && !placed.has(direct) ? direct : unplacedInOrder();
      }
      if (!child) flush();
      items.push(item);
      if (child) {
        placed.add(child);
        pending.push(child);
      }
    }
    flush();
    if (items.length || !part) {
      blocks.push({ ...block, id: part ? `${block.id}~${part}` : block.id, items, startedAt });
    }
  }
  for (const child of children) if (!placed.has(child)) blocks.push(child);

  const status = node.status;
  return {
    instruction: (node.block.prompt || node.block.description || "").trim(),
    live,
    timeline: {
      ...createTimeline(),
      blocks,
      subagentCount: children.length,
      // Settled unless it is still working: a paused (awaiting approval) reply
      // is not live either, but has not ended.
      terminal: Boolean(status && TERMINAL_STATUS[status]),
      terminalStatus: status ? TERMINAL_STATUS[status] : undefined,
    },
  };
}
