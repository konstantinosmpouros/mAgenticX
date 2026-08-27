// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConversationRouting } from "@/features/chat/hooks/useConversationRouting";
import type { ConversationDetail, SharedConversationDetail } from "@/shared/lib/types";

/**
 * The URL-driven conversation loader — the highest-risk seam in the workspace,
 * and the one with the most scar tissue.
 *
 * Two guards here each encode a bug that shipped, and neither is visible in a
 * diff. The generation counter is what makes the *newest* navigation win: an
 * `if (loading) return` guard was tried instead and reverted, because it blocks
 * switching while a load or animation is in flight. And the promotion effect
 * fires only on a `null -> id` transition, because clicking "New chat" on
 * `/c/:id` navigates to "/" while `currentConversation` still holds the old id
 * for one render — without the check, it bounces straight back.
 */

const { getConversationDetail } = vi.hoisted(() => ({ getConversationDetail: vi.fn() }));

vi.mock("@/shared/lib/api", () => ({ getConversationDetail }));

const detail = (id: string) =>
  ({
    id,
    agent: { id: `agent-${id}` },
    isPrivate: false,
    messages: [],
  }) as unknown as ConversationDetail;

/** A promise plus its resolver, so a test controls when a fetch lands. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

type Props = {
  conversationId: string | undefined;
  currentConversation: ConversationDetail | null;
  isTasksRoute?: boolean;
  sharedConversationToken?: string;
  initialSharedConversation?: SharedConversationDetail | null;
};

const setup = (initialProps: Props) => {
  const spies = {
    navigate: vi.fn(),
    setCurrentConversation: vi.fn(),
    setSelectedAgent: vi.fn(),
    setIsPrivateMode: vi.fn(),
    setInactiveAgentFallback: vi.fn(),
    setLoadingConversation: vi.fn(),
    setThinkingState: vi.fn(),
    setExpandedThinking: vi.fn(),
    setAttachments: vi.fn(),
    setCurrentMessage: vi.fn(),
    setBranchSelections: vi.fn(),
    closeVoiceSession: vi.fn(),
    deriveBranchSelectionsForActiveRun: vi.fn(() => null),
    requestPersist: vi.fn(),
    toast: vi.fn(),
  };

  const { rerender } = renderHook(
    (p: Props) =>
      useConversationRouting({
        ...spies,
        navigate: spies.navigate as never,
        conversationId: p.conversationId,
        isTasksRoute: p.isTasksRoute ?? false,
        authResolved: true,
        isLoggedIn: true,
        userId: "u1",
        sharedConversationToken: p.sharedConversationToken,
        initialSharedConversation: p.initialSharedConversation,
        currentConversation: p.currentConversation,
        agents: [],
        selectedAgent: "",
      }),
    { initialProps },
  );

  return { ...spies, rerender };
};

describe("useConversationRouting", () => {
  beforeEach(() => {
    getConversationDetail.mockReset();
    // A bare `mockReset` leaves the fetch returning undefined, and the effect
    // calls `.then` on it — which throws inside React and poisons every later
    // test in the file. Always hand it something thenable.
    getConversationDetail.mockResolvedValue(detail("default"));
  });

  it("loads the conversation named by the route", async () => {
    getConversationDetail.mockResolvedValue(detail("c1"));
    const s = setup({ conversationId: "c1", currentConversation: null });

    await act(async () => {});

    expect(getConversationDetail).toHaveBeenCalledWith("u1", "c1");
    expect(s.setCurrentConversation).toHaveBeenCalledWith(detail("c1"));
    expect(s.setSelectedAgent).toHaveBeenCalledWith("agent-c1");
  });

  it("drops a superseded load so the newest navigation wins", async () => {
    // The freeze bug: with a `loading` guard the second navigation is refused
    // outright; with the generation counter it starts immediately and the older
    // fetch discards itself when it finally lands.
    const first = deferred<ConversationDetail>();
    const second = deferred<ConversationDetail>();
    getConversationDetail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const s = setup({ conversationId: "c1", currentConversation: null });
    s.rerender({ conversationId: "c2", currentConversation: null });

    // The stale one lands LAST — the order that breaks a naive implementation.
    await act(async () => {
      second.resolve(detail("c2"));
      first.resolve(detail("c1"));
    });

    expect(s.setCurrentConversation).toHaveBeenCalledTimes(1);
    expect(s.setCurrentConversation).toHaveBeenCalledWith(detail("c2"));
  });

  it("erases conversation-scoped state on the empty route", async () => {
    const s = setup({ conversationId: undefined, currentConversation: null });

    await act(async () => {});

    expect(getConversationDetail).not.toHaveBeenCalled();
    expect(s.setCurrentConversation).toHaveBeenCalledWith(null);
    expect(s.setCurrentMessage).toHaveBeenCalledWith("");
    expect(s.setAttachments).toHaveBeenCalledWith([]);
    expect(s.setThinkingState).toHaveBeenCalledWith(null);
    expect(s.setLoadingConversation).toHaveBeenCalledWith(false);
  });

  it("does not refetch the conversation already on screen", async () => {
    // Just created or forked: the detail is already in the store, and refetching
    // would flash the loading overlay over content that is already correct.
    const s = setup({ conversationId: "c1", currentConversation: detail("c1") });

    await act(async () => {});

    expect(getConversationDetail).not.toHaveBeenCalled();
    expect(s.setLoadingConversation).not.toHaveBeenCalled();
  });

  it("closes voice on every navigation", async () => {
    const s = setup({ conversationId: undefined, currentConversation: null });
    s.closeVoiceSession.mockClear();

    s.rerender({ conversationId: "c1", currentConversation: null });

    expect(s.closeVoiceSession).toHaveBeenCalled();
  });

  it("promotes a newly created conversation into the URL", async () => {
    // First send from "/": the conversation appears in the store with no
    // :conversationId in the URL, so the route has to catch up.
    const s = setup({ conversationId: undefined, currentConversation: null });

    s.rerender({ conversationId: undefined, currentConversation: detail("new-1") });

    expect(s.navigate).toHaveBeenCalledWith("/c/new-1", { replace: true });
  });

  it("does not bounce back to the old conversation on New chat", async () => {
    // Mounting straight onto /c/c1 means the previous id was never null, so the
    // stale value that "New chat" leaves behind for one render must not promote.
    const s = setup({ conversationId: "c1", currentConversation: detail("c1") });
    s.navigate.mockClear();

    // "New chat": the URL clears first, the store still holds c1 this render.
    s.rerender({ conversationId: undefined, currentConversation: detail("c1") });

    expect(s.navigate).not.toHaveBeenCalled();
  });

  it("never promotes a shared conversation into a /c/ URL", async () => {
    const s = setup({ conversationId: undefined, currentConversation: null });

    s.rerender({
      conversationId: undefined,
      currentConversation: detail("shared:tok-1"),
    });

    expect(s.navigate).not.toHaveBeenCalled();
  });

  it("hydrates a shared conversation once, without fetching", async () => {
    const shared = {
      agent: { id: "agent-s" },
      title: "Shared",
      createdAt: new Date(),
      messages: [],
    } as unknown as SharedConversationDetail;

    const s = setup({
      conversationId: undefined,
      currentConversation: null,
      sharedConversationToken: "tok-1",
      initialSharedConversation: shared,
    });

    await act(async () => {});
    const afterFirst = s.setCurrentConversation.mock.calls.length;

    s.rerender({
      conversationId: undefined,
      currentConversation: null,
      sharedConversationToken: "tok-1",
      initialSharedConversation: shared,
    });

    expect(getConversationDetail).not.toHaveBeenCalled();
    expect(s.setCurrentConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shared:tok-1", title: "Shared" }),
    );
    expect(s.setCurrentConversation.mock.calls.length).toBe(afterFirst);
  });
});
