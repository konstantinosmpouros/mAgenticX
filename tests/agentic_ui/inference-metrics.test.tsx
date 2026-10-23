// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inference metrics in the UI (plan 41): cost, time to first token, output
 * speed, truncation and tool metrics.
 *
 * Pinned: money formats from micro-USD at every scale and never claims "$0.00"
 * for something unpriced; every average divides by its own denominator and is
 * null (shown "—") when that is zero; old payloads still parse, with the new
 * fields defaulted (0 for sums, null for one answer's figures); a reply's card
 * shows cost, first token and speed only when recorded, and says when the
 * answer was cut off — beside the gauge too; the Usage pages show cost, speed,
 * truncation and the Tools table. No assertion depends on the machine's locale.
 */

const { api } = vi.hoisted(() => ({
  api: {
    getUsageSummary: vi.fn(),
    getUsageConversations: vi.fn(),
    getUsageConversation: vi.fn(),
    getUsageAgents: vi.fn(),
    getUsageAgent: vi.fn(),
  },
}));
vi.mock("@/shared/lib/api", () => api);

import { MessageUsage } from "@/features/chat/components/message_parts/MessageUsage";
import { UsageConversationDetail } from "@/features/settings/components/profile_parts/usage/UsageConversationDetail";
import { UsageOverview } from "@/features/settings/components/profile_parts/usage/UsageOverview";
import {
  avgTimeToFirstToken,
  costOf,
  costValue,
  firstTokenPerAnswer,
  tokensPerSecond,
  toolAvgDuration,
  toolAvgOutput,
  toolErrorRate,
  truncationRate,
} from "@/features/settings/lib/usageMetrics";
import { transformInferenceRun, transformMessage } from "@/shared/lib/consts";
import {
  UsageAgentDetailSchema,
  UsageAgentListSchema,
  UsageConversationDetailSchema,
  UsageConversationPageSchema,
  UsageSummarySchema,
} from "@/shared/lib/schemas";
import type { MessageOut } from "@/shared/lib/types";
import { describeCost, formatCost, formatSeconds, formatTokensPerSecond } from "@/shared/lib/utils";
import { TooltipProvider } from "@/shared/ui/tooltip";

beforeAll(() => {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe("formatting", () => {
  it("formats money from micro-USD at every scale", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1)).toBe("< $0.0001");
    expect(formatCost(99)).toBe("< $0.0001");
    expect(formatCost(100)).toBe("$0.0001");
    expect(formatCost(12_300)).toBe("$0.0123");
    expect(formatCost(500_000)).toBe("$0.50");
    expect(formatCost(999_990)).toBe("$1.00");
    expect(formatCost(12_340_000)).toBe("$12.34");
    // Grouping is fixed, whatever the browser's locale.
    expect(formatCost(1_234_500_000)).toBe("$1,234.50");
  });

  it("never prices what has no price", () => {
    expect(describeCost(undefined)).toEqual({ label: "—", note: null });
    expect(describeCost(0, 3)).toEqual({ label: "—", note: "not priced" });
    expect(describeCost(12_300, 1)).toEqual({ label: "$0.0123", note: "partly unpriced" });
    expect(describeCost(12_300, 0)).toEqual({ label: "$0.0123", note: null });
    // A total of nothing (answers from before pricing) is "—", not "$0.00".
    expect(costOf({ costMicros: 0, unpricedCalls: 0 })).toEqual({ label: "—", note: null });
    expect(costOf({ costMicros: 0, unpricedCalls: 2 })).toEqual({ label: "—", note: "not priced" });
    expect(costOf({ costMicros: 2_000_000 })).toEqual({ label: "$2.00", note: null });
    expect(costValue({ costMicros: 0 })).toBeNull();
    expect(costValue({ costMicros: 5 })).toBe(5);
  });

  it("formats speed and waits", () => {
    expect(formatTokensPerSecond(42.4)).toBe("42 tok/s");
    expect(formatTokensPerSecond(7.5)).toBe("7.5 tok/s");
    expect(formatSeconds(840)).toBe("0.84 s");
    expect(formatSeconds(2_340)).toBe("2.3 s");
    expect(formatSeconds(72_400)).toBe("1m 12s");
    expect(formatSeconds(Number.NaN)).toBe("—");
  });
});

describe("the ratios", () => {
  it("divide by their own denominators and give null for zero", () => {
    expect(firstTokenPerAnswer({ firstTokenMs: 3_000, firstTokenAnswers: 2 })).toBe(1_500);
    // Answers from before the metric add nothing to either side.
    expect(firstTokenPerAnswer({ firstTokenMs: 0, firstTokenAnswers: 0 })).toBeNull();

    const speed = { ttftMs: 1_200, ttftCalls: 3, genMs: 10_000, genOutputTokens: 500 };
    expect(avgTimeToFirstToken(speed)).toBe(400);
    expect(tokensPerSecond(speed)).toBe(50);
    expect(avgTimeToFirstToken({ ...speed, ttftCalls: 0 })).toBeNull();
    expect(tokensPerSecond({ ...speed, genMs: 0 })).toBeNull();

    expect(truncationRate({ truncatedCalls: 1, modelCalls: 4 })).toBe(0.25);
    expect(truncationRate({ truncatedCalls: 0, modelCalls: 0 })).toBeNull();

    const tool = { calls: 4, errors: 1, durationMs: 2_000, outputChars: 8_000 };
    expect(toolErrorRate(tool)).toBe(0.25);
    expect(toolAvgDuration(tool)).toBe(500);
    expect(toolAvgOutput(tool)).toBe(2_000);
    const none = { calls: 0, errors: 0, durationMs: 0, outputChars: 0 };
    expect([toolErrorRate(none), toolAvgDuration(none), toolAvgOutput(none)]).toEqual([null, null, null]);
  });
});

describe("the contracts", () => {
  it("parse a payload from before plan 41 with every new field defaulted", () => {
    const summary = UsageSummarySchema.parse({
      totals: { inputTokens: 10 },
      perModel: [{ model: "gpt-5", calls: 2 }],
    });
    expect(summary.totals).toMatchObject({
      costMicros: 0, unpricedCalls: 0, truncatedCalls: 0, firstTokenMs: 0, firstTokenAnswers: 0,
    });
    expect(summary.perModel[0]).toMatchObject({
      costMicros: 0, unpricedCalls: 0, truncatedCalls: 0, ttftMs: 0, ttftCalls: 0, genMs: 0, genOutputTokens: 0,
    });
    expect(summary.perTool).toEqual([]);

    const detail = UsageConversationDetailSchema.parse({ branch: [{ id: "m1" }], groups: [{ scope: "main" }] });
    expect(detail).toMatchObject({ costMicros: 0, unpricedCalls: 0, truncatedCalls: 0, tools: [] });
    // One answer's figures stay null: "not recorded", not "zero".
    expect(detail.branch[0]).toMatchObject({ costMicros: null, unpricedCalls: null, truncatedCalls: null, firstTokenMs: null });
    expect(detail.groups[0]).toMatchObject({ costMicros: 0, ttftCalls: 0, genMs: 0 });

    expect(UsageAgentDetailSchema.parse({ agent: { key: "a" } }).tools).toEqual([]);
    expect(UsageAgentListSchema.parse({ items: [{ key: "a" }] }).items[0]).toMatchObject({ costMicros: 0, truncatedCalls: 0 });
    expect(UsageConversationPageSchema.parse({ items: [{ id: "c1" }] }).items[0]).toMatchObject({ costMicros: 0, truncatedCalls: 0 });
  });

  it("parse the new fields and drop a tool row without a name", () => {
    const tools = [
      { toolName: "web_search", calls: 4, errors: 1, durationMs: 2_000, outputChars: 8_000 },
      { calls: 9 },
    ];
    const summary = UsageSummarySchema.parse({
      last7Days: { costMicros: 1_500_000, unpricedCalls: 1, truncatedCalls: 2, firstTokenMs: 2_400, firstTokenAnswers: 2 },
      perModel: [{ model: "gpt-5", costMicros: 900, ttftMs: 1_000, ttftCalls: 2, genMs: 4_000, genOutputTokens: 200 }],
      daily: [{ date: "2026-10-20", costMicros: 7, firstTokenAnswers: 1 }],
      perAgent: [{ agentName: "Omni", costMicros: 11 }],
      perTool: tools,
    });
    expect(summary.last7Days).toMatchObject({ costMicros: 1_500_000, unpricedCalls: 1, truncatedCalls: 2, firstTokenMs: 2_400 });
    expect(summary.perModel[0]).toMatchObject({ costMicros: 900, ttftCalls: 2, genOutputTokens: 200 });
    expect(summary.daily[0]).toMatchObject({ costMicros: 7, firstTokenAnswers: 1 });
    expect(summary.perAgent[0].costMicros).toBe(11);
    expect(summary.perTool).toEqual([tools[0]]);

    const detail = UsageConversationDetailSchema.parse({
      costMicros: 40, unpricedCalls: 1, truncatedCalls: 1, tools,
      branch: [{ id: "m1", costMicros: 40, unpricedCalls: 0, truncatedCalls: 1, firstTokenMs: 900 }],
      groups: [{ scope: "subagent", costMicros: 40, unpricedCalls: 1, truncatedCalls: 1, ttftMs: 5, ttftCalls: 1, genMs: 9, genOutputTokens: 3 }],
    });
    expect(detail).toMatchObject({ costMicros: 40, unpricedCalls: 1, truncatedCalls: 1 });
    expect(detail.tools.map((tool) => tool.toolName)).toEqual(["web_search"]);
    expect(detail.branch[0]).toMatchObject({ costMicros: 40, unpricedCalls: 0, truncatedCalls: 1, firstTokenMs: 900 });
    expect(detail.groups[0]).toMatchObject({ unpricedCalls: 1, ttftMs: 5, genOutputTokens: 3 });
    expect(UsageAgentDetailSchema.parse({ tools }).tools).toHaveLength(1);
  });

  it("carry a reply's metrics through the message and run transforms, camel or snake", () => {
    const base = { id: "m1", sender: "ai", created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", attachments: [] };
    const metrics = {
      costMicros: 12_300, unpricedCalls: 1, truncatedCalls: 1, firstTokenMs: 1_250,
      ttftMs: 900, ttftCalls: 2, genMs: 4_000, genOutputTokens: 200,
    };
    expect(transformMessage({ ...base, ...metrics })).toMatchObject(metrics);
    expect(
      transformMessage({
        ...base, cost_micros: 12_300, unpriced_calls: 1, truncated_calls: 1, first_token_ms: 1_250,
        ttft_ms: 900, ttft_calls: 2, gen_ms: 4_000, gen_output_tokens: 200,
      }),
    ).toMatchObject(metrics);
    expect(transformInferenceRun({ id: "r1", ...metrics })).toMatchObject(metrics);

    const old = transformMessage(base);
    expect([old.costMicros, old.truncatedCalls, old.firstTokenMs, old.genMs]).toEqual([undefined, undefined, undefined, undefined]);
    expect(transformMessage({ ...base, costMicros: "a lot", genMs: -1 })).toMatchObject({ costMicros: undefined, genMs: undefined });
  });
});

const msg = (over: Partial<MessageOut>): MessageOut =>
  ({ id: "m1", sender: "ai", created_at: new Date(), updated_at: new Date(), attachments: [], ...over }) as MessageOut;

function renderUsage(message: MessageOut) {
  render(
    <TooltipProvider>
      <MessageUsage message={message} />
    </TooltipProvider>,
  );
  const trigger = screen.getByLabelText(/^Token usage:/);
  fireEvent.focus(trigger);
  return trigger;
}

describe("a reply's usage card", () => {
  it("shows cost, first token and output speed, and says when the answer was cut off", async () => {
    const trigger = renderUsage(
      msg({
        inputTokens: 1_000, outputTokens: 200, modelName: "gpt-5",
        costMicros: 12_300, unpricedCalls: 1, firstTokenMs: 1_500, genMs: 4_000, genOutputTokens: 200, truncatedCalls: 1,
      }),
    );
    // Noticeable without opening the card: the gauge carries the warning.
    expect(trigger.getAttribute("aria-label")).toMatch(/Cut off at the output limit$/);

    await waitFor(() => expect(screen.getAllByText("Est. cost").length).toBeGreaterThan(0));
    expect(screen.getAllByText("$0.0123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(partly unpriced)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.5 s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50 tok/s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cut off at the output limit").length).toBeGreaterThan(0);
  });

  it("says a reply with no priced model is not priced, never $0.00", async () => {
    renderUsage(msg({ inputTokens: 10, outputTokens: 5, costMicros: 0, unpricedCalls: 2 }));
    await waitFor(() => expect(screen.getAllByText("Est. cost").length).toBeGreaterThan(0));
    expect(screen.getAllByText("(not priced)").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("keeps the old card for a reply from before the metrics", async () => {
    const trigger = renderUsage(msg({ inputTokens: 10, outputTokens: 5, modelName: "gpt-5" }));
    expect(trigger.getAttribute("aria-label")).not.toMatch(/Cut off/);
    await waitFor(() => expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0));
    expect(screen.queryByText("Est. cost")).toBeNull();
    expect(screen.queryByText("First token")).toBeNull();
    expect(screen.queryByText("Output speed")).toBeNull();
    expect(screen.queryByText("Cut off at the output limit")).toBeNull();
  });
});

describe("the Usage pages", () => {
  it("the Overview shows cost, first token, per-model speed, cut-off calls and the tools", () => {
    const summary = UsageSummarySchema.parse({
      totals: { totalTokens: 9_000, aiMessages: 12, costMicros: 3_000_000 },
      last7Days: { totalTokens: 3_000, aiMessages: 4, costMicros: 2_500_000, firstTokenMs: 2_400, firstTokenAnswers: 2 },
      previous7Days: { totalTokens: 2_000, aiMessages: 2, costMicros: 0 },
      last30Days: { totalTokens: 5_000, aiMessages: 8, modelCalls: 8, truncatedCalls: 2 },
      perModel: [
        { model: "gpt-5", calls: 4, inputTokens: 900, costMicros: 2_000_000, ttftMs: 1_600, ttftCalls: 2, genMs: 10_000, genOutputTokens: 500 },
        { model: "local-llm", calls: 2, inputTokens: 100, unpricedCalls: 2 },
      ],
      perTool: [{ toolName: "web_search", calls: 4, errors: 1, durationMs: 2_000, outputChars: 8_000 }],
    });
    render(
      <UsageOverview
        summary={summary}
        error={null}
        onRetry={() => undefined}
        openConversation={null}
        onOpenConversation={() => undefined}
        onOpenConversations={() => undefined}
        onOpenAgents={() => undefined}
      />,
    );

    expect(screen.getByText("Cost · 7 days")).toBeTruthy();
    expect(screen.getByText("$2.50")).toBeTruthy();
    expect(screen.getByText("1.2 s")).toBeTruthy(); // first token: 2.4 s over 2 answers
    expect(screen.getByText("$2.00 · first token 0.80 s · 50 tok/s")).toBeTruthy();
    expect(screen.getByText("not priced")).toBeTruthy(); // the model without a price
    expect(screen.getByText(/were cut off \(25% of calls\)/)).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.getByText("0.50 s")).toBeTruthy(); // avg tool time
  });

  it("one conversation shows its cost, first token, cut-off answers and tools", async () => {
    api.getUsageConversation.mockResolvedValue(
      UsageConversationDetailSchema.parse({
        id: "c1", title: "Q3 planning", answers: 2, totalTokens: 10_000, modelCalls: 4,
        costMicros: 1_230_000, unpricedCalls: 1, truncatedCalls: 1,
        tools: [{ toolName: "read_file", calls: 2, errors: 0, durationMs: 300, outputChars: 1_000 }],
        branch: [
          { id: "m1", inputTokens: 100, costMicros: 600_000, firstTokenMs: 800, truncatedCalls: 1 },
          { id: "m2", inputTokens: 100 }, // from before the metrics
        ],
      }),
    );
    render(
      <UsageConversationDetail
        userId="u1"
        conversationId="c1"
        refreshToken={0}
        onBusyChange={() => undefined}
        onOpenChat={() => undefined}
        onOpenAgent={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText("$1.23")).toBeTruthy());
    expect(screen.getByText("partly unpriced")).toBeTruthy();
    expect(screen.getByText("0.80 s")).toBeTruthy(); // averaged over the one answer that measured it
    expect(screen.getByText(/1 model call in this conversation hit the output limit/)).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText(/\$0\.60 · .*first token 0\.80 s/)).toBeTruthy();
    expect(screen.getAllByText("1 call cut off at the output limit").length).toBeGreaterThan(0);
  });
});
