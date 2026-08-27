// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { createInferenceHandlers } from "@/features/inference";
import type { InferenceStartResponse, MessageOut } from "@/shared/lib/types";

/**
 * The send guards.
 *
 * `handleSendMessage` is called from three places (Enter, the send button, the
 * dictation submit) and the composer is cleared as a side effect of a successful
 * send. Every guard below therefore has to return *before* that clear — a guard
 * that returns late eats the user's typed message, which is silent and
 * unrecoverable. `isSendingMessage` is passed the combined busy flag
 * (`isSendingMessage || isCurrentConversationStreaming`), so "refuses while
 * busy" is what stops a second run being started against a streaming
 * conversation.
 */

const startResponse = { runId: "r1" } as unknown as InferenceStartResponse;

const makeCtx = (overrides: Record<string, unknown> = {}) => ({
  userId: "u1",
  selectedAgent: "agent-1",
  isPrivateMode: false,
  messages: [] as MessageOut[],
  attachments: [] as File[],
  agents: [],
  currentConversation: null,
  currentMessage: "hello",
  isSendingMessage: false,
  setMessages: vi.fn(),
  setCurrentMessage: vi.fn(),
  setAttachments: vi.fn(),
  setIsSendingMessage: vi.fn(),
  setCurrentConversation: vi.fn(),
  setConversations: vi.fn(),
  toast: vi.fn(),
  setThinkingState: vi.fn(),
  setShowAiTransition: vi.fn(),
  streamAbortRef: { current: null as AbortController | null },
  beginInferenceRun: vi.fn(async () => startResponse),
  stopActiveInferenceRun: vi.fn(),
  persistUIState: vi.fn(),
  ...overrides,
});

describe("handleSendMessage guards", () => {
  it("refuses to start a second run while the conversation is busy", async () => {
    const ctx = makeCtx({ isSendingMessage: true });
    const { handleSendMessage } = createInferenceHandlers(ctx);

    await handleSendMessage();

    expect(ctx.beginInferenceRun).not.toHaveBeenCalled();
    expect(ctx.setIsSendingMessage).not.toHaveBeenCalled();
  });

  it("keeps the typed message in the composer when it refuses", async () => {
    // The failure that matters: clearing the composer on a refused send loses
    // what the user wrote, with no error and nothing to undo.
    const ctx = makeCtx({ isSendingMessage: true });
    const { handleSendMessage } = createInferenceHandlers(ctx);

    await handleSendMessage();

    expect(ctx.setCurrentMessage).not.toHaveBeenCalled();
    expect(ctx.setAttachments).not.toHaveBeenCalled();
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });

  it("ignores an empty send with no attachments", async () => {
    const ctx = makeCtx({ currentMessage: "" });
    const { handleSendMessage } = createInferenceHandlers(ctx);

    await handleSendMessage();

    expect(ctx.beginInferenceRun).not.toHaveBeenCalled();
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it("refuses without a signed-in user and says so", async () => {
    const ctx = makeCtx({ userId: null });
    const { handleSendMessage } = createInferenceHandlers(ctx);

    await handleSendMessage();

    expect(ctx.setIsSendingMessage).not.toHaveBeenCalled();
    expect(ctx.setCurrentMessage).not.toHaveBeenCalled();
    expect(ctx.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("checks busy before emptiness so an attachment-only send is still blocked", async () => {
    // An attachment-only send passes the emptiness check, so the busy guard is
    // the only thing standing between it and a duplicate run.
    const ctx = makeCtx({
      isSendingMessage: true,
      currentMessage: "",
      attachments: [new File(["x"], "note.txt", { type: "text/plain" })],
    });
    const { handleSendMessage } = createInferenceHandlers(ctx);

    await handleSendMessage();

    expect(ctx.beginInferenceRun).not.toHaveBeenCalled();
    expect(ctx.setAttachments).not.toHaveBeenCalled();
  });
});
