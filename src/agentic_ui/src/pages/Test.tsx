import { useState } from "react";

import {
  HitlInterruptCard,
  type HitlInterrupt,
} from "@/features/chat/components/message_parts/HitlInterruptCard";
import { Button } from "@/shared/ui/button";
import { useToast } from "@/shared/hooks/use-toast";

// Toast demo fixtures — one entry per status variant so the branded card,
// icon chip, and per-variant countdown-bar colour can all be eyeballed.
const TOAST_DEMOS: Array<{ variant: string; title: string; description: string }> = [
  { variant: "default", title: "Heads up", description: "A neutral, informational notification." },
  {
    variant: "info",
    title: "Sync started",
    description: "We're pulling the latest changes in the background.",
  },
  {
    variant: "success",
    title: "Conversation added",
    description: "The agent response is now running in your workspace.",
  },
  {
    variant: "warning",
    title: "Session ending soon",
    description: "You'll be asked to sign in again shortly.",
  },
  {
    variant: "destructive",
    title: "Something went wrong",
    description: "There was an error loading the conversation. Please try again.",
  },
];

// HITL demo fixtures — three interrupt shapes so we can eyeball how the card
// renders strings, structured payloads, and longer JSON content. The third
// row is wired to simulate a failed resume call so the error/rollback path is
// visible in isolation without spinning up the agents service.
type DemoInterrupt = HitlInterrupt & {
  simulateError?: boolean;
};

const DEMO_HITL_INTERRUPTS: DemoInterrupt[] = [
  {
    interruptId: "demo-interrupt-1",
    threadId: "demo-thread-1",
    content: "Should I send the prepared email to legal@magenticx.com?",
  },
  {
    interruptId: "demo-interrupt-2",
    threadId: "demo-thread-1",
    content: {
      question: "Run this SQL against the analytics DB?",
      query: "SELECT id, customer_id, total FROM orders WHERE total > 5000;",
      estimated_rows: 142,
    },
  },
  {
    interruptId: "demo-interrupt-3",
    threadId: "demo-thread-1",
    content: {
      action: "delete_file",
      path: "/opt/magenticx/agents/store/cache/stale.json",
      reason: "Marked stale by the housekeeping subagent",
    },
    simulateError: true,
  },
];

async function mockResumeNetworkCall(simulateError: boolean): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (simulateError) {
    throw new Error("Simulated bridge error: thread no longer paused.");
  }
}

export default function Test() {
  const [resolvedHitl, setResolvedHitl] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.14),_transparent_28%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-background to-black/20" />

      <div className="mx-auto flex min-h-screen w-full max-w-7xl items-start justify-center px-6 py-16">
        <div className="w-full max-w-3xl space-y-6">
          <section className="space-y-3 rounded-[28px] border border-border bg-card/80 p-5 shadow-card">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Toast demo
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Each button fires a branded toast with a depleting countdown bar. Hover the stack to
                pause the countdown and fan the toasts out (fold). Use{" "}
                <span className="font-medium text-foreground">Fire 5</span> to see the collapsed
                stack.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {TOAST_DEMOS.map((demo) => (
                <Button
                  key={demo.variant}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => toast(demo)}
                  className="capitalize"
                >
                  {demo.variant}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const { id, dismiss } = toast({
                    variant: "loading",
                    title: "Working on it…",
                    description: "Running the agent in your workspace.",
                  });
                  window.setTimeout(() => {
                    dismiss();
                    toast({
                      variant: "success",
                      title: "All done",
                      description: "The task finished successfully.",
                    });
                  }, 2200);
                  void id;
                }}
              >
                Loading → success
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() =>
                  TOAST_DEMOS.forEach((demo, i) => window.setTimeout(() => toast(demo), i * 250))
                }
              >
                Fire 5
              </Button>
            </div>
          </section>

          <section className="space-y-3 rounded-[28px] border border-border bg-card/80 p-5 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  HITL approval demo
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click <span className="font-medium text-foreground">Approve</span> or{" "}
                  <span className="font-medium text-foreground">Reject</span> on any card. The mock
                  resolver simulates a 600 ms network round-trip. The third card simulates a backend
                  failure so the rollback / error path is visible.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setResolvedHitl(new Set())}
                disabled={resolvedHitl.size === 0}
                className="shrink-0"
              >
                Reset demo
              </Button>
            </div>

            <div className="flex flex-col gap-3">
              {DEMO_HITL_INTERRUPTS.map((interrupt) => (
                <HitlInterruptCard
                  key={interrupt.interruptId}
                  interrupt={{
                    interruptId: interrupt.interruptId,
                    threadId: interrupt.threadId,
                    content: interrupt.content,
                  }}
                  resolved={resolvedHitl.has(interrupt.interruptId)}
                  onResolve={async (_decision, _reason) => {
                    await mockResumeNetworkCall(Boolean(interrupt.simulateError));
                    setResolvedHitl((prev) => {
                      const next = new Set(prev);
                      next.add(interrupt.interruptId);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
