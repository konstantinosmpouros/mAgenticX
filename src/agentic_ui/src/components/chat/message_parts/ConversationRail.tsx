import { cn } from "@/lib/utils";
import type { MessageOut } from "@/lib/types";
import { useConversationRail } from "@/hooks/useConversationRail";

type ConversationRailProps = {
  messages: MessageOut[];
  viewportRef: React.RefObject<HTMLDivElement | null>;
  columnRef: React.RefObject<HTMLDivElement | null>;
};

// Right-edge conversation scroll-rail (thread minimap). One tick per message in
// the active branch — AI ticks wider than user ticks — with the in-view message
// highlighted; click a tick to jump there. The rail fades out whenever the
// right gutter shrinks enough that it would crowd the right-aligned message
// column, so it never overlaps a message.
export function ConversationRail({ messages, viewportRef, columnRef }: ConversationRailProps) {
  const messageIds = messages.map((message) => message.id);
  const { activeId, hidden, scrollToMessage } = useConversationRail({
    viewportRef,
    columnRef,
    messageIds,
  });

  if (messages.length < 2) return null;

  return (
    <nav
      aria-label="Conversation messages"
      className={cn(
        "pointer-events-none absolute right-4 top-1/2 z-20 flex max-h-[60vh] -translate-y-1/2",
        "flex-col items-end justify-center gap-1 overflow-hidden",
        "transition-opacity duration-300 ease-out motion-reduce:transition-none",
        hidden ? "opacity-0" : "opacity-100"
      )}
    >
      {messages.map((message, index) => {
        const isAi = message.sender === "ai";
        const isActive = message.id === activeId;
        // Active highlight uses the brand magenta only for assistant messages;
        // user ticks brighten to a neutral foreground instead.
        const activeBg = isAi ? "bg-primary" : "bg-foreground";
        return (
          <button
            key={message.id}
            type="button"
            aria-label={`Jump to ${isAi ? "assistant" : "your"} message ${index + 1}`}
            aria-current={isActive ? "true" : undefined}
            onClick={() => scrollToMessage(message.id)}
            disabled={hidden}
            className={cn(
              "group pointer-events-auto flex h-4 items-center justify-end focus-visible:outline-none",
              hidden && "pointer-events-none"
            )}
          >
            <span
              className={cn(
                "block h-[2px] origin-right rounded-full",
                "transition-[background-color,opacity,transform] duration-200 ease-out motion-reduce:transition-none",
                isAi ? "w-5" : "w-2.5",
                isActive
                  ? cn("scale-x-[1.35] opacity-100", activeBg)
                  : "bg-muted-foreground/40 opacity-70 group-hover:bg-muted-foreground group-hover:opacity-100",
                "group-focus-visible:scale-x-[1.35] group-focus-visible:opacity-100",
                isAi ? "group-focus-visible:bg-primary" : "group-focus-visible:bg-foreground"
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}
