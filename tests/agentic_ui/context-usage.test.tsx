// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * The composer's context gauge (usage metrics).
 *
 * Pinned: the live run's latest MAIN-agent call wins over persisted messages;
 * otherwise the latest AI message on the visible branch that recorded one;
 * a sub-agent's usage never moves the gauge; the transform keeps the new
 * fields and drops garbage; the gauge says what it measures; a reply's own
 * usage reads its total and formats model time at every scale; the context
 * card's conversation block counts every finished answer, replaced ones
 * included, with their model and tool calls.
 */
import { ContextMeter } from "@/features/chat/components/ContextMeter";
import { MessageUsage } from "@/features/chat/components/message_parts/MessageUsage";
import { contextLevel, selectConversationContext, selectConversationStats } from "@/features/chat/lib/contextUsage";
import { formatModelTime } from "@/shared/lib/utils";
import { countRunActivity, createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import { transformMessage } from "@/shared/lib/consts";
import type { InferenceRun, MessageOut } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const usage = (value: Record<string, unknown>) => ({ type: "CUSTOM", name: "TOKEN_USAGE", value });
const subagent = (event: unknown) => ({ type: "CUSTOM", name: "SUBAGENT_EVENT", value: { event } });

const msg = (over: Partial<MessageOut>): MessageOut =>
  ({ id: Math.random().toString(36), sender: "ai", created_at: new Date(), updated_at: new Date(), attachments: [], ...over }) as MessageOut;

describe("the run timeline", () => {
  it("keeps the main agent's latest context, never a sub-agent's", () => {
    const timeline = reduceTimelineEvents(createTimeline(), [
      usage({ input_tokens: 100_000, context_tokens: 100_000, context_window: 272_000, context_percent: 36.8, model: "gpt-5" }),
      subagent(usage({ input_tokens: 9_000, context_tokens: 9_000, context_window: 128_000, model: "gpt-4o" })),
      usage({ input_tokens: 117_000, context_tokens: 117_000, context_window: 272_000, context_percent: 43, compaction_percent: 92, model: "gpt-5" }),
    ] as never);

    expect(timeline.context).toEqual({ model: "gpt-5", tokens: 117_000, window: 272_000, percent: 43, compactionPercent: 92 });
  });

  it("usage without metrics leaves the context unset", () => {
    const timeline = reduceTimelineEvents(createTimeline(), [usage({ input_tokens: 10, output_tokens: 5 })] as never);
    expect(timeline.context ?? null).toBeNull();
  });
});

describe("selectConversationContext", () => {
  it("prefers the live run", () => {
    const run = { timeline: { ...createTimeline(), context: { tokens: 5, window: 10, percent: 50 } } } as unknown as InferenceRun;
    const messages = [msg({ contextTokens: 1, contextWindow: 10 })];
    expect(selectConversationContext(messages, run)?.percent).toBe(50);
  });

  it("otherwise reads the latest AI message that recorded a context", () => {
    const messages = [
      msg({ contextTokens: 50_000, contextWindow: 272_000, modelName: "gpt-5" }),
      msg({ sender: "user" }),
      msg({}), // an AI reply from before usage metrics: skipped
    ];
    expect(selectConversationContext(messages, null)).toEqual({
      model: "gpt-5", tokens: 50_000, window: 272_000, percent: 18.4, compactionPercent: undefined,
    });
    expect(selectConversationContext([msg({ sender: "user" })], null)).toBeNull();
  });

  it("grades the level against the compaction point", () => {
    expect(contextLevel({ tokens: 1, percent: 40 })).toBe("ok");
    expect(contextLevel({ tokens: 1, percent: 75, compactionPercent: 92 })).toBe("high");
    expect(contextLevel({ tokens: 1, percent: 88, compactionPercent: 92 })).toBe("critical");
  });
});

describe("transformMessage", () => {
  it("keeps the usage fields and drops what is not a number", () => {
    const out = transformMessage({
      id: "m1", sender: "ai", created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:00:00Z", attachments: [],
      cachedInputTokens: 80_000, reasoningTokens: 300, modelLatencyMs: 1_200, contextTokens: 117_000,
      contextWindow: 272_000, compactionPercent: 92, modelName: "gpt-5",
    });
    expect(out).toMatchObject({ cachedInputTokens: 80_000, contextTokens: 117_000, contextWindow: 272_000, modelName: "gpt-5" });
    const garbage = transformMessage({ id: "m2", sender: "ai", attachments: [], contextTokens: "lots", contextWindow: -1 });
    expect(garbage.contextTokens).toBeUndefined();
    expect(garbage.contextWindow).toBeUndefined();
  });
});

describe("ContextMeter", () => {
  it("shows the percentage and says what it measures", () => {
    render(
      <TooltipProvider>
        <ContextMeter context={{ model: "gpt-5", tokens: 117_000, window: 272_000, percent: 43, compactionPercent: 92 }} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Context window: 43% used" })).toBeTruthy();
    expect(screen.getByText("43%")).toBeTruthy();
  });

  it("renders nothing without a context", () => {
    const { container } = render(
      <TooltipProvider>
        <ContextMeter context={null} />
      </TooltipProvider>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("a reply's usage", () => {
  it("names its total for assistive tech", () => {
    render(
      <TooltipProvider>
        <MessageUsage message={msg({ inputTokens: 14_649, outputTokens: 225, modelName: "gpt-5" })} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("Token usage: 14,874 tokens")).toBeTruthy();
  });

  it("formats model time from milliseconds to minutes", () => {
    expect(formatModelTime(840)).toBe("840 ms");
    expect(formatModelTime(7_040)).toBe("7.0 s");
    expect(formatModelTime(72_400)).toBe("1m 12s");
  });
});

describe("countRunActivity", () => {
  it("counts model and tool calls across the main agent and its sub-agents, once each", () => {
    const toolStart = (toolCallId: string) => ({ type: "TOOL_CALL_START", toolCallId, toolCallName: "search" });
    expect(
      countRunActivity([
        usage({ input_tokens: 10, message_id: "call-1" }),
        usage({ input_tokens: 10, message_id: "call-1" }), // a replayed event is not a second call
        subagent(usage({ input_tokens: 5, message_id: "call-2" })),
        toolStart("t1"),
        subagent(toolStart("t2")),
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
      ] as never),
    ).toEqual({ modelCalls: 2, toolCalls: 2 });
    expect(countRunActivity(undefined)).toEqual({ modelCalls: 0, toolCalls: 0 });
  });
});

describe("selectConversationStats", () => {
  it("sums every finished answer, counting the ones off the visible branch as replaced", () => {
    const shown = msg({
      inputTokens: 40_000, outputTokens: 150, cachedInputTokens: 36_000, modelLatencyMs: 4_600,
      rawEvents: [usage({ message_id: "a" }), usage({ message_id: "b" }), { type: "TOOL_CALL_START", toolCallId: "t1" }],
    });
    // From before usage metrics: no model time, so its call stays out of the latency average.
    const retried = msg({ inputTokens: 9_000, outputTokens: 44, rawEvents: [usage({ message_id: "c" })] });
    const user = msg({ sender: "user" });
    const unfinished = msg({}); // the in-flight answer: no usage yet

    expect(selectConversationStats([user, retried, shown, unfinished], [user, shown, unfinished])).toEqual({
      answers: 2, replaced: 1, modelCalls: 3, toolCalls: 1,
      inputTokens: 49_000, cachedInputTokens: 36_000, outputTokens: 194,
      modelMs: 4_600, timedCalls: 2,
    });
    expect(selectConversationStats([user, unfinished], [user, unfinished])).toBeNull();
  });
});
