// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useComposer } from "@/features/chat/hooks/useComposer";
import type { ConversationDetail } from "@/shared/lib/types";

/**
 * The composer's input gate.
 *
 * `isBusy` is what every affordance checks before accepting input, and it is
 * deliberately NOT just the local send flag: a run the server is still streaming
 * into this conversation has to block a second send too. That case is the one
 * that bit — the UI lost its socket, believed nothing was running, and happily
 * offered to send again into a conversation the server still owned.
 *
 * The dictation signals are counters rather than booleans because the recorder
 * lives inside ChatInputBar and can only be driven by a value that changed;
 * a guard that returns without bumping is therefore indistinguishable from a
 * no-op, which is why the guards are asserted on the counters directly.
 */

const conversation = (messageCount: number) =>
  ({
    id: "c1",
    messages: Array.from({ length: messageCount }, (_, i) => ({ id: `m${i}` })),
  }) as unknown as ConversationDetail;

type Props = { isConversationStreaming: boolean; currentConversation: ConversationDetail | null };

const mount = (props: Partial<Props> = {}) =>
  renderHook(
    (p: Props) =>
      useComposer({
        userId: "u1",
        toast: vi.fn(),
        currentConversation: p.currentConversation,
        isConversationStreaming: p.isConversationStreaming,
      }),
    {
      initialProps: {
        isConversationStreaming: false,
        currentConversation: conversation(0),
        ...props,
      },
    },
  );

describe("useComposer", () => {
  it("starts with an empty draft and no attachments", () => {
    const { result } = mount();

    expect(result.current.currentMessage).toBe("");
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isBusy).toBe(false);
  });

  it("treats a server-side stream as busy even with no local send", () => {
    // The lost-socket case: `isSendingMessage` is false because this tab never
    // started the run, but the conversation is still owned by the server.
    const { result } = mount({ isConversationStreaming: true });

    expect(result.current.isSendingMessage).toBe(false);
    expect(result.current.isBusy).toBe(true);
  });

  it("treats a local send as busy", () => {
    const { result } = mount();

    act(() => result.current.setIsSendingMessage(true));

    expect(result.current.isBusy).toBe(true);
  });

  it("refuses to start dictation while busy", () => {
    const { result } = mount({ isConversationStreaming: true });
    const before = result.current.dictationRequestSignal;

    act(() => result.current.startDictation());

    expect(result.current.dictationRequestSignal).toBe(before);
  });

  it("starts dictation when idle and free", () => {
    const { result } = mount();
    const before = result.current.dictationRequestSignal;

    act(() => result.current.startDictation());

    expect(result.current.dictationRequestSignal).toBe(before + 1);
  });

  it("does not cancel dictation that never started", () => {
    const { result } = mount();
    const before = result.current.dictationCancelSignal;

    act(() => result.current.cancelDictation());

    expect(result.current.dictationCancelSignal).toBe(before);
  });

  it("cancels an in-progress recording", () => {
    const { result } = mount();
    act(() => result.current.handleDictationStatusChange("recording"));
    const before = result.current.dictationCancelSignal;

    act(() => result.current.cancelDictation());

    expect(result.current.dictationCancelSignal).toBe(before + 1);
  });

  it("refuses to cancel once the audio is submitting", () => {
    // Past the point of no return: the clip is already on its way to
    // transcription, so cancelling would strand the status.
    const { result } = mount();
    act(() => result.current.handleDictationStatusChange("submitting"));
    const before = result.current.dictationCancelSignal;

    act(() => result.current.cancelDictation());

    expect(result.current.dictationCancelSignal).toBe(before);
  });

  it("reports whether the conversation is empty, for the centered layout", () => {
    const { result, rerender } = mount();
    expect(result.current.isMessagesEmpty).toBe(true);

    rerender({ isConversationStreaming: false, currentConversation: conversation(2) });
    expect(result.current.isMessagesEmpty).toBe(false);
  });

  it("fills the draft from a starter suggestion", () => {
    const { result } = mount();

    act(() => result.current.applyDraft("Summarise this quarter"));

    expect(result.current.currentMessage).toBe("Summarise this quarter");
  });
});
