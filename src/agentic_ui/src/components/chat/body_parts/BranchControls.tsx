import React from "react";
import {
  Branch,
  BranchMessages,
  BranchNext,
  BranchPage,
  BranchPrevious,
  BranchSelector,
} from "@/components/ui/shadcn-io/branch";
import type { MessageOut } from "@/lib/types";

type BranchControlsProps = {
  parentId: string | null;
  options?: MessageOut[];
  selectionIndex: number;
  role: "assistant" | "user";
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
};

export function BranchControls({
  parentId,
  options,
  selectionIndex,
  role,
  onSelectBranch,
}: BranchControlsProps) {
  if (!options || options.length <= 1) return null;

  const clampedIndex = Math.min(Math.max(selectionIndex, 0), options.length - 1);
  const branchKey = `${parentId ?? "root"}-${options.length}-${options
    .map((option) => option.id)
    .join("-")}-${role}-${clampedIndex}`;

  return (
    <Branch
      key={branchKey}
      defaultBranch={clampedIndex}
      onBranchChange={(idx) => onSelectBranch?.(parentId, idx)}
      className="inline-flex items-center gap-1"
    >
      <BranchMessages className="hidden">
        {options.map((child) => (
          <div key={child.id} />
        ))}
      </BranchMessages>
      <BranchSelector
        from={role}
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/80 px-0"
      >
        <BranchPrevious className="h-6 w-6 text-muted-foreground hover:text-foreground hover:!bg-[#2f2f2f] active:!bg-[#2f2f2f] focus:!bg-[#2f2f2f]" />
        <BranchPage className="mx-0" />
        <BranchNext className="h-6 w-6 text-muted-foreground hover:text-foreground hover:!bg-[#2f2f2f] active:!bg-[#2f2f2f] focus:!bg-[#2f2f2f]" />
      </BranchSelector>
    </Branch>
  );
}
