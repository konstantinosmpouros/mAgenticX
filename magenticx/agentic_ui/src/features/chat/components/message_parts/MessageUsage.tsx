import { TbGauge } from "react-icons/tb";

import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/shared/ui/ai-elements/context";
import { formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import type { MessageOut } from "@/shared/lib/types";

// A reply's token usage: the compact total in the action bar, the breakdown in
// the AI Elements Context card — body rows plus a footer with the model and
// its time. No header bar: context occupancy describes the conversation, not
// this reply, and the composer's gauge shows it.

export function MessageUsage({ message }: { message: MessageOut }) {
  const total = (message.inputTokens ?? 0) + (message.outputTokens ?? 0);
  const hasFooter = Boolean(message.modelName || message.modelLatencyMs);

  return (
    <Context
      usage={{
        inputTokens: message.inputTokens,
        outputTokens: message.outputTokens,
        reasoningTokens: message.reasoningTokens,
        cachedInputTokens: message.cachedInputTokens,
      }}
    >
      <ContextTrigger>
        <span
          tabIndex={0}
          className="flex cursor-help items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          aria-label={`Token usage: ${total.toLocaleString()} tokens`}
        >
          <TbGauge className="h-4 w-4" aria-hidden="true" />
          <span className="tabular-nums">{formatCompactTokens(total)}</span>
        </span>
      </ContextTrigger>
      <ContextContent side="bottom" align="center">
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
        </ContextContentBody>
        {hasFooter ? (
          <ContextContentFooter>
            <span className="truncate font-mono text-muted-foreground">{message.modelName ?? ""}</span>
            {message.modelLatencyMs ? (
              <span className="shrink-0 text-muted-foreground">
                Model time{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {formatModelTime(message.modelLatencyMs)}
                </span>
              </span>
            ) : null}
          </ContextContentFooter>
        ) : null}
      </ContextContent>
    </Context>
  );
}
