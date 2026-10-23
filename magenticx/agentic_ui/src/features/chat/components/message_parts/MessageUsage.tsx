import { TbAlertTriangle, TbGauge } from "react-icons/tb";

import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextInputUsage,
  ContextMetricRow,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/shared/ui/ai-elements/context";
import {
  describeCost,
  formatCompactTokens,
  formatModelTime,
  formatSeconds,
  formatTokensPerSecond,
} from "@/shared/lib/utils";
import type { MessageOut } from "@/shared/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

// A reply's token usage: the compact total in the action bar, the breakdown in
// the AI Elements Context card — body rows plus a footer with the model and
// its time. No header bar: context occupancy describes the conversation, not
// this reply, and the composer's gauge shows it.
//
// Plan 41 adds a second body: the estimated cost, the wait to the first words
// and the output speed — each only when the answer recorded it, so a reply
// from before those metrics keeps the card it had. A reply the model cut off
// at its output limit says so in the card and with a mark beside the gauge,
// because an answer that silently stops mid-sentence reads as a bug.

const TRUNCATED_LABEL = "Cut off at the output limit";

/** Output tokens per second while generating, or null when no call streamed. */
const replyTokensPerSecond = (message: Pick<MessageOut, "genMs" | "genOutputTokens">) =>
  message.genMs && message.genMs > 0
    ? ((message.genOutputTokens ?? 0) / message.genMs) * 1000
    : null;

/**
 * The cut-off mark on its own, for when token usage is hidden: an incomplete
 * answer must be flagged whatever the user chose to see about tokens.
 */
export function TruncatedMark({ message }: { message: MessageOut }) {
  if ((message.truncatedCalls ?? 0) <= 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="note"
          aria-label={TRUNCATED_LABEL}
          className="flex cursor-help items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <TbAlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {TRUNCATED_LABEL}: the model hit its maximum length, so this answer may be incomplete.
      </TooltipContent>
    </Tooltip>
  );
}

export function MessageUsage({ message }: { message: MessageOut }) {
  const total = (message.inputTokens ?? 0) + (message.outputTokens ?? 0);
  const hasFooter = Boolean(message.modelName || message.modelLatencyMs);
  const truncated = (message.truncatedCalls ?? 0) > 0;
  // `costMicros` is absent on answers from before pricing; then no row at all.
  const cost =
    message.costMicros === undefined
      ? null
      : describeCost(message.costMicros, message.unpricedCalls);
  const speed = replyTokensPerSecond(message);
  const firstToken = typeof message.firstTokenMs === "number" ? message.firstTokenMs : null;
  const hasMetrics = Boolean(cost || speed !== null || firstToken !== null);

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
          aria-label={`Token usage: ${total.toLocaleString()} tokens${truncated ? `. ${TRUNCATED_LABEL}` : ""}`}
        >
          <TbGauge className="h-4 w-4" aria-hidden="true" />
          <span className="tabular-nums">{formatCompactTokens(total)}</span>
          {truncated ? (
            <TbAlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
          ) : null}
        </span>
      </ContextTrigger>
      <ContextContent side="bottom" align="center">
        {truncated ? (
          <div className="flex w-full items-start gap-2 bg-warning/10 p-3 text-xs" role="note">
            <TbAlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium text-foreground">{TRUNCATED_LABEL}</span>
              <span className="block text-muted-foreground">
                The model hit its maximum length — this answer may be incomplete.
              </span>
            </span>
          </div>
        ) : null}
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
        </ContextContentBody>
        {hasMetrics ? (
          <ContextContentBody>
            {cost ? (
              <ContextMetricRow label="Est. cost" value={cost.label} hint={cost.note} />
            ) : null}
            {firstToken !== null ? (
              <ContextMetricRow label="First token" value={formatSeconds(firstToken)} />
            ) : null}
            {speed !== null ? (
              <ContextMetricRow label="Output speed" value={formatTokensPerSecond(speed)} />
            ) : null}
          </ContextContentBody>
        ) : null}
        {hasFooter ? (
          <ContextContentFooter>
            <span className="truncate font-mono text-muted-foreground">
              {message.modelName ?? ""}
            </span>
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
