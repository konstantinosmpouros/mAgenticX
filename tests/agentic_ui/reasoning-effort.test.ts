// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModelInfoSchema } from "@/shared/lib/schemas";
import { transformMessage } from "@/shared/lib/consts";
import { loadAgentEffort, saveAgentEffort } from "@/shared/lib/effortStorage";
import { resolveEffort } from "@/features/chat/lib/effort";
import {
  buildUserMessage,
  createInferenceHandlers,
  effortForAgent,
  effortForEdit,
} from "@/features/inference";
import type {
  Agent,
  InferenceStartRequest,
  InferenceStartResponse,
  MessageOut,
} from "@/shared/lib/types";

/**
 * Reasoning effort: the composer's picker shows the levels the agent's model
 * takes (`GET /agents/{user}/{agent}/model`), remembers the pick per agent, and
 * the pick rides on the user message of the start request — only for the agent
 * it was picked for, so an agent is never sent a level it did not list.
 */

describe("AgentModelInfoSchema", () => {
  it("parses the model response", () => {
    const info = AgentModelInfoSchema.parse({
      agentSlug: "researcher",
      model: "gpt-5",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
    expect(info).toEqual({
      agentSlug: "researcher",
      model: "gpt-5",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("reads a model without effort as no levels", () => {
    const info = AgentModelInfoSchema.parse({
      agentSlug: "chat",
      model: null,
      efforts: [],
      defaultEffort: null,
    });
    expect(info.efforts).toEqual([]);
    expect(info.defaultEffort).toBeNull();
    expect(info.model).toBeNull();
  });

  it("drops unknown and repeated levels, keeping the server's order", () => {
    const info = AgentModelInfoSchema.parse({
      agentSlug: "a",
      model: "m",
      efforts: ["xhigh", "turbo", "minimal", "xhigh", 3],
      defaultEffort: "turbo",
    });
    expect(info.efforts).toEqual(["xhigh", "minimal"]);
    expect(info.defaultEffort).toBeNull();
  });

  it("drops a default the list does not hold", () => {
    const info = AgentModelInfoSchema.parse({
      agentSlug: "a",
      model: "m",
      efforts: ["low", "high"],
      defaultEffort: "medium",
    });
    expect(info.defaultEffort).toBeNull();
  });

  it("degrades a malformed efforts field to no levels", () => {
    const info = AgentModelInfoSchema.parse({ agentSlug: "a", efforts: "high" });
    expect(info.efforts).toEqual([]);
  });
});

describe("resolveEffort", () => {
  it("is null when the agent lists no levels", () => {
    expect(resolveEffort([], "medium", "high")).toBeNull();
  });

  it("keeps the stored pick while the agent still lists it", () => {
    expect(resolveEffort(["low", "medium", "high"], "medium", "high")).toBe("high");
  });

  it("falls back to the default when the stored pick is no longer listed", () => {
    expect(resolveEffort(["low", "medium"], "low", "xhigh")).toBe("low");
  });

  it("uses the default with nothing stored", () => {
    expect(resolveEffort(["low", "medium", "high"], "high", null)).toBe("high");
  });

  it("uses the middle listed level with no default", () => {
    expect(resolveEffort(["low", "medium", "high"], null, null)).toBe("medium");
    expect(resolveEffort(["minimal", "low", "medium", "high", "xhigh"], null, null)).toBe(
      "medium",
    );
    expect(resolveEffort(["high"], null, null)).toBe("high");
  });

  it("ignores a default the agent does not list", () => {
    expect(resolveEffort(["low", "medium", "high"], "xhigh", null)).toBe("medium");
  });
});

describe("effort storage", () => {
  afterEach(() => localStorage.clear());

  it("remembers the pick per agent", () => {
    saveAgentEffort("a1", "high");
    saveAgentEffort("a2", "low");
    expect(loadAgentEffort("a1")).toBe("high");
    expect(loadAgentEffort("a2")).toBe("low");
    expect(loadAgentEffort("a3")).toBeNull();
  });

  it("reads an unknown stored value as nothing", () => {
    localStorage.setItem("mx_effort_a1", "ludicrous");
    expect(loadAgentEffort("a1")).toBeNull();
  });

  it("reads nothing when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadAgentEffort("a1")).toBeNull();
    spy.mockRestore();
  });
});

describe("transformMessage", () => {
  const base = {
    id: "m1",
    sender: "user",
    content: "hi",
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    attachments: [],
  };

  it("keeps the effort a message was sent with", () => {
    expect(transformMessage({ ...base, effort: "high" }).effort).toBe("high");
  });

  it("maps a missing or unknown effort to null", () => {
    expect(transformMessage(base).effort).toBeNull();
    expect(transformMessage({ ...base, effort: "ludicrous" }).effort).toBeNull();
  });
});

describe("buildUserMessage", () => {
  it("includes effort when given", () => {
    const message = buildUserMessage({ parentMessageId: "p1", content: "hi", effort: "low" });
    expect(message).toEqual({
      sender: "user",
      parentMessageId: "p1",
      content: "hi",
      effort: "low",
    });
  });

  it("leaves the key out when no effort is given", () => {
    for (const effort of [undefined, null]) {
      const message = buildUserMessage({ parentMessageId: null, content: "hi", effort });
      expect("effort" in message).toBe(false);
    }
  });

  it("carries attachments and the command as before", () => {
    const message = buildUserMessage({
      parentMessageId: null,
      content: undefined,
      attachments: [],
      command: { name: "summarize" },
    });
    expect(message).toEqual({
      sender: "user",
      parentMessageId: null,
      content: undefined,
      attachments: [],
      command: { name: "summarize" },
    });
  });
});

describe("which agent gets the effort", () => {
  const choice = { agentId: "a1", level: "high" as const };

  it("sends the pick only to the agent it was picked for", () => {
    expect(effortForAgent(choice, "a1")).toBe("high");
    expect(effortForAgent(choice, "a2")).toBeUndefined();
    expect(effortForAgent(null, "a1")).toBeUndefined();
    expect(effortForAgent({ agentId: "a1", level: null }, "a1")).toBeUndefined();
  });

  const msg = (over: Partial<MessageOut>): MessageOut => ({
    id: "x",
    sender: "user",
    created_at: new Date(0),
    updated_at: new Date(0),
    attachments: [],
    ...over,
  });

  it("an edit answered by the picked agent uses the pick", () => {
    const target = msg({ id: "u1", effort: "low" });
    const reply = msg({ id: "r1", sender: "ai", parentMessageId: "u1", agentId: "a1" });
    expect(effortForEdit(choice, target, [target, reply], "a9")).toBe("high");
  });

  it("an edit answered by another agent keeps the original's effort", () => {
    const target = msg({ id: "u1", effort: "low" });
    const reply = msg({ id: "r1", sender: "ai", parentMessageId: "u1", agentId: "a2" });
    expect(effortForEdit(choice, target, [target, reply], "a1")).toBe("low");
  });

  it("an edit with no reply goes to the conversation's agent", () => {
    const target = msg({ id: "u1", effort: null });
    expect(effortForEdit(choice, target, [target], "a1")).toBe("high");
    expect(effortForEdit(choice, target, [target], "a2")).toBeUndefined();
  });

  it("an edit for the picked agent that takes no effort sends none", () => {
    const target = msg({ id: "u1", effort: "low" });
    expect(effortForEdit({ agentId: "a1", level: null }, target, [target], "a1")).toBeUndefined();
  });
});

describe("handleSendMessage carries the effort", () => {
  const startResponse = { runId: "r1" } as unknown as InferenceStartResponse;
  const agent = { id: "a1", name: "Agent" } as unknown as Agent;

  const makeCtx = (effort: { agentId: string; level: "low" | "high" | null } | null) => ({
    userId: "u1",
    selectedAgent: "a1",
    isPrivateMode: false,
    messages: [] as MessageOut[],
    attachments: [] as File[],
    agents: [agent],
    currentConversation: null,
    currentMessage: "hello",
    pendingCommand: null,
    effort,
    isSendingMessage: false,
    setMessages: vi.fn(),
    setCurrentMessage: vi.fn(),
    setPendingCommand: vi.fn(),
    setAttachments: vi.fn(),
    setIsSendingMessage: vi.fn(),
    setCurrentConversation: vi.fn(),
    setConversations: vi.fn(),
    toast: vi.fn(),
    setThinkingState: vi.fn(),
    setShowAiTransition: vi.fn(),
    streamAbortRef: { current: null as AbortController | null },
    beginInferenceRun: vi.fn(async (_request: InferenceStartRequest) => startResponse),
    stopActiveInferenceRun: vi.fn(),
    persistUIState: vi.fn(),
  });

  it("puts the picked level on a new conversation's first message", async () => {
    const ctx = makeCtx({ agentId: "a1", level: "high" });
    await createInferenceHandlers(ctx).handleSendMessage();
    const request = ctx.beginInferenceRun.mock.calls[0][0];
    expect(request.message?.effort).toBe("high");
  });

  it("sends no effort when the agent takes none", async () => {
    const ctx = makeCtx({ agentId: "a1", level: null });
    await createInferenceHandlers(ctx).handleSendMessage();
    const request = ctx.beginInferenceRun.mock.calls[0][0];
    expect(request.message && "effort" in request.message).toBe(false);
  });

  it("sends no effort picked for another agent", async () => {
    const ctx = makeCtx({ agentId: "a2", level: "low" });
    await createInferenceHandlers(ctx).handleSendMessage();
    const request = ctx.beginInferenceRun.mock.calls[0][0];
    expect(request.message && "effort" in request.message).toBe(false);
  });
});
