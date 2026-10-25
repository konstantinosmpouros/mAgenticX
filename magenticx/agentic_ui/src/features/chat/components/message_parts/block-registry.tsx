import type { ReactNode } from "react";
import type {
  ArtifactBlock,
  ChartBlock,
  CompactionBlock,
  AttachmentOut,
  ContentBlock,
  MessageOut,
  SubagentBlock,
  SubagentRunStatus,
  ThinkingBlock,
  TimelineBlock,
  TimelineTerminalStatus,
} from "@/shared/lib/types";
import { ArtifactCard } from "./ArtifactCard";
import { ChartCard } from "./ChartCard";
import { CompactionDivider } from "./CompactionDivider";
import { ContentBlockView } from "./Content";
import { CoTBlock } from "./CoTBlock";
import { SubagentTreeCard } from "./SubagentTreeCard";

// Cross-block state the sequencer computes and threads to each object. The
// data model deliberately doesn't carry these — they depend on a block's
// position among its siblings — so they live here, not on the block.
export type BlockRenderContext = {
  runId: string;
  subagentIndex: number;
  isLiveActive: boolean;
  // A sub-agent block's status as its card shows it (`subagentRunStatus`):
  // computed from the whole run (live or not, pending approvals), not the block.
  subagentStatus?: SubagentRunStatus | null;
  // Set where a sub-agent card opens the sub-agent elsewhere (the agent map)
  // instead of expanding in place.
  onOpenSubagent?: (block: SubagentBlock) => void;
  // The run's delegation tree: a sub-agent card draws its own sub-agents
  // inside it. Every card's status comes from the same function.
  subagentChildrenOf?: (block: SubagentBlock) => SubagentBlock[];
  subagentStatusOf?: (block: SubagentBlock) => SubagentRunStatus | null;
  // Opens a sub-agent a thinking block's agent delegated to (the agent map's
  // transcript), from its "Delegated to" row.
  onOpenDelegation?: (taskId: string) => void;
  doneStatus?: TimelineTerminalStatus;
  fallbackDurationSeconds?: number | null;
  open: boolean;
  onOpenChange: () => void;
  // Threaded from ChatMessage so an inline artifact block can reconcile to the
  // owning message's generated attachment and reuse the download/preview
  // handlers. Absent in read-only render contexts.
  message?: MessageOut;
  onDownloadAttachment?: (attachment: AttachmentOut, message: MessageOut) => void;
  onPreviewAttachment?: (attachment: AttachmentOut, message: MessageOut) => void;
};

// The construction object: maps each top-level block kind to its rendering
// object. Keyed on TimelineBlock["kind"], so adding a block kind is a compile
// error here until it's handled.
export const BLOCK_REGISTRY: Record<
  TimelineBlock["kind"],
  (block: TimelineBlock, ctx: BlockRenderContext) => ReactNode
> = {
  content: (block, ctx) => (
    <ContentBlockView block={block as ContentBlock} streaming={ctx.isLiveActive} />
  ),
  chart: (block) => <ChartCard block={block as ChartBlock} />,
  compaction: (block, ctx) => {
    const compaction = block as CompactionBlock;
    // A compaction still "running" when the run is no longer live never
    // finished — the agent's state was not changed, so there is nothing to mark.
    if (compaction.status === "running" && !ctx.isLiveActive) return null;
    return (
      <CompactionDivider
        trigger="auto"
        status={compaction.status}
        freed={compaction.freed}
        tokensBefore={compaction.tokensBefore}
        tokensAfter={compaction.tokensAfter}
        summarizedMessages={compaction.summarizedMessages}
        keptMessages={compaction.keptMessages}
      />
    );
  },
  artifact: (block, ctx) => (
    <ArtifactCard
      block={block as ArtifactBlock}
      message={ctx.message}
      onDownload={ctx.onDownloadAttachment}
      onPreview={ctx.onPreviewAttachment}
    />
  ),
  subagent: (block, ctx) => (
    <SubagentTreeCard
      block={block as SubagentBlock}
      index={ctx.subagentIndex}
      childrenOf={ctx.subagentChildrenOf ?? (() => [])}
      statusOf={ctx.subagentStatusOf ?? (() => ctx.subagentStatus ?? null)}
      onOpen={ctx.onOpenSubagent}
    />
  ),
  thinking: (block, ctx) => (
    <CoTBlock
      block={block as ThinkingBlock}
      runId={ctx.runId}
      isLiveActive={ctx.isLiveActive}
      doneStatus={ctx.doneStatus}
      fallbackDurationSeconds={ctx.fallbackDurationSeconds}
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      onOpenDelegation={ctx.onOpenDelegation}
    />
  ),
};
