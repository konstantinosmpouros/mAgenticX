"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn, formatCompactTokens } from "@/shared/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext } from "react";

/**
 * AI Elements `Context` (elements.ai-sdk.dev/components/context), adapted.
 *
 * Same compound structure and layout as upstream — a body of label → tokens
 * rows and a tinted footer — so it reads as the component it is. Only the
 * parts this app renders are kept: upstream's header (fill percentage, used /
 * max, progress bar) has no user here, since the composer's context card has
 * its own sections. Adapted where this app differs:
 *
 * - Radix Tooltip instead of HoverCard: same surface, no new dependency.
 * - No cost: upstream prices tokens with `tokenlens` for ONE model, while a
 *   reply here can mix models; cost estimation is plan 16's server-side job.
 * - Usage is this app's shape (`cachedInputTokens`, nullable fields). A row
 *   with nothing to report renders nothing, as upstream does.
 */

export type ContextUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens?: number | null;
};

type ContextSchema = {
  usage?: ContextUsage | null;
};

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);
  if (!context) {
    throw new Error("Context components must be used within Context");
  }
  return context;
};

export type ContextProps = ComponentProps<typeof Tooltip> & ContextSchema;

export const Context = ({ usage, ...props }: ContextProps) => (
  <ContextContext.Provider value={{ usage }}>
    <Tooltip delayDuration={0} {...props} />
  </ContextContext.Provider>
);

export const ContextTrigger = (props: ComponentProps<typeof TooltipTrigger>) => (
  <TooltipTrigger asChild {...props} />
);

export const ContextContent = ({ className, ...props }: ComponentProps<typeof TooltipContent>) => (
  <TooltipContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
);

export const ContextContentBody = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("w-full space-y-1.5 p-3", className)} {...props} />
);

export const ContextContentFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs", className)}
    {...props}
  />
);

const UsageRow = ({ label, tokens }: { label: ReactNode; tokens?: number | null }) => {
  if (!tokens) return null;
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">{formatCompactTokens(tokens)}</span>
    </div>
  );
};

export const ContextInputUsage = () => <UsageRow label="Input" tokens={useContextValue().usage?.inputTokens} />;

export const ContextOutputUsage = () => (
  <UsageRow label="Output" tokens={useContextValue().usage?.outputTokens} />
);

export const ContextReasoningUsage = () => (
  <UsageRow label="Reasoning" tokens={useContextValue().usage?.reasoningTokens} />
);

export const ContextCacheUsage = () => (
  <UsageRow label="Cache" tokens={useContextValue().usage?.cachedInputTokens} />
);
