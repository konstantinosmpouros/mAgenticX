import { useMemo, useState } from "react";
import type { MessageOut } from "@/lib/types";
import type { PlanSnapshot } from "@/lib/agui";
import { Response } from "@/components/ui/ai-elements/response";
import { PlanningContainer } from "@/components/chat/message_parts/PlanningContainer";
import { SubagentCard, SubagentContainer, type SubagentItem } from "@/components/chat/message_parts/SubagentContainer";
import { buildSubagentItemsFromRawEvents } from "@/lib/subagents";
import { cn } from "@/lib/utils";

type AgentRunTimelineProps = {
  message: MessageOut;
  isStreaming?: boolean;
  className?: string;
};

const SUBAGENT_VISIBLE_LIMIT = 3;

// Re-implement MessageContent's bullet normalisation locally so each
// interleaved text segment renders with the same markdown semantics the
// final post-stream MessageContent uses.
function normalizeMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const bulletMatch = line.match(/^(\s*)•\s*/);
      if (!bulletMatch) return line;
      const [, indent] = bulletMatch;
      const rest = line.slice(bulletMatch[0].length);
      return `${indent}- ${rest}`;
    })
    .join("\n");
}

type InterleavedBlock =
  | { kind: "text"; key: string; content: string }
  | { kind: "subagent"; key: string; item: SubagentItem; index: number };

// Split the streaming parent content at each subagent's content_offset and
// produce an ordered block list: text → card → text → card → … → text.
// Subagents whose contentOffset is missing are appended at the end so the
// view stays stable even when older runs (pre-content_offset) are replayed.
function buildInterleavedBlocks(content: string, subagentItems: SubagentItem[]): InterleavedBlock[] {
  if (subagentItems.length === 0) {
    return content ? [{ kind: "text", key: "text-0", content }] : [];
  }

  const safeContent = content ?? "";
  const indexed = subagentItems.map((item, originalIndex) => ({ item, originalIndex }));

  const known = indexed.filter(({ item }) => typeof item.contentOffset === "number");
  const unknown = indexed.filter(({ item }) => typeof item.contentOffset !== "number");

  known.sort((a, b) => {
    const offsetDiff = (a.item.contentOffset ?? 0) - (b.item.contentOffset ?? 0);
    if (offsetDiff !== 0) return offsetDiff;
    return a.originalIndex - b.originalIndex;
  });

  const blocks: InterleavedBlock[] = [];
  let cursor = 0;

  for (const { item, originalIndex } of known) {
    const offset = Math.max(cursor, Math.min(item.contentOffset ?? safeContent.length, safeContent.length));
    if (offset > cursor) {
      blocks.push({ kind: "text", key: `text-${cursor}`, content: safeContent.slice(cursor, offset) });
    }
    blocks.push({ kind: "subagent", key: `subagent-${item.id || originalIndex}`, item, index: originalIndex });
    cursor = offset;
  }

  if (cursor < safeContent.length) {
    blocks.push({ kind: "text", key: `text-${cursor}`, content: safeContent.slice(cursor) });
  }

  for (const { item, originalIndex } of unknown) {
    blocks.push({ kind: "subagent", key: `subagent-tail-${item.id || originalIndex}`, item, index: originalIndex });
  }

  return blocks;
}

// AgentRunTimeline renders the runtime activity for an assistant message.
//
// Streaming: text segments + SubagentCards interleaved by chronological
// content_offset, exposing the agent's "talk → delegate → talk → delegate"
// rhythm in place of a bare text blob followed by a stack of cards. If more
// than SUBAGENT_VISIBLE_LIMIT subagents are active, a "+ k more" pill opens
// the consolidated SubagentContainer modal.
//
// Post-stream: the inline cards collapse into a single SubagentContainer
// summary panel; the plan summary appears as a PlanningContainer above it.
// The ChainOfThought rendered above the bubble is unchanged in either case.
export function AgentRunTimeline({ message, isStreaming, className }: AgentRunTimelineProps) {
  const [planExpanded, setPlanExpanded] = useState(false);
  const [subagentExpanded, setSubagentExpanded] = useState(false);
  const [liveOverflowOpen, setLiveOverflowOpen] = useState(false);

  const plan = useMemo(() => {
    const raw = message.plan as PlanSnapshot | undefined;
    return raw && Array.isArray(raw.items) && raw.items.length > 0 ? raw : null;
  }, [message.plan]);

  const subagentItems = useMemo(
    () => buildSubagentItemsFromRawEvents(message.rawEvents),
    [message.rawEvents],
  );

  if (isStreaming) {
    if (subagentItems.length === 0) return null;

    const blocks = buildInterleavedBlocks(message.content ?? "", subagentItems);
    const hidden = Math.max(0, subagentItems.length - SUBAGENT_VISIBLE_LIMIT);
    let renderedSubagentCount = 0;

    return (
      <div className={cn("flex w-full flex-col gap-3", className)}>
        {blocks.map((block) => {
          if (block.kind === "text") {
            const normalized = normalizeMarkdown(block.content);
            if (!normalized.trim()) return null;
            return <Response key={block.key}>{normalized}</Response>;
          }
          const cardIndex = renderedSubagentCount;
          renderedSubagentCount += 1;
          if (cardIndex >= SUBAGENT_VISIBLE_LIMIT) {
            return null;
          }
          return (
            <SubagentCard
              key={block.key}
              subagent={block.item}
              index={block.index}
            />
          );
        })}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setLiveOverflowOpen(true)}
            className="self-center rounded-full bg-secondary/60 px-3 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            + {hidden} more
          </button>
        ) : null}
        <SubagentContainer
          subagents={subagentItems}
          expanded={liveOverflowOpen}
          onToggle={() => setLiveOverflowOpen((prev) => !prev)}
          title="Subagent activity"
          triggerless
        />
      </div>
    );
  }

  if (!plan && subagentItems.length === 0) return null;

  return (
    <div className={cn("flex w-full flex-col gap-3 pt-1", className)}>
      {plan ? (
        <PlanningContainer
          plan={plan}
          expanded={planExpanded}
          onToggle={() => setPlanExpanded((current) => !current)}
          title="Agent plan"
          className="w-full"
        />
      ) : null}

      {subagentItems.length > 0 ? (
        <SubagentContainer
          subagents={subagentItems}
          expanded={subagentExpanded}
          onToggle={() => setSubagentExpanded((current) => !current)}
          title="Subagent activity"
          className="w-full"
        />
      ) : null}
    </div>
  );
}

// Helper for ChatMessage to know whether to suppress the standalone
// MessageContent: when AgentRunTimeline takes over the interleaved render,
// the text would otherwise duplicate.
export function messageHasInlineSubagents(message: MessageOut): boolean {
  const rawEvents = message.rawEvents;
  if (!Array.isArray(rawEvents)) return false;
  for (const event of rawEvents) {
    if (event && typeof event === "object" && (event as any).name === "TASK_SUBAGENT") {
      return true;
    }
  }
  return false;
}
