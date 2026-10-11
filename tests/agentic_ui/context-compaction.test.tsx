// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Compaction you can trigger and see (plan 34).
 *
 * Pinned: an automatic compaction folds into one timeline divider (running,
 * then done; or done alone); the message transform keeps a manual compaction
 * and drops anything else; after one, the context gauge reads the smaller
 * figure (not once undone) and the conversation's spend includes the summary
 * call; the ring compacts on click only when it can, and says so; the divider
 * names what happened and expands to the summary; the hook compacts the leaf
 * answer, replaces it, and explains every reason it cannot.
 */
vi.mock("@/shared/lib/api", () => ({
  compactConversation: vi.fn(),
  undoCompaction: vi.fn(),
}));

import { compactConversation } from "@/shared/lib/api";
import { ContextMeter } from "@/features/chat/components/ContextMeter";
import { CompactionDivider } from "@/features/chat/components/message_parts/CompactionDivider";
import { useConversationCompaction } from "@/features/chat/hooks/useConversationCompaction";
import { selectConversationContext, selectConversationStats } from "@/features/chat/lib/contextUsage";
import { createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import { transformMessage } from "@/shared/lib/consts";
import type { ContextCompactionControl, MessageCompaction, MessageOut, RunContextUsage } from "@/shared/lib/types";

const compactionEvent = (value: Record<string, unknown>) => ({ type: "CUSTOM", name: "CONTEXT_COMPACTION", value });

const msg = (over: Partial<MessageOut>): MessageOut =>
  ({ id: Math.random().toString(36), sender: "ai", created_at: new Date(), updated_at: new Date(), attachments: [], ...over }) as MessageOut;

const record = (over: Partial<MessageCompaction> = {}): MessageCompaction => ({
  trigger: "manual",
  tokensBefore: 110_000,
  tokensAfter: 20_000,
  freed: 90_000,
  window: 272_000,
  summarizedMessages: 30,
  keptMessages: 2,
  summary: "The user is planning a trip.",
  model: "gpt-5",
  inputTokens: 90_000,
  cachedInputTokens: 10_000,
  outputTokens: 1_200,
  latencyMs: 8_000,
  compactedAt: new Date(),
  undoneAt: null,
  ...over,
});

describe("an automatic compaction in the run timeline", () => {
  it("opens a running divider and fills it in when done", () => {
    const running = reduceTimelineEvents(createTimeline(), [compactionEvent({ phase: "started", trigger: "auto" })] as never);
    expect(running.blocks.map((b) => [b.kind, (b as { status?: string }).status])).toEqual([["compaction", "running"]]);

    const done = reduceTimelineEvents(running, [
      compactionEvent({ phase: "started", trigger: "auto" }), // a repeat never opens a second one
      compactionEvent({ phase: "done", tokens_before: 130_000, tokens_after: 40_000, freed: 90_000, summarized_messages: 30, kept_messages: 4 }),
    ] as never);
    expect(done.blocks).toHaveLength(1);
    expect(done.blocks[0]).toMatchObject({ kind: "compaction", status: "done", freed: 90_000, tokensAfter: 40_000, keptMessages: 4 });
  });

  it("records a done without a start as one finished divider", () => {
    const timeline = reduceTimelineEvents(createTimeline(), [compactionEvent({ phase: "done", freed: 5 })] as never);
    expect(timeline.blocks[0]).toMatchObject({ kind: "compaction", status: "done", freed: 5 });
  });
});

describe("the message transform", () => {
  it("keeps a manual compaction and drops anything else", () => {
    const kept = transformMessage({ id: "a", sender: "ai", compaction: { trigger: "manual", freed: 90_000, summary: "s", compactedAt: "2026-10-08T10:00:00Z", undoneAt: null } });
    expect(kept.compaction).toMatchObject({ trigger: "manual", freed: 90_000, summary: "s", undoneAt: null });
    expect(transformMessage({ id: "b", sender: "ai", compaction: { trigger: "auto" } }).compaction).toBeNull();
    expect(transformMessage({ id: "c", sender: "ai" }).compaction).toBeNull();
  });
});

describe("after a compaction", () => {
  it("the gauge reads the smaller context, unless it was undone", () => {
    const answer = msg({ contextTokens: 110_000, contextWindow: 272_000, compactionPercent: 92, compaction: record() });
    expect(selectConversationContext([answer])).toMatchObject({ tokens: 20_000, percent: 7.4 });

    const undone = { ...answer, compaction: record({ undoneAt: new Date() }) };
    expect(selectConversationContext([undone])?.tokens).toBe(110_000);
  });

  it("the conversation's spend includes the summary call, never as an answer", () => {
    const answer = msg({ inputTokens: 110_000, outputTokens: 900, compaction: record() });
    const stats = selectConversationStats([answer], [answer]);
    expect(stats).toMatchObject({ answers: 1, modelCalls: 1, inputTokens: 200_000, outputTokens: 2_100, cachedInputTokens: 10_000 });
  });
});

const control = (over: Partial<ContextCompactionControl> = {}): ContextCompactionControl => ({
  status: "idle",
  disabledReason: null,
  compactingMessageId: null,
  compact: vi.fn(),
  ...over,
});

describe("the context ring", () => {
  const context = { model: "gpt-5", tokens: 110_000, window: 272_000, percent: 40, compactionPercent: 92 };

  it("compacts on click and says so", () => {
    const compaction = control();
    render(<ContextMeter context={context} compaction={compaction} />);
    const ring = screen.getByRole("button", { name: "Context window: 40% used. Click to compact the conversation" });
    fireEvent.click(ring);
    expect(compaction.compact).toHaveBeenCalledTimes(1);
  });

  it("does nothing on click when it cannot compact, and keeps its plain name", () => {
    const compaction = control({ disabledReason: "Wait for the answer to finish to compact." });
    render(<ContextMeter context={context} compaction={compaction} />);
    fireEvent.click(screen.getByRole("button", { name: "Context window: 40% used" }));
    expect(compaction.compact).not.toHaveBeenCalled();
  });

  it("opens the card on a tap from a finger, even where hover is reported", () => {
    // Phones with a stylus and some Android browsers match (hover: hover):
    // the tap itself, not the media query, must decide.
    const compaction = control();
    render(<ContextMeter context={context} compaction={compaction} />);
    const ring = screen.getByRole("button", { name: /Context window: 40% used/ });
    act(() => {
      ring.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
    });
    expect(compaction.compact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(compaction.compact).toHaveBeenCalledTimes(1);
  });

  it("opens the card on the mobile layout instead of compacting", async () => {
    const width = window.innerWidth;
    window.innerWidth = 500;
    try {
      const compaction = control();
      render(<ContextMeter context={context} compaction={compaction} />);
      const ring = await screen.findByRole("button", { name: "Context window: 40% used" });
      fireEvent.click(ring);
      expect(compaction.compact).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Compact now" })).toBeTruthy();
    } finally {
      window.innerWidth = width;
    }
  });

  it("is busy while compacting", () => {
    render(<ContextMeter context={context} compaction={control({ status: "compacting", disabledReason: "Compacting…" })} />);
    expect(screen.getByRole("button", { name: /Compacting the conversation/ }).getAttribute("aria-busy")).toBe("true");
  });
});

describe("the divider", () => {
  it("names what happened and expands to the summary", () => {
    render(<CompactionDivider trigger="manual" status="done" freed={81_000} summary="The user is planning a trip." />);
    const headline = screen.getByRole("button", { name: /Compacted chat · manual · 81K tokens freed/ });
    expect(screen.queryByText("The user is planning a trip.")).toBeNull();
    fireEvent.click(headline);
    expect(screen.getByText("The user is planning a trip.")).toBeTruthy();
  });

  it("shows compacting while it runs", () => {
    render(<CompactionDivider trigger="manual" status="running" />);
    expect(screen.getByRole("separator", { name: "Compacting the conversation" })).toBeTruthy();
  });
});

describe("useConversationCompaction", () => {
  beforeEach(() => vi.mocked(compactConversation).mockReset());

  const answer = msg({ id: "a1", streamingStatus: "completed", contextTokens: 110_000 });
  const base = {
    userId: "u1",
    conversationId: "c1",
    activeMessages: [msg({ id: "q0", sender: "user" }), msg({ id: "a0" }), msg({ id: "q1", sender: "user" }), answer],
    context: { tokens: 110_000, window: 272_000, percent: 40, compactionPercent: 75 } as RunContextUsage,
    busy: false,
  };

  it("explains every reason it cannot compact", () => {
    const setter = vi.fn();
    const reason = (over: Partial<typeof base>) =>
      renderHook(() => useConversationCompaction({ ...base, ...over, setConversationMessages: setter })).result.current
        ?.disabledReason;
    expect(reason({})).toBeNull();
    expect(reason({ busy: true })).toMatch(/Wait for the answer/);
    expect(reason({ context: { tokens: 1 } })).toMatch(/doesn't compact/);
    // At or under 5% of the window there is too little to be worth a summary.
    expect(reason({ context: { tokens: 13_600, window: 272_000, percent: 5, compactionPercent: 75 } })).toMatch(/passes 5%/);
    expect(reason({ activeMessages: [msg({ sender: "user" }), answer, msg({ sender: "user" })] })).toMatch(/after the agent's answer/);
    // One exchange only: the latest exchange is always kept, so nothing older to fold.
    expect(reason({ activeMessages: [msg({ sender: "user" }), answer] })).toMatch(/nothing older/);
    expect(renderHook(() => useConversationCompaction({ ...base, userId: null, setConversationMessages: setter })).result.current).toBeNull();
  });

  it("compacts after the latest answer and replaces it", async () => {
    const compacted = { ...answer, compaction: record() };
    vi.mocked(compactConversation).mockResolvedValue({ status: "compacted", message: compacted });
    let messages: MessageOut[] = base.activeMessages;
    const setter = vi.fn((update: (prev: MessageOut[]) => MessageOut[]) => {
      messages = update(messages);
    });
    const { result } = renderHook(() => useConversationCompaction({ ...base, setConversationMessages: setter }));

    act(() => result.current?.compact());
    expect(result.current?.status).toBe("compacting");
    expect(result.current?.compactingMessageId).toBe("a1");
    await waitFor(() => expect(result.current?.status).toBe("idle"));

    expect(compactConversation).toHaveBeenCalledWith("u1", "c1", "a1");
    expect(messages[3].compaction?.freed).toBe(90_000);
  });
});
