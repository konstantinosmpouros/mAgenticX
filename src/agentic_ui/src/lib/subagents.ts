import type { SubagentItem } from "@/components/chat/message_parts/SubagentContainer";

// Replay folding for raw AG-UI events stored on a message.
//
// During streaming the bridge accumulates `CUSTOM` events into `message.rawEvents`.
// To render the post-stream subagent timeline we replay those events through
// the same fold the live runtime would perform, producing a `SubagentItem[]`
// the `SubagentCard` component can render directly.

type ReplayEvent = {
  type: string;
  timestamp?: number;
  name?: string;
  value?: Record<string, any>;
};

type ReplayContext = {
  runtimeTaskToPublicId: Map<string, string>;
};

function toTitleCase(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseRawSseEvent(raw: string): ReplayEvent | null {
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
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return null;
  }

  const candidate = payloadText.slice(jsonStart, jsonEnd + 1);
  const attempts = [
    candidate,
    candidate.replace(/\\"/g, '"'),
    candidate.replace(/\\"/g, '"').replace(/\\\\n/g, "\\n"),
    candidate.replace(/\\"/g, '"').replace(/\\'/g, "'"),
    candidate
      .replace(/\\"/g, '"')
      .replace(/\\\\n/g, "\\n")
      .replace(/\\'/g, "'"),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as ReplayEvent;
    } catch {
      continue;
    }
  }

  return null;
}

function upsertSubagent(
  items: SubagentItem[],
  id: string,
  update: (current: SubagentItem) => SubagentItem,
): SubagentItem[] {
  const index = items.findIndex((item) => item.id === id);
  const current = index >= 0 ? items[index] : { id, tools: [], interrupts: [] };
  const next = update(current);

  if (index === -1) {
    return [...items, next];
  }

  const cloned = [...items];
  cloned[index] = next;
  return cloned;
}

function upsertTool(
  tools: NonNullable<SubagentItem["tools"]>,
  toolId: string,
  update: (current: NonNullable<SubagentItem["tools"]>[number]) => NonNullable<SubagentItem["tools"]>[number],
) {
  const index = tools.findIndex((tool) => tool.id === toolId);
  const current = index >= 0 ? tools[index] : { id: toolId, name: toolId };
  const next = update(current);

  if (index === -1) {
    return [...tools, next];
  }

  const cloned = [...tools];
  cloned[index] = next;
  return cloned;
}

function resolvePublicTaskId(
  wrapper: Record<string, any>,
  inner: ReplayEvent | null,
  context: ReplayContext,
): string {
  const runtimeTaskId = String(wrapper.task_id ?? "");
  const beforeAgentNamespace =
    inner?.type === "CUSTOM" && inner?.name === "BEFORE_AGENT_EVENT"
      ? String(inner.value?.metadata?.namespace ?? "")
      : "";

  if (beforeAgentNamespace) {
    context.runtimeTaskToPublicId.set(runtimeTaskId, beforeAgentNamespace);
    return beforeAgentNamespace;
  }

  return context.runtimeTaskToPublicId.get(runtimeTaskId) || runtimeTaskId;
}

function applyReplayEvent(
  items: SubagentItem[],
  event: ReplayEvent,
  context: ReplayContext,
): SubagentItem[] {
  if (event.type !== "CUSTOM") return items;

  if (event.name === "TASK_SUBAGENT" && event.value) {
    const publicId = String(event.value.task_id ?? "");
    const type = String(event.value.subagent_type ?? "");
    const description = String(event.value.description ?? "");
    const rawOffset = event.value.content_offset;
    const contentOffset = typeof rawOffset === "number" && rawOffset >= 0 ? rawOffset : undefined;

    return upsertSubagent(items, publicId, (current) => ({
      ...current,
      id: publicId,
      label: current.label || toTitleCase(type),
      type: current.type || type,
      description: current.description || description,
      contentOffset: current.contentOffset ?? contentOffset,
    }));
  }

  if (event.name !== "SUBAGENT_EVENT" || !event.value) {
    return items;
  }

  const wrapper = event.value;
  const namespace = Array.isArray(wrapper.namespace)
    ? wrapper.namespace.join(" / ")
    : undefined;
  const wrapperEvent = wrapper.event as Record<string, any> | undefined;
  const inner =
    wrapperEvent?.type === "RAW_SSE_EVENT"
      ? parseRawSseEvent(String(wrapperEvent.raw_sse ?? ""))
      : (wrapperEvent as ReplayEvent | undefined) ?? null;
  const publicId = resolvePublicTaskId(wrapper, inner, context);

  return upsertSubagent(items, publicId, (current) => {
    const next: SubagentItem = {
      ...current,
      id: publicId,
      label: current.label || toTitleCase(current.type),
      namespace: current.namespace || namespace,
      tools: [...(current.tools ?? [])],
      interrupts: [...(current.interrupts ?? [])],
    };

    if (!inner) {
      return next;
    }

    if (inner.type === "CUSTOM" && inner.name === "BEFORE_AGENT_EVENT") {
      const prompt = String(inner.value?.message ?? "");
      next.prompt = prompt || next.prompt;
      next.description = next.description || prompt;
      return next;
    }

    if (inner.type === "CUSTOM" && inner.name === "HITL_INTERRUPT") {
      next.interrupts = [
        ...(next.interrupts ?? []),
        {
          threadId: String(inner.value?.thread_id ?? "thread"),
          content: inner.value?.interrupt,
        },
      ];
      return next;
    }

    switch (inner.type) {
      case "TEXT_MESSAGE_CHUNK":
      case "TEXT_MESSAGE_CONTENT": {
        next.text = `${next.text ?? ""}${String((inner as any).delta ?? "")}`;
        return next;
      }

      case "TOOL_CALL_START": {
        const toolId = String((inner as any).toolCallId ?? "");
        next.tools = upsertTool(next.tools ?? [], toolId, (tool) => ({
          ...tool,
          id: toolId,
          name: String((inner as any).toolCallName ?? tool.name ?? toolId),
          status: "running",
        }));
        return next;
      }

      case "TOOL_CALL_ARGS": {
        const toolId = String((inner as any).toolCallId ?? "");
        next.tools = upsertTool(next.tools ?? [], toolId, (tool) => ({
          ...tool,
          id: toolId,
          args: `${tool.args ?? ""}${String((inner as any).delta ?? "")}`,
        }));
        return next;
      }

      case "TOOL_CALL_RESULT": {
        const toolId = String((inner as any).toolCallId ?? "");
        const resultChunk = String((inner as any).content ?? "");
        next.tools = upsertTool(next.tools ?? [], toolId, (tool) => ({
          ...tool,
          id: toolId,
          status: "completed",
          result: tool.result ? `${tool.result}\n\n${resultChunk}` : resultChunk,
        }));
        return next;
      }

      case "TOOL_CALL_END": {
        const toolId = String((inner as any).toolCallId ?? "");
        next.tools = upsertTool(next.tools ?? [], toolId, (tool) => ({
          ...tool,
          id: toolId,
          status: "completed",
        }));
        return next;
      }

      default:
        return next;
    }
  });
}

export function buildSubagentItemsFromRawEvents(
  rawEvents: Record<string, any>[] | null | undefined,
): SubagentItem[] {
  if (!rawEvents?.length) return [];
  const context: ReplayContext = { runtimeTaskToPublicId: new Map() };
  let items: SubagentItem[] = [];
  for (const event of rawEvents) {
    if (!event || typeof event !== "object") continue;
    items = applyReplayEvent(items, event as ReplayEvent, context);
  }
  return items;
}
