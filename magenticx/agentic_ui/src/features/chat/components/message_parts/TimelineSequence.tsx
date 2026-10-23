import { Fragment, useMemo } from "react";
import { subagentRunStatus } from "@/features/inference";
import type { AttachmentOut, MessageOut, RunTimeline, TimelineBlock } from "@/shared/lib/types";
import { BLOCK_REGISTRY, type BlockRenderContext } from "./block-registry";

type TimelineSequenceProps = {
  timeline: RunTimeline;
  runId: string;
  isStreaming: boolean;
  fallbackThinkingSeconds?: number | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
  // Threaded to inline artifact blocks so they can reconcile to the message's
  // generated attachment and reuse the download/preview handlers.
  message?: MessageOut;
  onDownloadAttachment?: (attachment: AttachmentOut, message: MessageOut) => void;
  onPreviewAttachment?: (attachment: AttachmentOut, message: MessageOut) => void;
};

// The timeline construction object: walks the folded block sequence, computes
// the per-block state the data model doesn't carry (it depends on sibling
// positions), and maps each block to its rendering object via BLOCK_REGISTRY.
export function TimelineSequence({
  timeline,
  runId,
  isStreaming,
  fallbackThinkingSeconds,
  expandedThinking,
  onToggleThinking,
  message,
  onDownloadAttachment,
  onPreviewAttachment,
}: TimelineSequenceProps) {
  // Sub-agent cards stay inline for good — while the run streams and after it
  // settles (also on reload), each with its final status. Only a `task` call
  // that never ran (rejected at its approval, or the run ended first) has no
  // card: dropping it would leave the thinking blocks around it stacked
  // back-to-back, so those neighbours merge into one "Thought for Ns".
  const runLive = isStreaming && !timeline.terminal;
  const renderBlocks = useMemo<TimelineBlock[]>(() => {
    const merged: TimelineBlock[] = [];
    let dropped = false;
    for (const block of timeline.blocks) {
      if (block.kind === "subagent" && subagentRunStatus(block, timeline, runLive) === null) {
        dropped = true;
        continue;
      }
      const last = merged[merged.length - 1];
      if (dropped && block.kind === "thinking" && last?.kind === "thinking") {
        merged[merged.length - 1] = {
          ...last,
          items: [...last.items, ...block.items],
          startedAt: last.startedAt ?? block.startedAt,
          endedAt: block.endedAt ?? last.endedAt,
        };
        continue;
      }
      dropped = false;
      merged.push(block);
    }
    return merged;
  }, [timeline, runLive]);

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
          subagentStatus:
            block.kind === "subagent" ? subagentRunStatus(block, timeline, runLive) : undefined,
          doneStatus:
            timeline.terminal && isLast
              ? timeline.terminalStatus
              : !isLastBlock
                ? "completed"
                : undefined,
          fallbackDurationSeconds: isLast ? fallbackThinkingSeconds : null,
          open,
          onOpenChange: () => onToggleThinking(expandKey, !open),
          message,
          onDownloadAttachment,
          onPreviewAttachment,
        };
        return <Fragment key={block.id}>{BLOCK_REGISTRY[block.kind](block, ctx)}</Fragment>;
      })}
    </>
  );
}
