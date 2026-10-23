import { memo, useMemo } from "react";
import { Response } from "@/shared/ui/ai-elements/response";
import { Textarea } from "@/shared/ui/textarea";
import type { ContentBlock, MessageOut } from "@/shared/lib/types";
import { normalizeBulletMarkdown } from "@/shared/lib/utils";

// ContentBlockView — a timeline content block rendered as markdown. `streaming`
// while it is the live run's last block, i.e. text may still be arriving in it.
export const ContentBlockView = memo(
  ({ block, streaming = false }: { block: ContentBlock; streaming?: boolean }) => {
    const normalized = normalizeBulletMarkdown(block.text);
    if (!normalized.trim()) return null;
    return <Response streaming={streaming}>{normalized}</Response>;
  },
);
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

/**
 * The slash command a user message ran (plan 35), shown highlighted in front of
 * its text, as inline code (which the message renderer draws as a highlight).
 * The command travels in `message.command`, never in the text, so this is the
 * only place it appears in the bubble.
 */
function markCommand(content: string, name: string | null): string {
  if (!name) return content;
  return `\`/${name}\` ${content}`.trimEnd();
}

export function MessageContent({
  message,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
}: MessageContentProps) {
  const commandName = message.sender === "user" ? (message.command?.name ?? null) : null;
  const normalizedContent = useMemo(
    () => markCommand(normalizeBulletMarkdown(message.content ?? ""), commandName),
    [message.content, commandName],
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
