import {
  Branch,
  BranchMessages,
  BranchNext,
  BranchPage,
  BranchPrevious,
  BranchSelector,
} from "@/shared/ui/shadcn-io/branch";
import type { MessageOut } from "@/shared/lib/types";
import { INTERACTIVE_SURFACE_QUIET } from "@/shared/lib/consts";

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
        <BranchPrevious
          className={`h-6 w-6 text-muted-foreground hover:text-foreground ${INTERACTIVE_SURFACE_QUIET} focus:bg-[hsl(var(--hover-surface-strong))]`}
        />
        <BranchPage className="mx-0" />
        <BranchNext
          className={`h-6 w-6 text-muted-foreground hover:text-foreground ${INTERACTIVE_SURFACE_QUIET} focus:bg-[hsl(var(--hover-surface-strong))]`}
        />
      </BranchSelector>
    </Branch>
  );
}
