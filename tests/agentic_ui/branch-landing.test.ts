// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetBranchEntryForTests,
  useActiveRunBranchSnap,
} from "@/features/chat/hooks/useActiveRunBranchSnap";
import {
  branchSelectionsForMessage,
  loadBranchSelections,
  reconcileBranchSelections,
  saveBranchSelections,
} from "@/features/chat/lib/branchMemory";
import type { ConversationDetail, InferenceRun, MessageOut } from "@/shared/lib/types";

/**
 * Which branch a conversation opens on (and keeps across a reload):
 *   reload -> the branch read before it; else an active run's branch; else the
 *   branch of the answer whose background tasks still work; else the branch
 *   last read in this tab; else the default.
 *
 * Tree used throughout: u1 -> a1 -> { u2 -> a2 , u2b -> a2b }  (a fork under a1).
 */
const msg = (id: string, parentMessageId: string | null) =>
  ({ id, parentMessageId }) as unknown as MessageOut;
const MESSAGES = [
  msg("u1", null),
  msg("a1", "u1"),
  msg("u2", "a1"),
  msg("a2", "u2"),
  msg("u2b", "a1"),
  msg("a2b", "u2b"),
];

const conv = (id: string, over: Partial<ConversationDetail> = {}) =>
  ({ id, messages: MESSAGES, ...over }) as unknown as ConversationDetail;
const run = (id: string) => ({ id }) as unknown as InferenceRun;

type Props = {
  currentConversation: ConversationDetail | null;
  activeConversationRun: InferenceRun | null;
};

function mount(initialProps: Props, runBranch: Record<string, number> | null = { a1: 0 }) {
  const derive = vi.fn(() => runBranch);
  return renderHook(
    (props: Props) => {
      const [branchSelections, setBranchSelections] = useState<Record<string, number>>({});
      useActiveRunBranchSnap({
        ...props,
        deriveBranchSelectionsForActiveRun: derive,
        branchSelections,
        setBranchSelections,
      });
      return { branchSelections, setBranchSelections };
    },
    { initialProps },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetBranchEntryForTests(false);
});
afterEach(() => resetBranchEntryForTests(false));

describe("branchMemory", () => {
  it("places a message on the visible branch by its sibling index at every fork", () => {
    expect(branchSelectionsForMessage(MESSAGES, "a2b")).toEqual({ __root__: 0, u1: 0, a1: 1, u2b: 0 });
    expect(branchSelectionsForMessage(MESSAGES, "a2")).toEqual({ __root__: 0, u1: 0, a1: 0, u2: 0 });
  });

  it("answers null for a message it cannot place", () => {
    expect(branchSelectionsForMessage(MESSAGES, "nope")).toBeNull();
    expect(branchSelectionsForMessage([msg("x", "missing-parent")], "x")).toBeNull();
    expect(branchSelectionsForMessage(MESSAGES, null)).toBeNull();
  });

  it("drops stored forks that no longer exist or are out of range", () => {
    expect(reconcileBranchSelections(MESSAGES, { a1: 1, gone: 0, u2: 5, __root__: 0 })).toEqual({
      a1: 1,
      __root__: 0,
    });
  });

  it("round-trips through sessionStorage and survives a broken store", () => {
    saveBranchSelections("c", { a1: 1 });
    expect(loadBranchSelections("c")).toEqual({ a1: 1 });
    window.sessionStorage.setItem("mx.branch.bad", "not json");
    expect(loadBranchSelections("bad")).toBeNull();
    const spy = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadBranchSelections("c")).toBeNull();
    spy.mockRestore();
  });
});

describe("branch landing", () => {
  it("lands on the branch of the answer whose tasks still work", () => {
    const { result } = mount({
      currentConversation: conv("c", { hasActiveTasks: true, activeTaskMessageId: "a2b" }),
      activeConversationRun: null,
    });
    expect(result.current.branchSelections).toEqual({ __root__: 0, u1: 0, a1: 1, u2b: 0 });
  });

  it("prefers an active run's branch over the tasks' one", () => {
    const { result } = mount(
      {
        currentConversation: conv("c", { hasActiveTasks: true, activeTaskMessageId: "a2b" }),
        activeConversationRun: run("r1"),
      },
      { a1: 0 },
    );
    expect(result.current.branchSelections).toEqual({ a1: 0 });
  });

  it("ignores the tasks' answer once they have settled", () => {
    saveBranchSelections("c", { a1: 0 });
    const { result } = mount({
      currentConversation: conv("c", { hasActiveTasks: false, activeTaskMessageId: "a2b" }),
      activeConversationRun: null,
    });
    expect(result.current.branchSelections).toEqual({ a1: 0 });
  });

  it("on a reload, lands on the branch read before it even with a run active", () => {
    saveBranchSelections("c", { a1: 1 });
    resetBranchEntryForTests(true);
    const { result, rerender } = mount(
      {
        currentConversation: conv("c", { hasActiveTasks: true, activeTaskMessageId: "a2" }),
        activeConversationRun: null,
      },
      { a1: 0 },
    );
    expect(result.current.branchSelections).toEqual({ a1: 1 });
    // The run hydrates after the detail: it must not move the restored branch.
    rerender({ currentConversation: conv("c"), activeConversationRun: run("r1") });
    expect(result.current.branchSelections).toEqual({ a1: 1 });
  });

  it("restores only for the first conversation after the reload", () => {
    saveBranchSelections("c", { a1: 1 });
    resetBranchEntryForTests(true);
    const { result, rerender } = mount({ currentConversation: conv("c"), activeConversationRun: null });
    rerender({ currentConversation: conv("d"), activeConversationRun: null });
    rerender({ currentConversation: conv("c"), activeConversationRun: run("r1") });
    expect(result.current.branchSelections).toEqual({ a1: 0 }); // the run's branch now wins
  });

  it("waits for the messages before choosing, then remembers manual moves", () => {
    const { result, rerender } = mount({
      currentConversation: conv("c", { messages: [], hasActiveTasks: true, activeTaskMessageId: "a2b" }),
      activeConversationRun: null,
    });
    expect(result.current.branchSelections).toEqual({});
    rerender({
      currentConversation: conv("c", { hasActiveTasks: true, activeTaskMessageId: "a2b" }),
      activeConversationRun: null,
    });
    expect(result.current.branchSelections).toEqual({ __root__: 0, u1: 0, a1: 1, u2b: 0 });

    act(() => result.current.setBranchSelections({ a1: 0 }));
    expect(loadBranchSelections("c")).toEqual({ a1: 0 });
  });

  it("never stores one conversation's branch under another's id", () => {
    const { result, rerender } = mount({ currentConversation: conv("c"), activeConversationRun: null });
    act(() => result.current.setBranchSelections({ a1: 1 }));
    expect(loadBranchSelections("c")).toEqual({ a1: 1 });
    rerender({ currentConversation: conv("d"), activeConversationRun: null });
    expect(loadBranchSelections("d")).not.toEqual({ a1: 1 });
  });
});
