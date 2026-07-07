import { memo, useMemo } from "react";
import { Response } from "@/shared/ui/ai-elements/response";
import { Textarea } from "@/shared/ui/textarea";
import type { ContentBlock, MessageOut } from "@/shared/lib/types";
import { normalizeBulletMarkdown } from "@/shared/lib/utils";

// ContentBlockView — a timeline content block rendered as markdown.
export const ContentBlockView = memo(({ block }: { block: ContentBlock }) => {
  const normalized = normalizeBulletMarkdown(block.text);
  if (!normalized.trim()) return null;
  return <Response>{normalized}</Response>;
});
ContentBlockView.displayName = "ContentBlockView";

type MessageContentProps = {
  message: MessageOut;
  isEditing: boolean;
  editingDraft?: string;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
};

export function MessageContent({
  message,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
}: MessageContentProps) {
  const normalizedContent = useMemo(
    () => normalizeBulletMarkdown(message.content ?? ""),
    [message.content],
  );

  if (isEditing) {
    return (
      <Textarea
        value={editingDraft ?? ""}
        onChange={(event) => onChangeEditDraft?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancelEdit?.();
            return;
          }

          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmitEdit?.();
          }
        }}
        disabled={editingBusy}
        autoFocus
        className="w-full min-h-[6rem] resize-none bg-transparent text-inherit border-none p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-none focus-visible:outline-none"
      />
    );
  }

  const trimmed = normalizedContent.trim();

  if (!trimmed) {
    return null;
  }

  return <Response>{normalizedContent}</Response>;
}
