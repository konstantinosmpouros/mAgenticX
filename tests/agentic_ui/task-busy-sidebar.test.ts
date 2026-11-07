// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listTaskBusyConversations = vi.fn<(userId: string, signal?: AbortSignal) => Promise<string[]>>();
vi.mock("@/shared/lib/api", () => ({
  listTaskBusyConversations: (userId: string, signal?: AbortSignal) =>
    listTaskBusyConversations(userId, signal),
}));

import { TASK_BUSY_POLL_MS, useTaskBusySidebar } from "@/features/chat/hooks/useTaskBusySidebar";
import { createTaskTree } from "@/features/inference/taskTree";
import type {
  AsyncTask,
  AsyncTaskTreeState,
  ConversationDetail,
  ConversationSummary,
} from "@/shared/lib/types";

/**
 * The sidebar spins for a conversation while its background tasks work, not
 * only while its answer streams: the open one from its live task tree, the
 * others from a poll that runs only while one of them spins for tasks.
 */
const row = (id: string, hasActiveTasks = false) =>
  ({ id, hasActiveTasks }) as unknown as ConversationSummary;
const treeWith = (conversationId: string, statuses: string[]): AsyncTaskTreeState => {
  const tree = createTaskTree(conversationId);
  statuses.forEach((status, i) => {
    tree.tasks[`t${i}`] = { taskId: `t${i}`, status } as unknown as AsyncTask;
  });
  return tree;
};

type Props = { rows: ConversationSummary[]; current: string | null; tree: AsyncTaskTreeState };

function mount(initialProps: Props) {
  return renderHook(
    (props: Props) => {
      const [conversations, setConversations] = useState(props.rows);
      const [detail, setCurrentConversation] = useState<ConversationDetail | null>(
        props.current ? ({ id: props.current, hasActiveTasks: false } as unknown as ConversationDetail) : null,
      );
      useTaskBusySidebar({
        userId: "u1",
        conversations,
        setConversations,
        currentConversationId: props.current,
        setCurrentConversation,
        taskTree: props.tree,
      });
      return { conversations, detail };
    },
    { initialProps },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  listTaskBusyConversations.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useTaskBusySidebar", () => {
  it("marks the open conversation busy while its tree has a working task", () => {
    const { result, rerender } = mount({
      rows: [row("a")],
      current: "a",
      tree: treeWith("a", ["running", "success"]),
    });
    expect(result.current.conversations[0].hasActiveTasks).toBe(true);
    expect(result.current.detail?.hasActiveTasks).toBe(true);

    rerender({ rows: [row("a")], current: "a", tree: treeWith("a", ["success", "cancelled"]) });
    expect(result.current.conversations[0].hasActiveTasks).toBe(false);
  });

  it("leaves the flag alone while the tree is not loaded (empty)", () => {
    const { result } = mount({ rows: [row("a", true)], current: "a", tree: createTaskTree("a") });
    expect(result.current.conversations[0].hasActiveTasks).toBe(true);
  });

  it("polls only while another conversation spins for tasks, and stops when they settle", async () => {
    listTaskBusyConversations.mockResolvedValue([]);
    const { result } = mount({ rows: [row("a"), row("b", true)], current: "a", tree: createTaskTree("a") });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_BUSY_POLL_MS);
    });
    expect(listTaskBusyConversations).toHaveBeenCalledTimes(1);
    expect(result.current.conversations.find((r) => r.id === "b")?.hasActiveTasks).toBe(false);

    // Nothing spins any more: no further polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_BUSY_POLL_MS * 3);
    });
    expect(listTaskBusyConversations).toHaveBeenCalledTimes(1);
  });

  it("never polls when nothing works in the background", async () => {
    mount({ rows: [row("a"), row("b")], current: "a", tree: createTaskTree("a") });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_BUSY_POLL_MS * 3);
    });
    expect(listTaskBusyConversations).not.toHaveBeenCalled();
  });

  it("does not let the poll overwrite the open conversation's live flag", async () => {
    listTaskBusyConversations.mockResolvedValue(["b"]);
    const { result } = mount({
      rows: [row("a"), row("b", true)],
      current: "a",
      tree: treeWith("a", ["running"]),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_BUSY_POLL_MS);
    });
    expect(result.current.conversations.find((r) => r.id === "a")?.hasActiveTasks).toBe(true);
    expect(result.current.conversations.find((r) => r.id === "b")?.hasActiveTasks).toBe(true);
  });
});
