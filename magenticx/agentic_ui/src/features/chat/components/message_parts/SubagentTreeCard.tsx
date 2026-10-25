import { subagentBlockToItem } from "@/features/inference";
import type { SubagentBlock, SubagentRunStatus } from "@/shared/lib/types";
import { SubagentCard } from "./SubagentContainer";

export type SubagentTreeCardProps = {
  block: SubagentBlock;
  index: number;
  /** The block's own sub-agents (`subagentTree(timeline).childrenOf`). */
  childrenOf: (block: SubagentBlock) => SubagentBlock[];
  /** A block's status as its card shows it; `null` hides the card. */
  statusOf: (block: SubagentBlock) => SubagentRunStatus | null;
  /** Opens a sub-agent elsewhere (the agent map) instead of expanding it. */
  onOpen?: (block: SubagentBlock) => void;
  defaultCollapsedSections?: boolean;
};

/**
 * A sub-agent's card with its own sub-agents' cards nested inside it, at every
 * depth — the inline chat and the sub-agents panel draw the run's delegation
 * tree the way the agent map does. Each card keeps its own status, tools,
 * duration and running light; a child that never ran (a refused `task` call)
 * has no card, as at the top level.
 */
export function SubagentTreeCard({
  block,
  index,
  childrenOf,
  statusOf,
  onOpen,
  defaultCollapsedSections,
}: SubagentTreeCardProps) {
  const children = childrenOf(block).filter((child) => statusOf(child) !== null);
  return (
    <SubagentCard
      subagent={subagentBlockToItem(block)}
      index={index}
      status={statusOf(block)}
      onOpen={onOpen ? () => onOpen(block) : undefined}
      defaultCollapsedSections={defaultCollapsedSections}
      nested={children.map((child, childIndex) => ({
        key: child.id,
        active: statusOf(child) === "running",
        node: (
          <SubagentTreeCard
            block={child}
            index={childIndex}
            childrenOf={childrenOf}
            statusOf={statusOf}
            onOpen={onOpen}
            defaultCollapsedSections={defaultCollapsedSections}
          />
        ),
      }))}
    />
  );
}
