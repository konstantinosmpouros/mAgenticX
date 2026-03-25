import { useState } from "react";

import { SubagentContainer } from "@/components/chat/agentic_parts";
import type { SubagentItem } from "@/components/chat/agentic_parts/SubagentContainer";

const DEMO_SUBAGENTS: SubagentItem[] = [
  {
    id: "task-research-001",
    label: "Researcher",
    type: "researcher",
    description: "Audit pricing documentation and return the latest seat and rate limits.",
    namespace: "tools:task-research-001 / researcher",
    prompt:
      "Audit pricing documentation and return the latest seat and rate limits. Include exact product names and surface any ambiguity explicitly.",
    text:
      "The current pricing page shows a 50-seat cap on the Team plan and notes annual billing discounts in the FAQ. I also found a release note mentioning the Enterprise cap was removed, so the response should distinguish between Team and Enterprise.",
    eventCount: 7,
    tools: [
      {
        id: "tool-search-001",
        name: "web.search",
        status: "completed",
        args: "{\"query\":\"latest seat limits pricing page\"}",
        result:
          "{\"hits\":[{\"title\":\"Pricing\",\"url\":\"/pricing\"},{\"title\":\"Billing FAQ\",\"url\":\"/faq/billing\"}]}",
      },
    ],
  },
  {
    id: "task-validator-002",
    label: "Validator",
    type: "validator",
    description: "Cross-check the extracted limits against FAQs and release notes before finalizing.",
    namespace: "tools:task-validator-002 / validator",
    prompt:
      "Cross-check the extracted limits against FAQs and release notes before finalizing. Escalate for approval if any source requires authenticated access.",
    text:
      "The FAQ confirms the Team seat cap, but the release note reference needs authenticated verification before we can present it as final.",
    eventCount: 6,
    tools: [
      {
        id: "tool-faq-002",
        name: "faq.lookup",
        status: "completed",
        args: "{\"topics\":[\"seat caps\",\"billing limits\",\"enterprise\"]}",
        result:
          "{\"team_cap\":50,\"enterprise_cap\":\"unbounded\",\"confidence\":\"partial\"}",
      },
    ],
    interrupts: [
      {
        threadId: "thread-test-center",
        content: {
          kind: "approval_required",
          reason: "Authenticated portal needed to verify the enterprise release note.",
        },
      },
    ],
  },
];

export default function Test() {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.14),_transparent_28%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-background to-black/20" />
      <div className="mx-auto flex min-h-screen w-full max-w-7xl items-center justify-center px-6 py-16">
        <div className="w-full max-w-5xl">
          <SubagentContainer
            subagents={DEMO_SUBAGENTS}
            expanded={expanded}
            onToggle={() => setExpanded((current) => !current)}
            subtitle="AG-UI stream preview"
            title="Delegated subagent containers"
          />
        </div>
      </div>
    </div>
  );
}
