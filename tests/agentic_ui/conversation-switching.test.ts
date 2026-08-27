// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useActiveRunBranchSnap } from "@/features/chat/hooks/useActiveRunBranchSnap";
import type { ConversationDetail, InferenceRun } from "@/shared/lib/types";

/**
 * Conversation switching, at the one seam where it has actually broken.
 *
 * `useActiveRunBranchSnap` merges two effects that used to compete: "reset the
 * branch selection because the conversation changed" and "snap to the branch the
 * active run is writing into". When they were separate the reset won, so opening
 * a conversation with a run in flight showed the wrong branch. Its own docblock
 * records that history — these tests pin the ordering so the ChatPage split
 * cannot quietly reintroduce it.
 */

const conversation = (id: string) => ({ id, messages: [] }) as unknown as ConversationDetail;
const run = (id: string) => ({ id }) as unknown as InferenceRun;

type Props = {
  currentConversation: ConversationDetail | null;
  activeConversationRun: InferenceRun | null;
};

/** Mount the hook with spy setters, and expose `rerender` for the switch. */
const setup = (initialProps: Props, derived: Record<string, number> | null = { p1: 1 }) => {
  const setBranchSelections = vi.fn();
  const deriveBranchSelectionsForActiveRun = vi.fn(() => derived);

  const { rerender } = renderHook(
    (props: Props) =>
      useActiveRunBranchSnap({
        ...props,
        deriveBranchSelectionsForActiveRun,
        setBranchSelections,
      }),
    { initialProps },
  );

  return { setBranchSelections, deriveBranchSelectionsForActiveRun, rerender };
};

/**
 * The snap path calls the setter with an updater, the reset path with a plain
 * object. Resolving it here keeps each assertion about behaviour rather than
 * about which of the two calling conventions the hook happened to use.
 */
const resolveSelection = (arg: unknown, prev: Record<string, number> = {}) =>
  typeof arg === "function" ? (arg as (p: Record<string, number>) => unknown)(prev) : arg;

describe("useActiveRunBranchSnap", () => {
  it("clears the branch selection when the conversation changes", () => {
    const { setBranchSelections, rerender } = setup({
      currentConversation: conversation("a"),
      activeConversationRun: null,
    });

    expect(resolveSelection(setBranchSelections.mock.calls[0][0])).toEqual({});

    setBranchSelections.mockClear();
    rerender({ currentConversation: conversation("b"), activeConversationRun: null });

    expect(setBranchSelections).toHaveBeenCalledTimes(1);
    expect(resolveSelection(setBranchSelections.mock.calls[0][0])).toEqual({});
  });

  it("snaps to the active run's branch instead of resetting it", () => {
    // The regression: entering a conversation whose run is mid-stream must land
    // on the branch that run is writing into, not on an empty selection.
    const { setBranchSelections } = setup({
      currentConversation: conversation("a"),
      activeConversationRun: run("r1"),
    });

    expect(setBranchSelections).toHaveBeenCalledTimes(1);
    expect(resolveSelection(setBranchSelections.mock.calls[0][0])).toEqual({ p1: 1 });
  });

  it("snaps once per run so manual branch navigation is not overridden", () => {
    const { setBranchSelections, rerender } = setup({
      currentConversation: conversation("a"),
      activeConversationRun: run("r1"),
    });
    setBranchSelections.mockClear();

    // Same conversation, same run, another commit — the user may have moved to a
    // sibling branch in between, and re-snapping would yank them back.
    rerender({ currentConversation: conversation("a"), activeConversationRun: run("r1") });

    expect(setBranchSelections).not.toHaveBeenCalled();
  });

  it("re-snaps after leaving and re-entering a still-running conversation", () => {
    // The once-per-run latch is cleared by the conversation change, otherwise
    // coming back to a run still in flight would show the reset selection.
    const { setBranchSelections, rerender } = setup({
      currentConversation: conversation("a"),
      activeConversationRun: run("r1"),
    });

    rerender({ currentConversation: conversation("b"), activeConversationRun: null });
    setBranchSelections.mockClear();

    rerender({ currentConversation: conversation("a"), activeConversationRun: run("r1") });

    expect(setBranchSelections).toHaveBeenCalledTimes(1);
    expect(resolveSelection(setBranchSelections.mock.calls[0][0])).toEqual({ p1: 1 });
  });

  it("falls back to a reset when the run has no derivable branch", () => {
    // Session restore: the detail can arrive before the run's messages do, and
    // `derive` returns null until it can place the run on the tree.
    const { setBranchSelections } = setup(
      { currentConversation: conversation("a"), activeConversationRun: run("r1") },
      null,
    );

    expect(resolveSelection(setBranchSelections.mock.calls[0][0])).toEqual({});
  });
});
