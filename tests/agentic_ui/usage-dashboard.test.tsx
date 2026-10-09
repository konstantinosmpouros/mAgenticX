// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Usage tab as a dashboard you drill into (plan 33).
 *
 * Pinned: the contracts default every field and drop rows they cannot key;
 * ratios divide only by answers that report the quantity and say "—" rather
 * than zero; the daily series splits cached from fresh input; the tab moves
 * Overview → Agents → Compare → back with one header that follows it; the
 * compare table marks the highest and lowest per measure for screen readers
 * too; a conversation's page says what was replaced and opens the chat.
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

import UsageTab from "@/features/settings/components/profile_parts/UsageTab";
import { UsageConversationDetail } from "@/features/settings/components/profile_parts/usage/UsageConversationDetail";
import { PanelHeaderContext, type PanelHeader } from "@/features/settings/panel-header-context";
import {
  cacheHitRate,
  describeChange,
  fillDailySeries,
  timePerAnswer,
} from "@/features/settings/lib/usageMetrics";
import {
  UsageAgentListSchema,
  UsageConversationDetailSchema,
  UsageConversationPageSchema,
  UsageSummarySchema,
} from "@/shared/lib/schemas";
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

const agent = (over: Record<string, unknown>) =>
  UsageAgentListSchema.parse({ items: [{ key: "a", name: "Agent", kind: "platform", ...over }] }).items[0];

describe("the usage contracts", () => {
  it("default every field and drop what they cannot key", () => {
    const summary = UsageSummarySchema.parse({ totals: { inputTokens: 10, outputTokens: "lots" } });
    expect(summary.totals).toMatchObject({ inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, detailedAnswers: 0 });
    expect(summary.perModel).toEqual([]);

    const page = UsageConversationPageSchema.parse({ items: [{ id: "c1", totalTokens: 5 }, { title: "no id" }], private: null });
    expect(page.items.map((row) => row.id)).toEqual(["c1"]);
    expect(page.nextCursor).toBeNull();

    expect(agent({ kind: "something-else" }).kind).toBe("deleted");
    const detail = UsageConversationDetailSchema.parse({ branch: [{ id: "m1", contextTokens: -4, modelCalls: 2 }] });
    expect(detail.branch[0]).toMatchObject({ contextTokens: 0, modelCalls: 2, toolCalls: null });
  });
});

describe("the usage metrics", () => {
  it("divide only by answers that report the quantity", () => {
    const window = { cachedInputTokens: 80, detailedInputTokens: 100, modelMs: 9_000, modelCalls: 6, toolCalls: 2, detailedAnswers: 3 };
    expect(cacheHitRate(window)).toBe(0.8);
    expect(timePerAnswer(window)).toBe(3_000);
    expect(cacheHitRate({ ...window, detailedInputTokens: 0 })).toBeNull();
  });

  it("describe change as percent for amounts and points for rates", () => {
    expect(describeChange(150, 100, "amount")).toEqual({ label: "+50%", direction: "up" });
    expect(describeChange(0.84, 0.8, "rate")).toEqual({ label: "+4 pts", direction: "up" });
    expect(describeChange(5, 0, "amount")).toBeNull();
    expect(describeChange(null, 1, "rate")).toBeNull();
  });

  it("split each day into cached input, fresh input and output", () => {
    const today = new Date().toISOString().slice(0, 10);
    const point = UsageSummarySchema.parse({
      daily: [{ date: today, inputTokens: 1_000, cachedInputTokens: 1_200, outputTokens: 50, modelMs: 2_500 }],
    }).daily[0];
    const series = fillDailySeries([point], 7);
    expect(series).toHaveLength(7);
    expect(series[6]).toMatchObject({ cached: 1_000, fresh: 0, output: 50, seconds: 2.5 });
    expect(series[0]).toMatchObject({ cached: 0, fresh: 0, output: 0 });
  });
});

function renderTab(headers: PanelHeader[]) {
  const summary = UsageSummarySchema.parse({
    totals: { inputTokens: 5_000, outputTokens: 500, totalTokens: 5_500, aiMessages: 12 },
    last7Days: { totalTokens: 3_000, aiMessages: 4 },
    previous7Days: { totalTokens: 2_000, aiMessages: 2 },
    perAgent: [{ agentName: "Omni", totalTokens: 4_000 }],
    conversations: 9,
    agentCount: 2,
  });
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <PanelHeaderContext.Provider value={{ setHeader: (header) => header && headers.push(header) }}>
          <UsageTab
            userId="u1"
            summary={summary}
            loading={false}
            error={null}
            onRefresh={() => undefined}
            openConversation={null}
            agents={[]}
            onClosePanel={() => undefined}
            onManageAgents={() => undefined}
          />
        </PanelHeaderContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("the Usage tab", () => {
  it("drills from the Overview into Agents, compares two, and the header follows", async () => {
    api.getUsageAgents.mockResolvedValue(
      UsageAgentListSchema.parse({
        items: [
          { key: "omni", agentId: "omni", name: "Omni", kind: "platform", engine: "deep agent", answers: 40,
            totalTokens: 400_000, detailedAnswers: 40, modelCalls: 120, modelMs: 80_000 },
          { key: "pricing", agentId: "pricing", name: "Pricing analyst", kind: "custom", engine: "deep agent", answers: 10,
            totalTokens: 300_000, detailedAnswers: 10, modelCalls: 70, modelMs: 90_000 },
        ],
      }),
    );
    const headers: PanelHeader[] = [];
    renderTab(headers);

    expect(screen.getByText("Tokens · 7 days")).toBeTruthy();
    expect(screen.getByText("+50%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    await waitFor(() => expect(screen.getByText("Pricing analyst")).toBeTruthy());
    expect(screen.getByText("Your custom agents")).toBeTruthy();
    expect(headers.at(-1)).toMatchObject({ title: "Agents", backLabel: "Usage" });

    fireEvent.click(screen.getByRole("button", { name: /Compare/ }));
    fireEvent.click(screen.getByRole("button", { name: /Omni/ }));
    fireEvent.click(screen.getByRole("button", { name: /Pricing analyst/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare (2)" }));

    expect(headers.at(-1)).toMatchObject({ title: "Compare agents", backLabel: "Agents" });
    expect(screen.getByText("Tokens per answer")).toBeTruthy();
    expect(screen.getAllByText("(highest)").length).toBeGreaterThan(0);

    headers.at(-1)?.onBack?.();
    await waitFor(() => expect(headers.at(-1)).toMatchObject({ title: "Agents" }));
  });
});

describe("one conversation's page", () => {
  it("says what was replaced, splits the agents and opens the chat", async () => {
    api.getUsageConversation.mockResolvedValue(
      UsageConversationDetailSchema.parse({
        id: "c1", title: "Q3 planning", answers: 3, replaced: 1, totalTokens: 302_500, modelCalls: 7, toolCalls: 3,
        detailedAnswers: 2, cachedInputTokens: 180_000, detailedInputTokens: 250_000, modelMs: 4_000,
        groups: [
          { scope: "main", agentId: "omni", agentName: "Omni", model: "gpt-5", calls: 3, inputTokens: 220_000 },
          { scope: "subagent", agentName: "researcher", model: "gpt-4.1", calls: 3, inputTokens: 30_000 },
        ],
        branch: [{ id: "m1", contextTokens: 100_000, contextWindow: 272_000 }],
      }),
    );
    const onOpenChat = vi.fn();
    render(
      <UsageConversationDetail
        userId="u1"
        conversationId="c1"
        refreshToken={0}
        onBusyChange={() => undefined}
        onOpenChat={onOpenChat}
        onOpenAgent={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText(/1 replaced by a retry or an edit/)).toBeTruthy());
    expect(screen.getByText("researcher")).toBeTruthy();
    expect(screen.getByText("72%")).toBeTruthy();                  // cache hit: 180K of 250K
    expect(screen.getByText(/2 of\s+3 answers here have them/)).toBeTruthy();   // coverage, said plainly
    fireEvent.click(screen.getByRole("button", { name: /Open chat/ }));
    expect(onOpenChat).toHaveBeenCalledWith("c1");
  });
});
