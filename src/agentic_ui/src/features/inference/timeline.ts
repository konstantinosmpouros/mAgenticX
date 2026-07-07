import {
  BEFORE_AGENT_EVENT_TYPE,
  HITL_INTERRUPT_EVENT_TYPE,
  HITLInterruptPayloadSchema,
  PLAN_SNAPSHOT_EVENT_NAMES,
  PlanSnapshotSchema,
  SUBAGENT_EVENT_TYPE,
  SubAgentPayloadSchema,
  TASK_SUBAGENT_EVENT_TYPE,
  TaskSubAgentPayloadSchema,
  TOKEN_USAGE_EVENT_TYPE,
} from "./agui";
import { parseHitlInterrupt } from "./hitl";
import type {
  ContentBlock,
  PendingToolRetool,
  RunTimeline,
  SubagentBlock,
  SubagentFoldIndexes,
  ThinkingBlock,
  TimelineBlock,
  TimelineFoldIndexes,
  TimelineHitlActionOutcome,
  TimelineHitlApproval,
  TimelineTerminalStatus,
  TimelineThought,
  TimelineToolExecution,
} from "@/shared/lib/types";
import type { SubagentItem } from "@/features/chat/components/message_parts/SubagentContainer";

// The single fold from raw AG-UI events to the rendered timeline structure
// [Thinking, Content, Subagent, Content, …]. Used incrementally on live WS
// "events" frames and in batch when hydrating from message.rawEvents — one
// code path, so the live view and the reloaded view cannot drift.
//
// Events stamped with a monotonic `seq` by the bridge are deduped against
// `lastSeq`, which makes snapshot-then-delta subscription overlap harmless.
// Malformed events are skipped; this module never throws.

type RawEvent = Record<string, any>;

const TEXT_DELTA_TYPES = new Set(["TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"]);
const FULL_LOG_TYPES = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CHUNK",
  "TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "TOOL_CALL_START",
]);
const BRIDGE_HITL_RESOLVED_EVENT_TYPE = "BRIDGE_HITL_RESOLVED";
const PLAN_EVENT_NAMES = new Set<string>(PLAN_SNAPSHOT_EVENT_NAMES);

export function createTimeline(): RunTimeline {
  return {
    blocks: [],
    plan: null,
    interrupts: [],
    subagentCount: 0,
    terminal: false,
    lastSeq: 0,
    fold: {
      openThinkingIndex: null,
      openContentIndex: null,
      subagentIndexByKey: {},
      taskIdRemap: {},
      namespaceToKey: {},
      toolPaths: {},
      pendingRetool: null,
      blockCounter: 0,
      itemCounter: 0,
      subFolds: {},
    },
  };
}

// ------------------------------------------------------
// Copy-on-write session — one per reduce call. Blocks untouched by the
// frame keep their identity so memoized block components skip re-render.
// ------------------------------------------------------
type Session = {
  state: RunTimeline;
  clonedBlocks: Set<number>;
  clonedSubBlocks: Map<number, Set<number>>;
};

function cloneFold(fold: TimelineFoldIndexes): TimelineFoldIndexes {
  return {
    ...fold,
    subagentIndexByKey: { ...fold.subagentIndexByKey },
    taskIdRemap: { ...fold.taskIdRemap },
    namespaceToKey: { ...fold.namespaceToKey },
    toolPaths: { ...fold.toolPaths },
    subFolds: Object.fromEntries(
      Object.entries(fold.subFolds).map(([key, sub]) => [key, { ...sub, toolPaths: { ...sub.toolPaths } }]),
    ),
  };
}

function openSession(state: RunTimeline): Session {
  return {
    state: {
      ...state,
      blocks: [...state.blocks],
      interrupts: [...state.interrupts],
      fold: cloneFold(state.fold),
    },
    clonedBlocks: new Set(),
    clonedSubBlocks: new Map(),
  };
}

function blockForWrite<T extends TimelineBlock>(session: Session, index: number): T {
  const blocks = session.state.blocks;
  if (!session.clonedBlocks.has(index)) {
    const block = blocks[index];
    if (block.kind === "thinking") {
      blocks[index] = { ...block, items: [...block.items] };
    } else if (block.kind === "subagent") {
      blocks[index] = { ...block, blocks: [...block.blocks] };
    } else {
      blocks[index] = { ...block };
    }
    session.clonedBlocks.add(index);
  }
  return blocks[index] as T;
}

function subBlockForWrite<T extends ThinkingBlock | ContentBlock>(
  session: Session,
  parentIndex: number,
  index: number,
): T {
  const parent = blockForWrite<SubagentBlock>(session, parentIndex);
  let cloned = session.clonedSubBlocks.get(parentIndex);
  if (!cloned) {
    cloned = new Set();
    session.clonedSubBlocks.set(parentIndex, cloned);
  }
  if (!cloned.has(index)) {
    const block = parent.blocks[index];
    parent.blocks[index] =
      block.kind === "thinking" ? { ...block, items: [...block.items] } : { ...block };
    cloned.add(index);
  }
  return parent.blocks[index] as T;
}

function nextBlockId(session: Session): string {
  session.state.fold.blockCounter += 1;
  return `b${session.state.fold.blockCounter}`;
}

function nextItemId(session: Session): string {
  session.state.fold.itemCounter += 1;
  return `i${session.state.fold.itemCounter}`;
}

function eventTimestamp(event: RawEvent): number | undefined {
  return typeof event.timestamp === "number" ? event.timestamp : undefined;
}

function eventEndTimestamp(event: RawEvent): number | undefined {
  if (typeof event.timestampEnd === "number") return event.timestampEnd;
  return eventTimestamp(event);
}

// ------------------------------------------------------
// Top-level block lifecycle
// ------------------------------------------------------
function closeThinking(session: Session, ts?: number): void {
  const fold = session.state.fold;
  if (fold.openThinkingIndex === null) return;
  const block = blockForWrite<ThinkingBlock>(session, fold.openThinkingIndex);
  if (block.endedAt === undefined && ts !== undefined) {
    block.endedAt = ts;
  }
  fold.openThinkingIndex = null;
}

function ensureThinking(session: Session, ts?: number): ThinkingBlock {
  const fold = session.state.fold;
  if (fold.openThinkingIndex !== null) {
    return blockForWrite<ThinkingBlock>(session, fold.openThinkingIndex);
  }
  fold.openContentIndex = null;
  const block: ThinkingBlock = { kind: "thinking", id: nextBlockId(session), items: [], startedAt: ts };
  session.state.blocks.push(block);
  fold.openThinkingIndex = session.state.blocks.length - 1;
  session.clonedBlocks.add(fold.openThinkingIndex);
  return block;
}

function ensureContent(session: Session, ts?: number): ContentBlock {
  const fold = session.state.fold;
  closeThinking(session, ts);
  if (fold.openContentIndex !== null) {
    return blockForWrite<ContentBlock>(session, fold.openContentIndex);
  }
  const block: ContentBlock = { kind: "content", id: nextBlockId(session), text: "" };
  session.state.blocks.push(block);
  fold.openContentIndex = session.state.blocks.length - 1;
  session.clonedBlocks.add(fold.openContentIndex);
  return block;
}

// ------------------------------------------------------
// Tool execution items
// ------------------------------------------------------
function startTool(items: ThinkingBlock["items"], event: RawEvent): void {
  const toolCallId = String(event.toolCallId ?? "");
  items.push({
    kind: "tool",
    id: toolCallId || `tool-${items.length}`,
    name: String(event.toolCallName ?? toolCallId ?? "tool"),
    argsText: "",
    state: "input-streaming",
    startedAt: eventTimestamp(event),
  });
}

function updateToolAt(
  block: ThinkingBlock,
  itemIndex: number,
  update: (tool: TimelineToolExecution) => TimelineToolExecution,
): void {
  const current = block.items[itemIndex];
  if (!current || current.kind !== "tool") return;
  block.items[itemIndex] = update(current);
}

function applyToolEvent(
  session: Session,
  event: RawEvent,
  paths: Record<string, { block: number; item: number }>,
  getBlock: (index: number) => ThinkingBlock,
  ensureBlock: (ts?: number) => ThinkingBlock,
  blockIndexOf: () => number | null,
  takeRetool: () => PendingToolRetool | null,
): void {
  const type = event.type;
  const toolCallId = String(event.toolCallId ?? "");
  if (type === "TOOL_CALL_START") {
    // A HITL pause+resume re-emits the SAME toolCallId (deepagents 0.6.10
    // preserves it across the interrupt), and a fresh per-resume normalizer
    // re-sends START/ARGS because its dedup state reset. Fold the repeat back
    // into the item we already track for this id instead of duplicating the
    // step — args re-stream, the result lands on it. Consume any pending retool
    // marker so it can't later mis-merge an unrelated same-named call.
    const existing = toolCallId ? paths[toolCallId] : undefined;
    if (existing) {
      takeRetool();
      updateToolAt(getBlock(existing.block), existing.item, (tool) => ({
        ...tool,
        argsText: "",
        state: "input-streaming",
        startedAt: eventTimestamp(event),
      }));
      return;
    }
    // An approved HITL tool re-executes as a fresh tool call on resume —
    // fold it back into the stalled step so params, approval, and result
    // read as one execution. The marker is single-shot: any other tool call
    // arriving first consumes it, so it can never merge a later unrelated
    // call of the same name.
    const retool = takeRetool();
    if (retool && retool.name === String(event.toolCallName ?? "")) {
      updateToolAt(getBlock(retool.block), retool.item, (tool) => ({
        ...tool,
        argsText: "",
        state: "input-streaming",
        startedAt: eventTimestamp(event),
      }));
      if (toolCallId) {
        paths[toolCallId] = { block: retool.block, item: retool.item };
      }
      return;
    }
    const block = ensureBlock(eventTimestamp(event));
    startTool(block.items, event);
    const blockIndex = blockIndexOf();
    if (blockIndex !== null && toolCallId) {
      paths[toolCallId] = { block: blockIndex, item: block.items.length - 1 };
    }
    return;
  }
  const path = toolCallId ? paths[toolCallId] : undefined;
  if (!path) return;
  const block = getBlock(path.block);
  if (type === "TOOL_CALL_ARGS") {
    updateToolAt(block, path.item, (tool) => ({
      ...tool,
      argsText: tool.argsText + String(event.delta ?? ""),
    }));
  } else if (type === "TOOL_CALL_END") {
    updateToolAt(block, path.item, (tool) =>
      tool.state === "input-streaming" ? { ...tool, state: "input-available" } : tool,
    );
  } else if (type === "TOOL_CALL_RESULT") {
    const chunk = String(event.content ?? "");
    updateToolAt(block, path.item, (tool) => ({
      ...tool,
      state: event.error ? "output-error" : "output-available",
      result: tool.result ? `${tool.result}\n\n${chunk}` : chunk,
      resultTruncated: Boolean(event.truncated) || tool.resultTruncated,
      endedAt: eventEndTimestamp(event),
    }));
  }
}

// ------------------------------------------------------
// HITL interrupts
// ------------------------------------------------------
function pushInterrupt(session: Session, raw: RawEvent, subagentId?: string): TimelineHitlApproval | null {
  const parsed = HITLInterruptPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const wrapped = value.interrupt as Record<string, any> | undefined;
  const wrappedId = wrapped && typeof wrapped === "object" ? wrapped.id : undefined;
  const interruptId = String(wrappedId ?? `hitl-${nextItemId(session)}`);
  if (session.state.interrupts.some((item) => item.id === interruptId)) {
    return null;
  }
  const approval: TimelineHitlApproval = {
    kind: "hitl",
    id: interruptId,
    threadId: String(value.thread_id ?? interruptId),
    content: wrapped,
    status: "pending",
    subagentId,
  };
  session.state.interrupts.push(approval);
  return approval;
}

// Attaches a freshly raised interrupt to the tool step(s) it gates. A batched
// interrupt carries multiple action_requests (the orchestrator gated several
// tool calls in one turn); each action is bound to its own resultless tool step
// — name-matched in action order, tagged with `actionIndex` — so every gated
// tool carries its own approval chip and can resolve independently. The step
// then owns the approval lifecycle (no separate chip item). Returns false when
// nothing stalled is found (e.g. a free-form interrupt), letting the caller
// fall back to a chip item.
function bindInterruptToTool(block: ThinkingBlock, approval: TimelineHitlApproval): boolean {
  const parsed = parseHitlInterrupt(approval.content);
  const actions = parsed.actions.length ? parsed.actions : [{ toolName: parsed.toolName }];

  // Bindable steps: resultless, not-yet-approval-bound tool items, in forward
  // (call) order — which matches action_requests order.
  const candidates: number[] = [];
  for (let i = 0; i < block.items.length; i += 1) {
    const item = block.items[i];
    if (item.kind !== "tool") continue;
    if (item.state === "output-available" || item.state === "output-error") continue;
    if (item.approval) continue;
    candidates.push(i);
  }
  if (!candidates.length) return false;

  const used = new Set<number>();
  let boundAny = false;
  actions.forEach((action, actionIndex) => {
    let pick = candidates.find((ci) => !used.has(ci) && (!action.toolName || (block.items[ci] as TimelineToolExecution).name === action.toolName));
    if (pick === undefined) pick = candidates.find((ci) => !used.has(ci));
    if (pick === undefined) return;
    used.add(pick);
    const item = block.items[pick] as TimelineToolExecution;
    block.items[pick] = { ...item, approval: { ...approval, actionIndex } };
    boundAny = true;
  });
  return boundAny;
}

function resolveInterrupt(
  session: Session,
  interruptId: string | null,
  decision: string | undefined,
  reason: string | null | undefined,
  decisions?: TimelineHitlActionOutcome[],
): void {
  const interrupts = session.state.interrupts;
  const targetId =
    interruptId ?? interrupts.find((item) => item.status === "pending")?.id ?? null;
  if (!targetId) return;
  const status: TimelineHitlApproval["status"] = decision === "reject" ? "rejected" : "approved";

  // For a batched interrupt, each bound tool resolves to ITS action's outcome
  // (decisions[actionIndex]); single-action / legacy interrupts use the overall
  // status+reason.
  const outcomeFor = (approval: TimelineHitlApproval): TimelineHitlActionOutcome => {
    const idx = approval.actionIndex;
    if (decisions && typeof idx === "number" && decisions[idx]) return decisions[idx];
    return { status, reason: reason ?? null };
  };

  const index = interrupts.findIndex((item) => item.id === targetId);
  if (index >= 0) {
    interrupts[index] = { ...interrupts[index], status, reason: reason ?? null, decisions };
  }

  const resolveInBlock = (
    block: ThinkingBlock,
    write: () => ThinkingBlock,
    recordRetool: (item: number, name: string) => void,
  ): void => {
    block.items.forEach((item, itemIndex) => {
      if (item.kind === "hitl" && item.id === targetId) {
        write().items[itemIndex] = { ...item, status, reason: reason ?? null };
      } else if (item.kind === "tool" && item.approval?.id === targetId) {
        const outcome = outcomeFor(item.approval);
        write().items[itemIndex] = {
          ...item,
          approval: { ...item.approval, status: outcome.status, reason: outcome.reason ?? null },
        };
        // Only an APPROVED tool re-executes on resume — arm the retool fold for
        // it. A rejected tool keeps its rejection and never re-runs.
        if (outcome.status === "approved") recordRetool(itemIndex, item.name);
      }
    });
  };

  session.state.blocks.forEach((block, blockIndex) => {
    if (block.kind === "thinking") {
      resolveInBlock(
        block,
        () => blockForWrite<ThinkingBlock>(session, blockIndex),
        (item, name) => {
          session.state.fold.pendingRetool = { block: blockIndex, item, name };
        },
      );
    } else if (block.kind === "subagent") {
      const subKey = Object.entries(session.state.fold.subagentIndexByKey).find(
        ([, value]) => value === blockIndex,
      )?.[0];
      block.blocks.forEach((sub, subIndex) => {
        if (sub.kind !== "thinking") return;
        resolveInBlock(
          sub,
          () => subBlockForWrite<ThinkingBlock>(session, blockIndex, subIndex),
          (item, name) => {
            const subFold = subKey ? session.state.fold.subFolds[subKey] : undefined;
            if (subFold) subFold.pendingRetool = { block: subIndex, item, name };
          },
        );
      });
    }
  });
}

// ------------------------------------------------------
// Subagents
// ------------------------------------------------------
function toTitleCase(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseRawSseEvent(raw: string): RawEvent | null {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  const dataIndex = text.indexOf("data:");
  if (dataIndex === -1) return null;
  const payloadText = text.slice(dataIndex + 5).trim();
  const jsonStart = payloadText.indexOf("{");
  const jsonEnd = payloadText.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) return null;
  const candidate = payloadText.slice(jsonStart, jsonEnd + 1);
  const attempts = [
    candidate,
    candidate.replace(/\\"/g, '"'),
    candidate.replace(/\\"/g, '"').replace(/\\\\n/g, "\\n"),
    candidate.replace(/\\"/g, '"').replace(/\\'/g, "'"),
    candidate.replace(/\\"/g, '"').replace(/\\\\n/g, "\\n").replace(/\\'/g, "'"),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as RawEvent;
    } catch {
      continue;
    }
  }
  return null;
}

function ensureSubagentBlock(session: Session, key: string, ts?: number): { block: SubagentBlock; index: number } {
  const fold = session.state.fold;
  const existing = fold.subagentIndexByKey[key];
  if (existing !== undefined) {
    return { block: blockForWrite<SubagentBlock>(session, existing), index: existing };
  }
  // A subagent panel interleaves at its position in the log: close both open
  // blocks so any later orchestrator output starts fresh below the panel.
  closeThinking(session, ts);
  fold.openContentIndex = null;
  const block: SubagentBlock = {
    kind: "subagent",
    id: nextBlockId(session),
    taskId: key,
    blocks: [],
  };
  session.state.blocks.push(block);
  const index = session.state.blocks.length - 1;
  fold.subagentIndexByKey[key] = index;
  fold.subFolds[key] = { openThinkingIndex: null, openContentIndex: null, toolPaths: {}, pendingRetool: null };
  session.state.subagentCount = Object.keys(fold.subagentIndexByKey).length;
  session.clonedBlocks.add(index);
  return { block, index };
}

function subEnsureThinking(
  session: Session,
  parentIndex: number,
  subFold: SubagentFoldIndexes,
  ts?: number,
): ThinkingBlock {
  const parent = blockForWrite<SubagentBlock>(session, parentIndex);
  if (subFold.openThinkingIndex !== null) {
    return subBlockForWrite<ThinkingBlock>(session, parentIndex, subFold.openThinkingIndex);
  }
  subFold.openContentIndex = null;
  const block: ThinkingBlock = { kind: "thinking", id: nextBlockId(session), items: [], startedAt: ts };
  parent.blocks.push(block);
  subFold.openThinkingIndex = parent.blocks.length - 1;
  let cloned = session.clonedSubBlocks.get(parentIndex);
  if (!cloned) {
    cloned = new Set();
    session.clonedSubBlocks.set(parentIndex, cloned);
  }
  cloned.add(subFold.openThinkingIndex);
  return block;
}

function subEnsureContent(
  session: Session,
  parentIndex: number,
  subFold: SubagentFoldIndexes,
  ts?: number,
): ContentBlock {
  const parent = blockForWrite<SubagentBlock>(session, parentIndex);
  if (subFold.openThinkingIndex !== null) {
    const thinking = subBlockForWrite<ThinkingBlock>(session, parentIndex, subFold.openThinkingIndex);
    if (thinking.endedAt === undefined && ts !== undefined) thinking.endedAt = ts;
    subFold.openThinkingIndex = null;
  }
  if (subFold.openContentIndex !== null) {
    return subBlockForWrite<ContentBlock>(session, parentIndex, subFold.openContentIndex);
  }
  const block: ContentBlock = { kind: "content", id: nextBlockId(session), text: "" };
  parent.blocks.push(block);
  subFold.openContentIndex = parent.blocks.length - 1;
  let cloned = session.clonedSubBlocks.get(parentIndex);
  if (!cloned) {
    cloned = new Set();
    session.clonedSubBlocks.set(parentIndex, cloned);
  }
  cloned.add(subFold.openContentIndex);
  return block;
}

function applySubagentInnerEvent(session: Session, key: string, inner: RawEvent): void {
  const fold = session.state.fold;
  const parentIndex = fold.subagentIndexByKey[key];
  const subFold = fold.subFolds[key];
  if (parentIndex === undefined || !subFold) return;
  const type = inner.type;

  if (type === "RAW_SSE_EVENT") {
    const parsed = parseRawSseEvent(String(inner.raw_sse ?? ""));
    if (parsed) applySubagentInnerEvent(session, key, parsed);
    return;
  }

  if (type === "CUSTOM" && inner.name === BEFORE_AGENT_EVENT_TYPE) {
    const prompt = String(inner.value?.message ?? "");
    if (prompt) {
      const block = blockForWrite<SubagentBlock>(session, parentIndex);
      block.prompt = block.prompt || prompt;
      block.description = block.description || prompt;
    }
    return;
  }

  if (type === "CUSTOM" && inner.name === HITL_INTERRUPT_EVENT_TYPE) {
    const approval = pushInterrupt(session, inner.value, key);
    // A pending approval never opens a thinking block of its own — the
    // input-bar takeover is the approval surface. It binds onto the stalled
    // tool step in the sub-agent's open block; a chip item is the fallback
    // for interrupts that don't gate a tool call.
    if (approval && subFold.openThinkingIndex !== null) {
      const thinking = subBlockForWrite<ThinkingBlock>(session, parentIndex, subFold.openThinkingIndex);
      if (!bindInterruptToTool(thinking, approval)) {
        thinking.items.push(approval);
      }
    }
    return;
  }

  if (type === "THINKING_TEXT_MESSAGE_CONTENT") {
    const thinking = subEnsureThinking(session, parentIndex, subFold, eventTimestamp(inner));
    const thought: TimelineThought = { kind: "thought", id: nextItemId(session), text: String(inner.delta ?? "") };
    thinking.items.push(thought);
    return;
  }

  if (TEXT_DELTA_TYPES.has(type)) {
    const content = subEnsureContent(session, parentIndex, subFold, eventTimestamp(inner));
    content.text += String(inner.delta ?? "");
    return;
  }

  if (type === "TEXT_MESSAGE_END") {
    subFold.openContentIndex = null;
    return;
  }

  if (type === "TOOL_CALL_START" || type === "TOOL_CALL_ARGS" || type === "TOOL_CALL_END" || type === "TOOL_CALL_RESULT") {
    applyToolEvent(
      session,
      inner,
      subFold.toolPaths,
      (index) => subBlockForWrite<ThinkingBlock>(session, parentIndex, index),
      (ts) => subEnsureThinking(session, parentIndex, subFold, ts),
      () => subFold.openThinkingIndex,
      () => {
        const retool = subFold.pendingRetool;
        subFold.pendingRetool = null;
        return retool;
      },
    );
  }
}

// ------------------------------------------------------
// Event dispatch
// ------------------------------------------------------
function applyEvent(session: Session, event: RawEvent): void {
  const type = event.type;
  if (typeof type !== "string") return;

  if (type === "CUSTOM") {
    const name = event.name;
    if (typeof name !== "string") return;

    if (PLAN_EVENT_NAMES.has(name)) {
      const parsed = PlanSnapshotSchema.safeParse(event.value);
      if (parsed.success) session.state.plan = parsed.data;
      return;
    }

    if (name === TOKEN_USAGE_EVENT_TYPE) {
      // Collect-only: per-message token usage is persisted on the message DTO
      // (MessageOut.inputTokens/outputTokens). The live timeline neither folds
      // nor renders it yet — explicit no-op so it isn't an unhandled event.
      return;
    }

    if (name === TASK_SUBAGENT_EVENT_TYPE) {
      const parsed = TaskSubAgentPayloadSchema.safeParse(event.value);
      if (!parsed.success) return;
      const { block } = ensureSubagentBlock(session, parsed.data.task_id, eventTimestamp(event));
      block.type = block.type || parsed.data.subagent_type;
      block.label = block.label || toTitleCase(parsed.data.subagent_type);
      block.description = block.description || parsed.data.description;
      return;
    }

    if (name === SUBAGENT_EVENT_TYPE) {
      const parsed = SubAgentPayloadSchema.safeParse(event.value);
      if (!parsed.success) return;
      const wrapper = parsed.data;
      const inner = wrapper.event as RawEvent;
      const fold = session.state.fold;
      // The LangGraph namespace is the stable identity of a subagent across the
      // whole run, including a HITL pause+resume. The wrapper.task_id is NOT
      // stable: when a subagent's own tool is gated, the resume stream comes
      // through a fresh normalizer that can't rebind and falls back to the raw
      // namespace id — which would orphan the continuation into a new block.
      // So route by namespace once it's been seen, only deriving a fresh key
      // (and aliasing the namespace to it) on the first sighting.
      const nsKey = wrapper.namespace.join(" / ");
      let key = nsKey ? fold.namespaceToKey[nsKey] : undefined;
      if (key === undefined) {
        // BEFORE_AGENT's metadata.namespace is the public id for fallback task
        // ids minted from the LangGraph namespace when tool-call binding fails.
        const beforeAgentNamespace =
          inner?.type === "CUSTOM" && inner?.name === BEFORE_AGENT_EVENT_TYPE
            ? String(inner.value?.metadata?.namespace ?? "")
            : "";
        if (beforeAgentNamespace) {
          fold.taskIdRemap[wrapper.task_id] = beforeAgentNamespace;
          key = beforeAgentNamespace;
        } else {
          key = fold.taskIdRemap[wrapper.task_id] || wrapper.task_id;
        }
        if (nsKey) fold.namespaceToKey[nsKey] = key;
      }
      const { block } = ensureSubagentBlock(session, key, eventTimestamp(event));
      block.namespace = block.namespace || wrapper.namespace.join(" / ");
      block.label = block.label || toTitleCase(block.type);
      if (inner && typeof inner === "object") {
        applySubagentInnerEvent(session, key, inner);
      }
      return;
    }

    if (name === HITL_INTERRUPT_EVENT_TYPE) {
      const approval = pushInterrupt(session, event.value);
      // Same rule as sub-agent interrupts: never open a lone "Waiting for
      // approval" thinking block — the takeover owns the pending state. The
      // approval binds onto the stalled tool step; a chip item is the
      // fallback for interrupts that don't gate a tool call.
      if (approval && session.state.fold.openThinkingIndex !== null) {
        const thinking = blockForWrite<ThinkingBlock>(session, session.state.fold.openThinkingIndex);
        if (!bindInterruptToTool(thinking, approval)) {
          thinking.items.push(approval);
        }
      }
      return;
    }

    if (name === BRIDGE_HITL_RESOLVED_EVENT_TYPE) {
      const value = (event.value ?? {}) as Record<string, any>;
      const interruptId = value.interrupt_id != null ? String(value.interrupt_id) : null;
      // Per-action outcomes for a batched interrupt (index-aligned to the
      // action_requests). Map the raw {decision,reason} list to {status,reason}.
      const rawDecisions = Array.isArray(value.decisions) ? value.decisions : null;
      const decisions: TimelineHitlActionOutcome[] | undefined = rawDecisions
        ? rawDecisions.map((d: Record<string, any>) => ({
            status: d?.decision === "reject" ? "rejected" : "approved",
            reason: d?.reason ?? null,
          }))
        : undefined;
      resolveInterrupt(session, interruptId, value.decision, value.reason ?? null, decisions);
      return;
    }

    return;
  }

  if (type === "THINKING_START") {
    ensureThinking(session, eventTimestamp(event));
    return;
  }

  if (type === "THINKING_TEXT_MESSAGE_CONTENT") {
    const thinking = ensureThinking(session, eventTimestamp(event));
    const thought: TimelineThought = { kind: "thought", id: nextItemId(session), text: String(event.delta ?? "") };
    thinking.items.push(thought);
    return;
  }

  if (type === "THINKING_END") {
    closeThinking(session, eventEndTimestamp(event));
    return;
  }

  if (type === "TOOL_CALL_START" || type === "TOOL_CALL_ARGS" || type === "TOOL_CALL_END" || type === "TOOL_CALL_RESULT") {
    applyToolEvent(
      session,
      event,
      session.state.fold.toolPaths,
      (index) => blockForWrite<ThinkingBlock>(session, index),
      (ts) => ensureThinking(session, ts),
      () => session.state.fold.openThinkingIndex,
      () => {
        const retool = session.state.fold.pendingRetool;
        session.state.fold.pendingRetool = null;
        return retool;
      },
    );
    return;
  }

  if (TEXT_DELTA_TYPES.has(type)) {
    const content = ensureContent(session, eventTimestamp(event));
    content.text += String(event.delta ?? "");
    return;
  }

  if (type === "TEXT_MESSAGE_START") {
    closeThinking(session, eventTimestamp(event));
    return;
  }

  if (type === "TEXT_MESSAGE_END") {
    session.state.fold.openContentIndex = null;
    return;
  }
  // RUN_STARTED / RUN_FINISHED / RUN_ERROR / unknown types carry no timeline
  // structure; terminal state arrives via finalizeTimeline from run status.
}

export function reduceTimelineEvents(state: RunTimeline, events: RawEvent[]): RunTimeline {
  if (!events.length || state.terminal) return state;
  const session = openSession(state);
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const seq = typeof event.seq === "number" ? event.seq : null;
    if (seq !== null && seq <= session.state.lastSeq) continue;
    try {
      applyEvent(session, event);
    } catch {
      // A malformed event must never take down the timeline; skip it.
    }
    if (seq !== null) session.state.lastSeq = seq;
  }
  return session.state;
}

// The Done sentinel: fires ONLY on a terminal run status — never on
// THINKING_END — so a HITL-paused run keeps its open, done-less timeline.
export function finalizeTimeline(state: RunTimeline, status: TimelineTerminalStatus): RunTimeline {
  if (state.terminal && state.terminalStatus === status) return state;
  const session = openSession(state);
  closeThinking(session);
  session.state.fold.openContentIndex = null;
  for (const [key, subFold] of Object.entries(session.state.fold.subFolds)) {
    const parentIndex = session.state.fold.subagentIndexByKey[key];
    if (parentIndex === undefined) continue;
    if (subFold.openThinkingIndex !== null) {
      subBlockForWrite<ThinkingBlock>(session, parentIndex, subFold.openThinkingIndex);
      subFold.openThinkingIndex = null;
    }
    subFold.openContentIndex = null;
  }
  session.state.terminal = true;
  session.state.terminalStatus = status;
  return session.state;
}

export const TERMINAL_TIMELINE_STATUSES = new Set(["completed", "cancelled", "failed"]);

function asTerminalStatus(status?: string | null): TimelineTerminalStatus | null {
  return status && TERMINAL_TIMELINE_STATUSES.has(status) ? (status as TimelineTerminalStatus) : null;
}

type LegacyMessageShape = {
  content?: string | null;
  thinking?: string[] | null;
};

function isFullEventLog(events: RawEvent[]): boolean {
  return events.some((event) => event && typeof event === "object" && FULL_LOG_TYPES.has(event.type));
}

// Pre-rebuild messages persisted a CUSTOM-only log (plan/subagent/HITL); text
// and thinking lived solely in the aggregated columns. Reconstruct a coarse
// [Thinking, …subagents…, Content] timeline from those aggregates so old
// conversations keep rendering forever.
function foldLegacyTimeline(
  events: RawEvent[],
  legacy: LegacyMessageShape,
  status: TimelineTerminalStatus | null,
): RunTimeline {
  // Seed the thinking block BEFORE folding the CUSTOM events so the fold's
  // block indexes (subagent positions, open-block pointers) stay valid.
  const base = createTimeline();
  const thoughts = (legacy.thinking ?? []).filter((entry) => typeof entry === "string" && entry.trim());
  if (thoughts.length) {
    const items = thoughts.map((entry, index): ThinkingBlock["items"][number] => {
      const toolMatch = entry.match(/^\[tool\]\s*(.+)$/);
      if (toolMatch) {
        return {
          kind: "tool",
          id: `legacy-tool-${index}`,
          name: toolMatch[1],
          argsText: "",
          state: "output-available",
        };
      }
      return { kind: "thought", id: `legacy-thought-${index}`, text: entry };
    });
    base.blocks.push({ kind: "thinking", id: "legacy-thinking", items });
  }

  let state = reduceTimelineEvents(base, events);
  if ((legacy.content ?? "").trim()) {
    state = {
      ...state,
      blocks: [...state.blocks, { kind: "content", id: "legacy-content", text: legacy.content ?? "" }],
    };
  }
  return finalizeTimeline(state, status ?? "completed");
}

export function foldTimeline(
  events: RawEvent[] | null | undefined,
  opts?: { status?: string | null; legacyMessage?: LegacyMessageShape },
): RunTimeline {
  const safeEvents = Array.isArray(events) ? events : [];
  const terminalStatus = asTerminalStatus(opts?.status);
  const legacy = opts?.legacyMessage;
  const hasLegacyAggregates = Boolean(legacy && ((legacy.content ?? "").trim() || legacy.thinking?.length));

  if (!isFullEventLog(safeEvents) && hasLegacyAggregates) {
    return foldLegacyTimeline(safeEvents, legacy as LegacyMessageShape, terminalStatus);
  }

  let state = reduceTimelineEvents(createTimeline(), safeEvents);
  if (terminalStatus) {
    state = finalizeTimeline(state, terminalStatus);
  }
  return state;
}

export function pendingTimelineInterrupts(timeline: RunTimeline | null | undefined): TimelineHitlApproval[] {
  if (!timeline) return [];
  return timeline.interrupts.filter((item) => item.status === "pending");
}

// Adapter feeding the SubagentCard component (the established sub-agent
// container UI) from a folded SubagentBlock: one instructions block, one
// answer block, one tools block — the card renders those sections itself.
export function subagentBlockToItem(block: SubagentBlock): SubagentItem {
  const tools: NonNullable<SubagentItem["tools"]> = [];
  const interrupts: NonNullable<SubagentItem["interrupts"]> = [];
  let text = "";
  for (const nested of block.blocks) {
    if (nested.kind === "content") {
      text += nested.text;
      continue;
    }
    for (const item of nested.items) {
      if (item.kind === "tool") {
        tools.push({
          id: item.id,
          name: item.name,
          status:
            item.state === "output-error"
              ? "error"
              : item.state === "output-available"
                ? "completed"
                : "running",
          args: item.argsText || undefined,
          result: item.result,
        });
        if (item.approval) {
          interrupts.push({ threadId: item.approval.threadId, content: item.approval.content });
        }
      } else if (item.kind === "hitl") {
        interrupts.push({ threadId: item.threadId, content: item.content });
      }
    }
  }
  return {
    id: block.taskId,
    label: block.label,
    type: block.type,
    description: block.description,
    namespace: block.namespace,
    prompt: block.prompt,
    text: text || undefined,
    tools,
    interrupts,
  };
}

// Flat thought strings in the legacy `thinking: string[]` shape — feeds
// ThinkingState consumers (transition gating, voice) that don't render blocks.
export function timelineThoughtStrings(timeline: RunTimeline | null | undefined): string[] {
  if (!timeline) return [];
  const thoughts: string[] = [];
  for (const block of timeline.blocks) {
    if (block.kind !== "thinking") continue;
    for (const item of block.items) {
      if (item.kind === "thought") thoughts.push(item.text);
      else if (item.kind === "tool") thoughts.push(`[tool] ${item.name}`);
    }
  }
  return thoughts;
}
