import {
  BEFORE_AGENT_EVENT_TYPE,
  CONTEXT_COMPACTION_EVENT_TYPE,
  ContextCompactionPayloadSchema,
  HITL_INTERRUPT_EVENT_TYPE,
  HITLInterruptPayloadSchema,
  PLAN_SNAPSHOT_EVENT_NAMES,
  PlanSnapshotSchema,
  PRESENT_ARTIFACT_EVENT_TYPE,
  PresentArtifactPayloadSchema,
  RENDER_CHART_EVENT_TYPE,
  RenderChartPayloadSchema,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_EVENT_TYPE,
  SubAgentCompletedPayloadSchema,
  SubAgentPayloadSchema,
  TASK_SUBAGENT_EVENT_TYPE,
  TaskSubAgentPayloadSchema,
  TOKEN_USAGE_EVENT_TYPE,
  TokenUsagePayloadSchema,
} from "./agui";
import { askUserAnswers, askUserQuestions, isAskUserInterrupt, parseHitlInterrupt } from "./hitl";
import { advancePlanTimings, planSnapshotTime } from "./planTiming";
import type {
  ArtifactBlock,
  ChartBlock,
  CompactionBlock,
  ContentBlock,
  PendingToolRetool,
  RunTimeline,
  SubagentBlock,
  SubagentFoldIndexes,
  SubagentRunStatus,
  ThinkingBlock,
  TimelineBlock,
  TimelineFoldIndexes,
  AskUserAnswer,
  TimelineHitlActionOutcome,
  TimelineHitlApproval,
  TimelineTerminalStatus,
  TimelineThought,
  TimelineToolExecution,
} from "@/shared/lib/types";
import type { SubagentItem } from "@/shared/lib/types";

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
    ...(fold.nestedTasks ? { nestedTasks: { ...fold.nestedTasks } } : {}),
    subFolds: Object.fromEntries(
      Object.entries(fold.subFolds).map(([key, sub]) => [
        key,
        { ...sub, toolPaths: { ...sub.toolPaths } },
      ]),
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
// Automatic compaction (plan 34)
// ------------------------------------------------------
/**
 * `started` opens a divider at the log position — closing the open blocks, as a
 * chart does, so the thinking before it and the answer after it sit on either
 * side; `done` fills in the running one (or adds a finished one, when the
 * summary call streamed nothing to announce it).
 */
function foldCompaction(
  session: Session,
  data: {
    phase: "started" | "done";
    tokens_before?: number | null;
    tokens_after?: number | null;
    freed?: number | null;
    window?: number | null;
    summarized_messages?: number | null;
    kept_messages?: number | null;
  },
  ts?: number,
): void {
  const blocks = session.state.blocks;
  let index = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "compaction" && block.status === "running") {
      index = i;
      break;
    }
  }
  if (data.phase === "started" && index >= 0) return;

  const details: Partial<CompactionBlock> = {
    tokensBefore: data.tokens_before ?? undefined,
    tokensAfter: data.tokens_after ?? undefined,
    freed: data.freed ?? undefined,
    window: data.window ?? undefined,
    summarizedMessages: data.summarized_messages ?? undefined,
    keptMessages: data.kept_messages ?? undefined,
  };
  if (data.phase === "done" && index >= 0) {
    Object.assign(blockForWrite<CompactionBlock>(session, index), details, { status: "done" });
    return;
  }
  closeThinking(session, ts);
  session.state.fold.openContentIndex = null;
  const block: CompactionBlock = {
    kind: "compaction",
    id: nextBlockId(session),
    status: data.phase === "started" ? "running" : "done",
    ...(data.phase === "done" ? details : {}),
  };
  blocks.push(block);
  session.clonedBlocks.add(blocks.length - 1);
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
  const block: ThinkingBlock = {
    kind: "thinking",
    id: nextBlockId(session),
    items: [],
    startedAt: ts,
  };
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

function pushArtifactBlock(
  session: Session,
  data: {
    artifact_id?: string | null;
    path?: string | null;
    filename?: string | null;
    title?: string | null;
    summary?: string | null;
    mime?: string | null;
  },
  ts?: number,
): void {
  const path = typeof data.path === "string" ? data.path : "";
  const filename =
    (typeof data.filename === "string" && data.filename) ||
    path.replace(/\/+$/, "").split("/").pop() ||
    "";
  if (!filename) return; // nothing renderable — skip like any malformed event
  // Interleave at the log position (same discipline as a sub-agent panel):
  // close both open blocks so any later orchestrator text starts a fresh
  // content block *below* the artifact card, giving the "text → file → text"
  // flow the agent emitted.
  const fold = session.state.fold;
  closeThinking(session, ts);
  fold.openContentIndex = null;
  const block: ArtifactBlock = {
    kind: "artifact",
    id: nextBlockId(session),
    artifactId: typeof data.artifact_id === "string" ? data.artifact_id : "",
    path,
    filename,
    title: data.title || undefined,
    summary: data.summary || undefined,
    mime: data.mime || undefined,
  };
  session.state.blocks.push(block);
  session.clonedBlocks.add(session.state.blocks.length - 1);
}

function pushChartBlock(
  session: Session,
  data: {
    chart_id: string;
    type: ChartBlock["chartType"];
    title: string;
    subtitle?: string | null;
    x_key: string;
    series: {
      key: string;
      label: string;
      type?: "bar" | "line" | "area" | null;
      axis?: "left" | "right" | null;
    }[];
    data: Record<string, string | number | null>[];
    stacked?: boolean | null;
    horizontal?: boolean | null;
    show_values?: boolean | null;
  },
  ts?: number,
): void {
  // Interleave at the log position, exactly as an artifact card does: close
  // both open blocks so any orchestrator text after the chart starts a fresh
  // content block below it, preserving the "text -> chart -> text" order.
  const fold = session.state.fold;
  closeThinking(session, ts);
  fold.openContentIndex = null;
  const block: ChartBlock = {
    kind: "chart",
    id: nextBlockId(session),
    chartId: data.chart_id,
    chartType: data.type,
    title: data.title,
    subtitle: data.subtitle || undefined,
    xKey: data.x_key,
    series: data.series.map((s) => ({
      key: s.key,
      label: s.label,
      ...(s.type ? { type: s.type } : {}),
      ...(s.axis ? { axis: s.axis } : {}),
    })),
    data: data.data,
    stacked: Boolean(data.stacked),
    horizontal: Boolean(data.horizontal),
    showValues: Boolean(data.show_values),
  };
  session.state.blocks.push(block);
  session.clonedBlocks.add(session.state.blocks.length - 1);
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
  // Retained for signature symmetry with the sibling applyXEvent handlers; the
  // underscore marks it as intentionally unread.
  _session: Session,
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
function pushInterrupt(
  session: Session,
  raw: RawEvent,
  subagentId?: string,
): TimelineHitlApproval | null {
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
  // The agent's clarifying questions: the item carries them, so the record of
  // what was asked (and later answered) needs nothing else.
  if (isAskUserInterrupt(wrapped)) approval.questions = askUserQuestions(wrapped);
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
  // `ask_user` gates no tool call (and has no tool step of its own): with no
  // action names to match it would otherwise latch onto whatever tool is
  // still running.
  if (approval.questions) return false;
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
    let pick = candidates.find(
      (ci) =>
        !used.has(ci) &&
        (!action.toolName || (block.items[ci] as TimelineToolExecution).name === action.toolName),
    );
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
  answers?: AskUserAnswer[],
): void {
  const interrupts = session.state.interrupts;
  const targetId = interruptId ?? interrupts.find((item) => item.status === "pending")?.id ?? null;
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
    interrupts[index] = {
      ...interrupts[index],
      status,
      reason: reason ?? null,
      decisions,
      ...(answers ? { answers } : {}),
    };
  }

  const resolveInBlock = (
    block: ThinkingBlock,
    write: () => ThinkingBlock,
    recordRetool: (item: number, name: string) => void,
  ): void => {
    block.items.forEach((item, itemIndex) => {
      if (item.kind === "hitl" && item.id === targetId) {
        write().items[itemIndex] = {
          ...item,
          status,
          reason: reason ?? null,
          ...(answers ? { answers } : {}),
        };
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
  settleAwaitingSubagents(session);
}

// ------------------------------------------------------
// Subagents
// ------------------------------------------------------
export function toTitleCase(value?: string): string | undefined {
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
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
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

function ensureSubagentBlock(
  session: Session,
  key: string,
  ts?: number,
): { block: SubagentBlock; index: number } {
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
    status: "pending",
    blocks: [],
  };
  session.state.blocks.push(block);
  const index = session.state.blocks.length - 1;
  fold.subagentIndexByKey[key] = index;
  fold.subFolds[key] = {
    openThinkingIndex: null,
    openContentIndex: null,
    toolPaths: {},
    pendingRetool: null,
  };
  // Deliberately does NOT bump subagentCount: a block starts unspawned, and the
  // count tracks sub-agents that actually ran. See markSubagentSpawned.
  session.clonedBlocks.add(index);
  return { block, index };
}

/**
 * Record that a sub-agent actually started, and keep `subagentCount` in step.
 *
 * `subagentCount` drives the action-bar badge and whether the panel opens at
 * all, so it counts spawned sub-agents only. Counting blocks instead meant a
 * `task` call the user REJECTED still showed up as a delegated task — it opened
 * a block via TASK_SUBAGENT (emitted at tool-call time, before the HITL gate)
 * and then sat there forever with no response and no tool activity.
 */
function markSubagentSpawned(
  session: Session,
  key: string,
  block: SubagentBlock,
  ts?: number,
): void {
  // Events from inside it: it is working — unless it is parked on its own
  // approval (an event can still trail the interrupt) or already returned.
  if (
    block.status === undefined ||
    block.status === "pending" ||
    (block.status === "awaiting_approval" && !hasPendingSubagentInterrupt(session, key))
  ) {
    block.status = "running";
  }
  if (block.startedAt === undefined && ts !== undefined) block.startedAt = ts;
  if (block.spawned) return;
  block.spawned = true;
  let count = 0;
  for (const candidate of session.state.blocks) {
    if (candidate.kind === "subagent" && candidate.spawned) count += 1;
  }
  session.state.subagentCount = count;
}

const SUBAGENT_SETTLED = new Set<SubagentRunStatus>(["done", "failed", "cancelled"]);

function isSubagentSettled(block: SubagentBlock): boolean {
  return block.status !== undefined && SUBAGENT_SETTLED.has(block.status);
}

function hasPendingSubagentInterrupt(session: Session, key: string): boolean {
  return session.state.interrupts.some(
    (item) => item.status === "pending" && item.subagentId === key,
  );
}

/** The fold key of the sub-agent block at `index` (the reverse of subagentIndexByKey). */
function subagentKeyAt(session: Session, index: number): string | undefined {
  return Object.entries(session.state.fold.subagentIndexByKey).find(
    ([, value]) => value === index,
  )?.[0];
}

/**
 * After an approval resolves: a sub-agent that was waiting on it goes back to
 * running (spawned) or to pending (a `task` call approved but not started yet;
 * a rejected one stays pending and is never shown once the run settles).
 */
function settleAwaitingSubagents(session: Session): void {
  const topLevelPending = session.state.interrupts.some(
    (item) => item.status === "pending" && !item.subagentId,
  );
  session.state.blocks.forEach((block, index) => {
    if (block.kind !== "subagent" || block.status !== "awaiting_approval") return;
    if (block.spawned) {
      const key = subagentKeyAt(session, index);
      if (key && hasPendingSubagentInterrupt(session, key)) return;
      blockForWrite<SubagentBlock>(session, index).status = "running";
    } else if (!topLevelPending) {
      blockForWrite<SubagentBlock>(session, index).status = "pending";
    }
  });
}

/**
 * The block a SUBAGENT_COMPLETED refers to. The event carries the `task`
 * tool-call id, while SUBAGENT_EVENT routes by LangGraph namespace (plus the
 * taskIdRemap aliasing): normally both land on the TASK_SUBAGENT block, but when
 * the service could not bind a namespace to its call (a resume that lost the
 * binding) the sub-agent's events opened a second, namespace-keyed block and
 * the call-id block stayed unspawned. Prefer the call-id block when it really
 * ran; otherwise the block the event's namespace was routed to.
 */
function resolveCompletedSubagent(
  session: Session,
  taskId: string,
  namespace: string[] | null | undefined,
): { index: number; aliasIndex?: number } | null {
  const fold = session.state.fold;
  const remapped = fold.taskIdRemap[taskId];
  const byId =
    fold.subagentIndexByKey[taskId] ??
    (remapped !== undefined ? fold.subagentIndexByKey[remapped] : undefined);
  const nsKey = namespace?.length ? fold.namespaceToKey[namespace.join(" / ")] : undefined;
  const byNamespace = nsKey !== undefined ? fold.subagentIndexByKey[nsKey] : undefined;
  const spawned = (index: number) =>
    Boolean((session.state.blocks[index] as SubagentBlock).spawned);
  if (byId !== undefined && spawned(byId)) return { index: byId };
  if (byNamespace !== undefined) {
    return byId !== undefined && byId !== byNamespace
      ? { index: byNamespace, aliasIndex: byId }
      : { index: byNamespace };
  }
  return byId !== undefined ? { index: byId } : null;
}

function applySubagentCompleted(session: Session, event: RawEvent): void {
  const parsed = SubAgentCompletedPayloadSchema.safeParse(event.value);
  if (!parsed.success) return;
  const { task_id, status, namespace, started_at, ended_at } = parsed.data;
  const target = resolveCompletedSubagent(session, task_id, namespace);
  if (!target) return;
  const block = blockForWrite<SubagentBlock>(session, target.index);
  block.status = status === "error" ? "failed" : "done";
  block.endedByRun = undefined;
  block.endedAt = ended_at ?? eventTimestamp(event) ?? block.endedAt;
  if (block.startedAt === undefined && typeof started_at === "number") {
    block.startedAt = started_at;
  }
  if (target.aliasIndex !== undefined) {
    // The orphaned call-id block: give its task metadata to the block that
    // really ran, and settle it (it is unspawned, so it is never shown).
    const alias = blockForWrite<SubagentBlock>(session, target.aliasIndex);
    block.type = block.type || alias.type;
    block.label = alias.label || block.label;
    block.description = block.description || alias.description;
    alias.status = block.status;
  }
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
  const block: ThinkingBlock = {
    kind: "thinking",
    id: nextBlockId(session),
    items: [],
    startedAt: ts,
  };
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
    const thinking = subBlockForWrite<ThinkingBlock>(
      session,
      parentIndex,
      subFold.openThinkingIndex,
    );
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

/** Sub-agent mirror of `closeThinking` — closes the open thinking block of one
 *  sub-agent panel and stamps its end time. */
function subCloseThinking(
  session: Session,
  parentIndex: number,
  subFold: SubagentFoldIndexes,
  ts?: number,
): void {
  if (subFold.openThinkingIndex === null) return;
  const block = subBlockForWrite<ThinkingBlock>(session, parentIndex, subFold.openThinkingIndex);
  if (block.endedAt === undefined && ts !== undefined) {
    block.endedAt = ts;
  }
  subFold.openThinkingIndex = null;
}

/**
 * Give a nested sub-agent's block what its parent's `task` call said: its type,
 * its task and the parent it works for (the agent map's link; the namespace
 * path carries the same link when the call was not seen).
 */
function applyNestedTask(block: SubagentBlock, fold: TimelineFoldIndexes, key: string): void {
  const nested = fold.nestedTasks?.[key];
  if (!nested) return;
  block.parentTaskId = block.parentTaskId || nested.parentKey;
  block.type = block.type || nested.type;
  block.label = block.label || toTitleCase(nested.type);
  block.description = block.description || nested.description;
}

/**
 * Fold one event that happened *inside* a sub-agent.
 *
 * This mirrors `applyEvent`, differing only in where it writes (a sub-agent
 * panel's blocks instead of the top-level list). The two tables had silently
 * drifted: `THINKING_START`, `THINKING_END`, `TEXT_MESSAGE_START` and
 * `BRIDGE_HITL_RESOLVED` were handled only at top level, so a sub-agent's
 * thinking block never opened or closed on its own events and — worse — an
 * approval resolved inside a sub-agent never flipped to resolved.
 *
 * The remaining asymmetry is deliberate, not drift:
 *   - `RAW_SSE_EVENT` is sub-only: nested envelopes only arrive inside a
 *     sub-agent stream.
 *   - `SUBAGENT_EVENT`, `PRESENT_ARTIFACT`, `RENDER_CHART` and `TOKEN_USAGE`
 *     are orchestrator-only: they describe the run as a whole, and the
 *     orchestrator is the only emitter (usage is accounted per run).
 *   - `TASK_SUBAGENT` differs on purpose: a sub-agent that delegates in turn
 *     calls `task` inside its own stream. That nested sub-agent's events still
 *     arrive as top-level `SUBAGENT_EVENT`s (one envelope, its namespace one
 *     level deeper), so they open a block of their own; here the call only
 *     records what it was asked and by whom, for that block to pick up.
 *   - `SUBAGENT_COMPLETED` is the same case: the nested `task` call's result is
 *     a message of the delegating sub-agent's graph, so its completion arrives
 *     inside that sub-agent's envelope. It settles the nested block (its own
 *     block, by call id or namespace), never a step of the envelope's owner.
 * Add a new event type to BOTH unless it falls into one of those groups.
 */
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

  if (type === "THINKING_START") {
    subEnsureThinking(session, parentIndex, subFold, eventTimestamp(inner));
    return;
  }

  if (type === "THINKING_END") {
    subCloseThinking(session, parentIndex, subFold, eventEndTimestamp(inner));
    return;
  }

  if (type === "TEXT_MESSAGE_START") {
    subCloseThinking(session, parentIndex, subFold, eventTimestamp(inner));
    return;
  }

  if (type === "CUSTOM" && inner.name === BRIDGE_HITL_RESOLVED_EVENT_TYPE) {
    // Interrupts live in one flat list on the run regardless of which scope
    // raised them, so resolution is scope-agnostic — the sub-agent path simply
    // never called it, leaving an approved sub-agent action stuck as pending.
    const value = (inner.value ?? {}) as Record<string, any>;
    const interruptId = value.interrupt_id != null ? String(value.interrupt_id) : null;
    const rawDecisions = Array.isArray(value.decisions) ? value.decisions : null;
    const decisions: TimelineHitlActionOutcome[] | undefined = rawDecisions
      ? rawDecisions.map((d: Record<string, any>) => ({
          status: d?.decision === "reject" ? "rejected" : "approved",
          reason: d?.reason ?? null,
        }))
      : undefined;
    resolveInterrupt(
      session,
      interruptId,
      value.decision,
      value.reason ?? null,
      decisions,
      askUserAnswers(value.answers),
    );
    return;
  }

  if (type === "CUSTOM" && inner.name === TASK_SUBAGENT_EVENT_TYPE) {
    const parsed = TaskSubAgentPayloadSchema.safeParse(inner.value);
    if (!parsed.success) return;
    fold.nestedTasks = {
      ...fold.nestedTasks,
      [parsed.data.task_id]: {
        parentKey: key,
        type: parsed.data.subagent_type,
        description: parsed.data.description,
      },
    };
    const nestedIndex = fold.subagentIndexByKey[parsed.data.task_id];
    if (nestedIndex !== undefined) {
      applyNestedTask(
        blockForWrite<SubagentBlock>(session, nestedIndex),
        fold,
        parsed.data.task_id,
      );
    }
    // Mark the moment in the delegating sub-agent's own steps — once: a resume
    // replays the step that made the call.
    const parent = session.state.blocks[parentIndex] as SubagentBlock;
    const marked = parent.blocks.some(
      (nested) =>
        nested.kind === "thinking" &&
        nested.items.some(
          (item) => item.kind === "delegation" && item.taskId === parsed.data.task_id,
        ),
    );
    if (!marked) {
      subEnsureThinking(session, parentIndex, subFold, eventTimestamp(inner)).items.push({
        kind: "delegation",
        id: nextItemId(session),
        taskId: parsed.data.task_id,
        type: parsed.data.subagent_type,
        description: parsed.data.description,
      });
    }
    return;
  }

  if (type === "CUSTOM" && inner.name === SUBAGENT_COMPLETED_EVENT_TYPE) {
    applySubagentCompleted(session, inner);
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
    const owner = blockForWrite<SubagentBlock>(session, parentIndex);
    if (approval && !isSubagentSettled(owner)) owner.status = "awaiting_approval";
    // A pending approval never opens a thinking block of its own — the
    // input-bar takeover is the approval surface. It binds onto the stalled
    // tool step in the sub-agent's open block; a chip item is the fallback
    // for interrupts that don't gate a tool call.
    if (approval?.questions) {
      // Not expected (ask_user is the main agent's), but kept like the
      // orchestrator's: the record of the questions needs a block to live in.
      subEnsureThinking(session, parentIndex, subFold, eventTimestamp(inner)).items.push(approval);
    } else if (approval && subFold.openThinkingIndex !== null) {
      const thinking = subBlockForWrite<ThinkingBlock>(
        session,
        parentIndex,
        subFold.openThinkingIndex,
      );
      if (!bindInterruptToTool(thinking, approval)) {
        thinking.items.push(approval);
      }
    }
    return;
  }

  if (type === "THINKING_TEXT_MESSAGE_CONTENT") {
    const thinking = subEnsureThinking(session, parentIndex, subFold, eventTimestamp(inner));
    const thought: TimelineThought = {
      kind: "thought",
      id: nextItemId(session),
      text: String(inner.delta ?? ""),
    };
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

  if (
    type === "TOOL_CALL_START" ||
    type === "TOOL_CALL_ARGS" ||
    type === "TOOL_CALL_END" ||
    type === "TOOL_CALL_RESULT"
  ) {
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
      if (parsed.success) {
        // Each step's start and finish, from the snapshots' own times (planTiming).
        session.state.planTimings = advancePlanTimings(
          session.state.plan,
          session.state.planTimings,
          parsed.data,
          planSnapshotTime(parsed.data, event),
        );
        session.state.plan = parsed.data;
      }
      return;
    }

    if (name === TOKEN_USAGE_EVENT_TYPE) {
      // Totals are persisted on the message DTO; the live timeline keeps only
      // the main agent's context on its latest call, for the context gauge.
      // (Sub-agent usage arrives wrapped and never reaches this branch.)
      const parsed = TokenUsagePayloadSchema.safeParse(event.value);
      const usage = parsed.success ? parsed.data : null;
      if (usage && typeof usage.context_tokens === "number") {
        session.state.context = {
          model: usage.model ?? undefined,
          tokens: usage.context_tokens,
          window: usage.context_window ?? undefined,
          percent: usage.context_percent ?? undefined,
          compactionPercent: usage.compaction_percent ?? undefined,
        };
      }
      return;
    }

    if (name === PRESENT_ARTIFACT_EVENT_TYPE) {
      const parsed = PresentArtifactPayloadSchema.safeParse(event.value);
      if (!parsed.success) return;
      pushArtifactBlock(session, parsed.data, eventTimestamp(event));
      return;
    }

    if (name === RENDER_CHART_EVENT_TYPE) {
      const parsed = RenderChartPayloadSchema.safeParse(event.value);
      if (!parsed.success) return;
      pushChartBlock(session, parsed.data, eventTimestamp(event));
      return;
    }

    if (name === CONTEXT_COMPACTION_EVENT_TYPE) {
      const parsed = ContextCompactionPayloadSchema.safeParse(event.value);
      if (!parsed.success) return;
      foldCompaction(session, parsed.data, eventTimestamp(event));
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

    if (name === SUBAGENT_COMPLETED_EVENT_TYPE) {
      applySubagentCompleted(session, event);
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
      // Receiving any event from inside the sub-agent is the proof it spawned —
      // an approved `task` call. A rejected one never reaches here.
      markSubagentSpawned(session, key, block, eventTimestamp(event));
      applyNestedTask(block, fold, key);
      block.namespace = block.namespace || wrapper.namespace.join(" / ");
      block.label = block.label || toTitleCase(block.type);
      if (inner && typeof inner === "object") {
        applySubagentInnerEvent(session, key, inner);
      }
      return;
    }

    if (name === HITL_INTERRUPT_EVENT_TYPE) {
      const approval = pushInterrupt(session, event.value);
      // The orchestrator's `task` call gated before it ran: its (unspawned)
      // sub-agent card waits on this approval.
      if (
        approval &&
        parseHitlInterrupt(approval.content).actions.some((action) => action.toolName === "task")
      ) {
        session.state.blocks.forEach((block, index) => {
          if (block.kind === "subagent" && !block.spawned && block.status === "pending") {
            blockForWrite<SubagentBlock>(session, index).status = "awaiting_approval";
          }
        });
      }
      // Same rule as sub-agent interrupts: never open a lone "Waiting for
      // approval" thinking block — the takeover owns the pending state. The
      // approval binds onto the stalled tool step; a chip item is the
      // fallback for interrupts that don't gate a tool call.
      //
      // The agent's questions (`ask_user`) are the exception: they have no tool
      // step to ride on, and the answers belong in the conversation's history,
      // so they always get a block — its header reads "Waiting for your
      // answer…" while the takeover asks, then the item records the answers.
      if (approval?.questions) {
        ensureThinking(session, eventTimestamp(event)).items.push(approval);
      } else if (approval && session.state.fold.openThinkingIndex !== null) {
        const thinking = blockForWrite<ThinkingBlock>(
          session,
          session.state.fold.openThinkingIndex,
        );
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
      resolveInterrupt(
        session,
        interruptId,
        value.decision,
        value.reason ?? null,
        decisions,
        askUserAnswers(value.answers),
      );
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
    const thought: TimelineThought = {
      kind: "thought",
      id: nextItemId(session),
      text: String(event.delta ?? ""),
    };
    thinking.items.push(thought);
    return;
  }

  if (type === "THINKING_END") {
    closeThinking(session, eventEndTimestamp(event));
    return;
  }

  if (
    type === "TOOL_CALL_START" ||
    type === "TOOL_CALL_ARGS" ||
    type === "TOOL_CALL_END" ||
    type === "TOOL_CALL_RESULT"
  ) {
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
  // A sub-agent still working when the run ended ends with the run: done,
  // failed or cancelled (kept distinct). Unspawned ones (a rejected or never
  // started `task` call) are left as they are — they are not shown.
  const ended: SubagentRunStatus =
    status === "completed" ? "done" : status === "failed" ? "failed" : "cancelled";
  session.state.blocks.forEach((block, index) => {
    if (block.kind !== "subagent" || !block.spawned) return;
    if (isSubagentSettled(block) && !block.endedByRun) return;
    const write = blockForWrite<SubagentBlock>(session, index);
    write.status = ended;
    write.endedByRun = true;
  });
  session.state.terminal = true;
  session.state.terminalStatus = status;
  return session.state;
}

/**
 * The status a sub-agent card shows, or null when it is not shown at all.
 *
 * `live` is whether this run is still streaming to this view. A run that is
 * not live and not terminal (a reload mid-run, a dropped stream) never shows a
 * sub-agent as working: it is waiting on an approval when one is pending,
 * otherwise it stopped. An unspawned block (the `task` call before it ran) is
 * shown only while it can still run — never once the run is over.
 */
export function subagentRunStatus(
  block: SubagentBlock,
  timeline: Pick<RunTimeline, "terminal" | "interrupts">,
  live: boolean,
): SubagentRunStatus | null {
  const pending = timeline.interrupts.some((item) => item.status === "pending");
  if (!block.spawned) {
    if (timeline.terminal) return null;
    if (block.status === "awaiting_approval" && pending) return "awaiting_approval";
    return live && block.status !== "done" && block.status !== "failed" ? "pending" : null;
  }
  const status = block.status ?? "running";
  if (status !== "running" && status !== "pending") return status;
  if (live && !timeline.terminal) return "running";
  return pending ? "awaiting_approval" : "cancelled";
}

const NAMESPACE_SEPARATOR = " / ";

/**
 * The parent of each sub-agent block, by index into `blocks` (-1: the main
 * agent's own, or a parent that is not among `blocks`). The namespace path is
 * the primary link — a nested sub-agent's LangGraph namespace extends its
 * parent's, so the parent is the block with the longest namespace that is a
 * strict prefix of it (acyclic by construction). The `task` call the fold saw
 * inside a parent (`parentTaskId`) is the fallback when a namespace is missing
 * (a nested call not started yet), accepted only if it does not close a loop.
 */
export function resolveSubagentParents(blocks: SubagentBlock[]): number[] {
  const segments = blocks.map((block) =>
    block.namespace ? block.namespace.split(NAMESPACE_SEPARATOR) : null,
  );
  const indexByTask = new Map(blocks.map((block, index) => [block.taskId, index]));
  const parents = blocks.map((_, index) => {
    const own = segments[index];
    let best = -1;
    let bestLength = 0;
    if (own) {
      segments.forEach((candidate, other) => {
        if (other === index || !candidate || candidate.length >= own.length) return;
        if (candidate.length <= bestLength) return;
        if (candidate.every((part, i) => part === own[i])) {
          best = other;
          bestLength = candidate.length;
        }
      });
    }
    return best;
  });
  blocks.forEach((block, index) => {
    if (parents[index] !== -1 || !block.parentTaskId) return;
    const parent = indexByTask.get(block.parentTaskId);
    if (parent === undefined || parent === index) return;
    // Walk up from the would-be parent; reaching this block would be a loop.
    let cursor = parent;
    for (let guard = 0; cursor !== -1 && guard <= blocks.length; guard += 1) {
      if (cursor === index) return;
      cursor = parents[cursor];
    }
    parents[index] = parent;
  });
  return parents;
}

export type SubagentTree = {
  /** The sub-agent blocks with no parent among the timeline's blocks. */
  roots: SubagentBlock[];
  /** Each block's own sub-agents, in the order they appear. */
  childrenOf: (block: SubagentBlock) => SubagentBlock[];
  /** Whether a block sits under another block of the same timeline. */
  isNested: (block: SubagentBlock) => boolean;
};

/**
 * A timeline's sub-agents as a tree: what the inline cards nest and the side
 * panel lists. Every sub-agent block is a top-level block of the timeline (a
 * nested one's events arrive in an envelope of their own); this says which of
 * them belong inside which.
 */
export function subagentTree(timeline: Pick<RunTimeline, "blocks">): SubagentTree {
  const blocks = timeline.blocks.filter(
    (block): block is SubagentBlock => block.kind === "subagent",
  );
  const parents = resolveSubagentParents(blocks);
  const children = new Map<SubagentBlock, SubagentBlock[]>();
  const nested = new Set<SubagentBlock>();
  const roots: SubagentBlock[] = [];
  blocks.forEach((block, index) => {
    const parent = parents[index];
    if (parent === -1) {
      roots.push(block);
      return;
    }
    nested.add(block);
    const list = children.get(blocks[parent]) ?? [];
    list.push(block);
    children.set(blocks[parent], list);
  });
  return {
    roots,
    childrenOf: (block) => children.get(block) ?? [],
    isNested: (block) => nested.has(block),
  };
}

export const TERMINAL_TIMELINE_STATUSES = new Set(["completed", "cancelled", "failed"]);

function asTerminalStatus(status?: string | null): TimelineTerminalStatus | null {
  return status && TERMINAL_TIMELINE_STATUSES.has(status)
    ? (status as TimelineTerminalStatus)
    : null;
}

type LegacyMessageShape = {
  content?: string | null;
  thinking?: string[] | null;
};

function isFullEventLog(events: RawEvent[]): boolean {
  return events.some(
    (event) => event && typeof event === "object" && FULL_LOG_TYPES.has(event.type),
  );
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
  const thoughts = (legacy.thinking ?? []).filter(
    (entry) => typeof entry === "string" && entry.trim(),
  );
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
      blocks: [
        ...state.blocks,
        { kind: "content", id: "legacy-content", text: legacy.content ?? "" },
      ],
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
  const hasLegacyAggregates = Boolean(
    legacy && ((legacy.content ?? "").trim() || legacy.thinking?.length),
  );

  if (!isFullEventLog(safeEvents) && hasLegacyAggregates) {
    return foldLegacyTimeline(safeEvents, legacy as LegacyMessageShape, terminalStatus);
  }

  let state = reduceTimelineEvents(createTimeline(), safeEvents);
  if (terminalStatus) {
    state = finalizeTimeline(state, terminalStatus);
  }
  return state;
}

/**
 * How much work a finished run did: model calls and tool calls, the main agent
 * and its sub-agents together — the composer's "6 model calls · 3 tool calls".
 *
 * Read straight off the persisted event log rather than a fold: one
 * `TOKEN_USAGE` per settled model call (deduplicated by the call's
 * `message_id`, exactly as the bridge does when it sums tokens) and one
 * `TOOL_CALL_START` per tool call (deduplicated by `toolCallId`), whether
 * top-level, wrapped in `SUBAGENT_EVENT`, or still a legacy `RAW_SSE_EVENT`.
 */
export function countRunActivity(events: RawEvent[] | null | undefined): {
  modelCalls: number;
  toolCalls: number;
} {
  const usageIds = new Set<string>();
  const toolIds = new Set<string>();
  let anonymousCalls = 0;
  let anonymousTools = 0;

  const visit = (event: RawEvent | null | undefined): void => {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "RAW_SSE_EVENT") {
      visit(parseRawSseEvent(String(event.raw_sse ?? "")));
      return;
    }
    if (event.type === "TOOL_CALL_START") {
      const id = event.toolCallId ?? event.tool_call_id;
      if (typeof id === "string" && id) toolIds.add(id);
      else anonymousTools += 1;
      return;
    }
    if (event.type !== "CUSTOM") return;
    if (event.name === SUBAGENT_EVENT_TYPE) {
      visit(event.value?.event);
      return;
    }
    if (event.name === TOKEN_USAGE_EVENT_TYPE) {
      const id = event.value?.message_id;
      if (typeof id === "string" && id) usageIds.add(id);
      else anonymousCalls += 1;
    }
  };

  for (const event of Array.isArray(events) ? events : []) visit(event);
  return { modelCalls: usageIds.size + anonymousCalls, toolCalls: toolIds.size + anonymousTools };
}

export function pendingTimelineInterrupts(
  timeline: RunTimeline | null | undefined,
): TimelineHitlApproval[] {
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
    startedAt: block.startedAt,
    endedAt: block.endedAt,
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
