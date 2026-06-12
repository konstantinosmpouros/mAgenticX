import { TimelineBlocks } from "@/components/chat/message_parts/TimelineBlocks";
import { ShimmeringText } from "@/components/ui/shadcn-io/shimmering-text";
import { cn } from "@/lib/utils";
import type { RunTimeline } from "@/lib/types";

type AgentRunTimelineProps = {
  timeline: RunTimeline;
  runId: string;
  isStreaming: boolean;
  fallbackThinkingSeconds?: number | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
  className?: string;
};

// AgentRunTimeline renders the whole body of an assistant message as the
// temporal block sequence the reducer derived from the run's event log:
// collapsible Thinking blocks (thoughts + tool executions + inline HITL
// approvals, ending in the Done sentinel once the run is terminal),
// alternating with markdown content blocks. Sub-agent panels render inline
// only while the run streams; settled messages move them to the action-bar
// side panel.
export function AgentRunTimeline({
  timeline,
  runId,
  isStreaming,
  fallbackThinkingSeconds,
  expandedThinking,
  onToggleThinking,
  className,
}: AgentRunTimelineProps) {
  if (!timeline.blocks.length) {
    if (!isStreaming) return null;
    return (
      <div className={cn("flex w-full", className)}>
        <ShimmeringText
          text="Reasoning..."
          duration={1.1}
          pause={1.4}
          color="hsl(var(--muted-foreground))"
          shimmeringColor="#2b2d36"
          className="text-sm md:text-[0.95rem] font-medium"
        />
      </div>
    );
  }

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <TimelineBlocks
        timeline={timeline}
        runId={runId}
        isStreaming={isStreaming}
        hideSubagents={!isStreaming && timeline.terminal}
        fallbackThinkingSeconds={fallbackThinkingSeconds}
        expandedThinking={expandedThinking}
        onToggleThinking={onToggleThinking}
      />
    </div>
  );
}
