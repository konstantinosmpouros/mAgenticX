import React from "react";
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
} from "@/components/ui/ai-elements/chain-of-thought";
import { MarkdownRenderer } from "@/components/ui/markdownRenderer";
import { Wrench, CheckCircle2 } from "lucide-react";
import type { MessageOut } from "@/lib/types";

const toolPrefix = /^\s*\[tool\]\s*/i;

export const formatThinkingDuration = (thinkingTime?: number) => {
  if (typeof thinkingTime !== "number" || Number.isNaN(thinkingTime)) {
    return null;
  }
  const minutes = Math.floor(thinkingTime / 60);
  const seconds = thinkingTime % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

type ThoughtStepOptions = {
  activeIndex: number;
  isComplete: boolean;
};

export const buildCoTSteps = (
  thoughts: string[],
  { activeIndex, isComplete }: ThoughtStepOptions
): React.ReactNode => {
  const normalizedIndex = Math.min(
    Math.max(activeIndex ?? -1, -1),
    thoughts.length - 1
  );

  const steps: React.ReactNode[] = thoughts.map((raw, index) => {
    const text = String(raw ?? "");
    const isTool = toolPrefix.test(text);
    const cleanText = text.replace(toolPrefix, "").trim();
    const status: "complete" | "active" | "pending" = isComplete
      ? "complete"
      : normalizedIndex < 0
        ? "pending"
        : index < normalizedIndex
          ? "complete"
          : index === normalizedIndex
            ? "active"
            : "pending";

    const labelSegments = [`Step ${index + 1}`];
    if (isTool) {
      labelSegments.push("Tool");
    }

    return (
      <ChainOfThoughtStep
        key={`cot-step-${index}`}
        icon={isTool ? Wrench : undefined}
        label={labelSegments.join(" · ")}
        status={status}
        className="text-sm"
      >
        <MarkdownRenderer
          content={cleanText || "Working..."}
          className="text-muted-foreground text-sm leading-relaxed"
        />
      </ChainOfThoughtStep>
    );
  });

  if (isComplete) {
    steps.push(
      <ChainOfThoughtStep
        key="cot-step-complete"
        icon={CheckCircle2}
        label="Completed"
        status="complete"
        className="text-sm"
      />
    );
  }

  return steps.length ? steps : null;
};

type CoTProps = {
  message: MessageOut;
  isOpen: boolean;
  onToggle: () => void;
};

export function CoT({
  message,
  isOpen,
  onToggle,
}: CoTProps) {
  if (!message.thinking) {
    return null;
  }

  const handleOpenChange = (open: boolean) => {
    if (open !== isOpen) {
      onToggle();
    }
  };

  const durationLabel = formatThinkingDuration(message.thinkingTime);

  return (
    <ChainOfThought
      className="max-w-[85%] md:max-w-[85%] w-full space-y-2"
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <ChainOfThoughtHeader className="text-sm md:text-[0.95rem] font-medium text-muted-foreground hover:text-foreground">
        {durationLabel ? `Thought for ${durationLabel}` : "Reasoning"}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="[&>div:last-child>div:first-child>div:last-child]:hidden">
        {buildCoTSteps(message.thinking, {
          activeIndex: message.thinking.length - 1,
          isComplete: true,
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
