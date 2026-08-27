// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMessageInteraction } from "@/features/chat/hooks/useMessageInteraction";
import type { ConversationDetail, MessageOut } from "@/shared/lib/types";

/**
 * The per-message interaction layer.
 *
 * Two things here are easy to get subtly wrong and impossible to see in a diff.
 * The editing draft must be dropped when the conversation changes — it is keyed
 * by a message id that does not exist in the next conversation, so carrying it
 * across would either edit the wrong message or strand the composer in an edit
 * that can never be submitted. And `expandedThinking` is a *sparse* record whose
 * absent entries mean "use the block's own default", so a toggle that flips a
 * plain boolean silently no-ops on the first click of any block that defaults to
 * open.
 */

const message = (id: string, parentMessageId: string | null = null) =>
  ({ id, parentMessageId, sender: "user", content: id }) as unknown as MessageOut;

const conversation = (id: string, messages: MessageOut[] = []) =>
  ({ id, messages }) as unknown as ConversationDetail;

const mount = (initial: ConversationDetail | null) =>
  renderHook(
    (props: { currentConversation: ConversationDetail | null }) => useMessageInteraction(props),
    { initialProps: { currentConversation: initial } },
  );

describe("useMessageInteraction", () => {
  it("drops the editing draft when the conversation changes", () => {
    const { result, rerender } = mount(conversation("c1", [message("m1")]));

    act(() => {
      result.current.setEditingMessageId("m1");
      result.current.setEditingDraft("half-written edit");
      result.current.setEditingBusy(true);
    });
    expect(result.current.editingMessageId).toBe("m1");

    rerender({ currentConversation: conversation("c2", [message("m9")]) });

    expect(result.current.editingMessageId).toBeNull();
    expect(result.current.editingDraft).toBe("");
    expect(result.current.editingBusy).toBe(false);
  });

  it("keeps the draft across a re-render of the same conversation", () => {
    // Only an id change resets — otherwise every streamed token would wipe an
    // in-progress edit, since the conversation object is replaced each time.
    const { result, rerender } = mount(conversation("c1", [message("m1")]));

    act(() => result.current.setEditingDraft("still typing"));
    rerender({ currentConversation: conversation("c1", [message("m1"), message("m2", "m1")]) });

    expect(result.current.editingDraft).toBe("still typing");
  });

  it("toggles a thinking block that has never been touched", () => {
    // The sparse-record trap: `prev[id]` is undefined here, so `!prev[id]` is
    // true and the first click must register as an explicit expand.
    const { result } = mount(conversation("c1", [message("m1")]));

    act(() => result.current.toggleThinking("m1"));
    expect(result.current.expandedThinking.m1).toBe(true);

    act(() => result.current.toggleThinking("m1"));
    expect(result.current.expandedThinking.m1).toBe(false);
  });

  it("honours an explicit expanded value over a flip", () => {
    const { result } = mount(conversation("c1", [message("m1")]));

    act(() => result.current.toggleThinking("m1", false));
    expect(result.current.expandedThinking.m1).toBe(false);

    act(() => result.current.toggleThinking("m1", false));
    expect(result.current.expandedThinking.m1).toBe(false);
  });

  it("leaves other messages' thinking state untouched", () => {
    const { result } = mount(conversation("c1", [message("m1"), message("m2")]));

    act(() => result.current.toggleThinking("m1", true));
    act(() => result.current.toggleThinking("m2", false));

    expect(result.current.expandedThinking).toEqual({ m1: true, m2: false });
  });

  it("drops the transition dot when the conversation changes", () => {
    // `showAiTransition` is one flag, not per-conversation state. Leaving a
    // conversation mid-run used to carry it along, so the dot pulsed under the
    // last message of whichever conversation you opened next.
    const { result, rerender } = mount(conversation("c1", [message("m1")]));

    act(() => result.current.setShowAiTransition(true));
    expect(result.current.showAiTransition).toBe(true);

    rerender({ currentConversation: conversation("c2", [message("m9")]) });

    expect(result.current.showAiTransition).toBe(false);
  });

  it("keeps the transition dot across a re-render of the same conversation", () => {
    // The conversation object is replaced on every streamed token; only an id
    // change may clear the dot, or it would flicker for the whole run.
    const { result, rerender } = mount(conversation("c1", [message("m1")]));

    act(() => result.current.setShowAiTransition(true));
    rerender({ currentConversation: conversation("c1", [message("m1"), message("m2", "m1")]) });

    expect(result.current.showAiTransition).toBe(true);
  });

  it("clears the transition dot once thinking goes live", () => {
    // The dot only bridges persistence and the agent's first real signal; leaving
    // it up alongside the thinking block double-renders the pending state.
    const { result } = mount(conversation("c1"));

    act(() => result.current.setShowAiTransition(true));
    expect(result.current.showAiTransition).toBe(true);

    act(() => result.current.setThinkingState({ isActive: true } as never));

    expect(result.current.showAiTransition).toBe(false);
  });

  it("resolves the active branch through a linear thread", () => {
    const { result } = mount(
      conversation("c1", [message("m1"), message("m2", "m1"), message("m3", "m2")]),
    );

    expect(result.current.activeMessages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
