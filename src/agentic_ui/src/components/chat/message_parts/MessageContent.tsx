import React, { useMemo } from "react";
import { Response } from "@/components/ui/ai-elements/response";
import { Textarea } from "@/components/ui/textarea";
import type { MessageOut } from "@/lib/types";

type MessageContentProps = {
  message: MessageOut;
  isEditing: boolean;
  editingDraft?: string;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
};

export function MessageContent({
  message,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
}: MessageContentProps) {
  const normalizedContent = useMemo(() => {
    const raw = message.content ?? "";
    return raw
      .split("\n")
      .map((line) => {
        const bulletMatch = line.match(/^(\s*)•\s*/);
        if (!bulletMatch) return line;
        const [, indent] = bulletMatch;
        const rest = line.slice(bulletMatch[0].length);
        return `${indent}- ${rest}`;
      })
      .join("\n");
  }, [message.content]);

  if (isEditing) {
    return (
      <Textarea
        value={editingDraft ?? ""}
        onChange={(event) => onChangeEditDraft?.(event.target.value)}
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
