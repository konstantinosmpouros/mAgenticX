import { Fragment, useMemo } from "react";
import type { RunTimeline, TimelineBlock } from "@/lib/types";
import { BLOCK_REGISTRY, type BlockRenderContext } from "./block-registry";

type TimelineSequenceProps = {
  timeline: RunTimeline;
  runId: string;
  isStreaming: boolean;
  // Post-terminal the sub-agent panels leave the message body for the
  // action-bar side panel; inline they render only while streaming.
  hideSubagents?: boolean;
  fallbackThinkingSeconds?: number | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
};

// The timeline construction object: walks the folded block sequence, computes
// the per-block state the data model doesn't carry (it depends on sibling
// positions), and maps each block to its rendering object via BLOCK_REGISTRY.
export function TimelineSequence({
  timeline,
  runId,
  isStreaming,
  hideSubagents = false,
  fallbackThinkingSeconds,
  expandedThinking,
  onToggleThinking,
}: TimelineSequenceProps) {
  // Post-run the sub-agent containers leave the body for the side panel,
  // which would leave the thinking blocks around them stacked back-to-back —
  // merge those neighbours into one block so the settled message reads as a
  // single "Thought for Ns" per stretch of work.
  const renderBlocks = useMemo<TimelineBlock[]>(() => {
    if (!hideSubagents) return timeline.blocks;
    const merged: TimelineBlock[] = [];
    for (const block of timeline.blocks) {
      if (block.kind === "subagent") continue;
      const last = merged[merged.length - 1];
      if (block.kind === "thinking" && last?.kind === "thinking") {
        merged[merged.length - 1] = {
          ...last,
          items: [...last.items, ...block.items],
          startedAt: last.startedAt ?? block.startedAt,
          endedAt: block.endedAt ?? last.endedAt,
        };
        continue;
      }
      merged.push(block);
    }
    return merged;
  }, [timeline.blocks, hideSubagents]);

  const lastThinkingIndex = useMemo(() => {
    for (let i = renderBlocks.length - 1; i >= 0; i -= 1) {
      if (renderBlocks[i].kind === "thinking") return i;
    }
    return -1;
  }, [renderBlocks]);

  let subagentIndex = -1;
  return (
    <>
      {renderBlocks.map((block, index) => {
        if (block.kind === "subagent") subagentIndex += 1;
        const isLast = index === lastThinkingIndex;
        const isLastBlock = index === renderBlocks.length - 1;
        const isLiveActive = isStreaming && !timeline.terminal && isLastBlock;
        const expandKey = `${runId}:${block.id}`;
        const open = expandedThinking[expandKey] ?? isLiveActive;
        const ctx: BlockRenderContext = {
          runId,
          subagentIndex,
          isLiveActive,
          doneStatus:
            timeline.terminal && isLast
              ? timeline.terminalStatus
              : !isLastBlock
                ? "completed"
                : undefined,
          fallbackDurationSeconds: isLast ? fallbackThinkingSeconds : null,
          open,
          onOpenChange: () => onToggleThinking(expandKey, !open),
        };
        return <Fragment key={block.id}>{BLOCK_REGISTRY[block.kind](block, ctx)}</Fragment>;
      })}
    </>
  );
}
