import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";

import { PlanningContainer } from "@/components/chat/agentic_parts";
import { ChatInputBar } from "@/components/chat/ChatInputBar";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PlanSnapshot } from "@/lib/types";

const DEMO_PLAN_SNAPSHOTS: PlanSnapshot[] = [
  {
    updated_at: Date.now() - 180_000,
    items: [
      {
        content: "Clarify the user goal and isolate the exact policy or product decision to answer.",
        status: "in_progress",
      },
      {
        content: "Inspect the available context, identify missing details, and choose the smallest reliable path forward.",
        status: "pending",
      },
      {
        content: "Assemble a response structure with the answer first, then concise supporting evidence.",
        status: "pending",
      },
      {
        content: "Prepare edge-case follow-ups for ambiguity, exceptions, or missing internal data.",
        status: "pending",
      },
      {
        content: "Finalize the response tone and trim anything that does not directly help the user.",
        status: "pending",
      },
    ],
  },
  {
    updated_at: Date.now() - 90_000,
    items: [
      {
        content: "Clarify the user goal and isolate the exact policy or product decision to answer.",
        status: "completed",
      },
      {
        content: "Inspect the available context, identify missing details, and choose the smallest reliable path forward.",
        status: "in_progress",
      },
      {
        content: "Assemble a response structure with the answer first, then concise supporting evidence.",
        status: "pending",
      },
      {
        content: "Prepare edge-case follow-ups for ambiguity, exceptions, or missing internal data.",
        status: "pending",
      },
      {
        content: "Finalize the response tone and trim anything that does not directly help the user.",
        status: "pending",
      },
    ],
  },
  {
    updated_at: Date.now(),
    items: [
      {
        content: "Clarify the user goal and isolate the exact policy or product decision to answer.",
        status: "completed",
      },
      {
        content: "Inspect the available context, identify missing details, and choose the smallest reliable path forward.",
        status: "completed",
      },
      {
        content: "Assemble a response structure with the answer first, then concise supporting evidence.",
        status: "in_progress",
      },
      {
        content: "Prepare edge-case follow-ups for ambiguity, exceptions, or missing internal data.",
        status: "pending",
      },
      {
        content: "Finalize the response tone and trim anything that does not directly help the user.",
        status: "pending",
      },
    ],
  },
];

export default function Test() {
  const [expanded, setExpanded] = useState(true);
  const [currentMessage, setCurrentMessage] = useState("");
  const [planHistory, setPlanHistory] = useState<PlanSnapshot[]>([DEMO_PLAN_SNAPSHOTS[0]]);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAgent = {
    name: "Deep agent",
    description: "Previewing the real composer with the planning container attached above it.",
  };
  const activePlan = planHistory[planHistory.length - 1];

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setPlanHistory((current) => {
        if (current.length >= DEMO_PLAN_SNAPSHOTS.length) {
          return [DEMO_PLAN_SNAPSHOTS[0]];
        }
        return [...current, DEMO_PLAN_SNAPSHOTS[current.length]];
      });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.14),_transparent_28%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-background to-black/20" />
      <div className="mx-auto flex min-h-screen w-full max-w-7xl items-end justify-center px-6 pb-8 pt-24">
        <div className="w-full max-w-3xl">
          <div className="relative">
            <PlanningContainer
              plan={activePlan}
              expanded={expanded}
              onToggle={() => setExpanded((current) => !current)}
              className="absolute bottom-[calc(100%-1px)] left-1/2 z-10 w-[min(100%,39rem)] -translate-x-1/2"
              title="Deep agent execution plan"
            />

            <ChatInputBar
              positionClass="relative z-20 w-full"
              attachments={[]}
              isMessagesEmpty={false}
              isPrivateMode={false}
              thinkingActive={false}
              isStreaming={false}
              currentMessage={currentMessage}
              setCurrentMessage={setCurrentMessage}
              handlePaste={() => {}}
              handleSendMessage={() => {}}
              isImageFile={() => false}
              getImageUrl={() => ""}
              handleImageClick={() => {}}
              removeAttachment={() => {}}
              handleFileUpload={() => {}}
              fileInputRef={fileInputRef}
              textareaRef={textareaRef}
              containerRef={composerContainerRef}
              textareaMaxHeight={220}
              AgentIcon={Bot}
              Tooltip={Tooltip}
              TooltipTrigger={TooltipTrigger}
              TooltipContent={TooltipContent}
              currentAgent={currentAgent}
              Textarea={Textarea}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
