import type { ReactNode } from "react";
import type {
  ContentBlock,
  SubagentBlock,
  ThinkingBlock,
  TimelineBlock,
  TimelineTerminalStatus,
} from "@/shared/lib/types";
import { subagentBlockToItem } from "@/runtime";
import { ContentBlockView } from "./Content";
import { CoTBlock } from "./CoTBlock";
import { SubagentCard } from "./SubagentContainer";

// Cross-block state the sequencer computes and threads to each object. The
// data model deliberately doesn't carry these — they depend on a block's
// position among its siblings — so they live here, not on the block.
export type BlockRenderContext = {
  runId: string;
  subagentIndex: number;
  isLiveActive: boolean;
  doneStatus?: TimelineTerminalStatus;
  fallbackDurationSeconds?: number | null;
  open: boolean;
  onOpenChange: () => void;
};

// The construction object: maps each top-level block kind to its rendering
// object. Keyed on TimelineBlock["kind"], so adding a block kind is a compile
// error here until it's handled.
export const BLOCK_REGISTRY: Record<
  TimelineBlock["kind"],
  (block: TimelineBlock, ctx: BlockRenderContext) => ReactNode
> = {
  content: (block) => <ContentBlockView block={block as ContentBlock} />,
  subagent: (block, ctx) => (
    <SubagentCard subagent={subagentBlockToItem(block as SubagentBlock)} index={ctx.subagentIndex} />
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
    />
  ),
};
