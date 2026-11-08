// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

// The bridge does not exist yet for plan 41: every call the hook makes is a
// mock, and the sockets hand their frame callbacks to the test.
const api = vi.hoisted(() => ({
  listConversationTasks: vi.fn(),
  connectConversationChannel: vi.fn(),
  connectTaskSocket: vi.fn(),
  cancelAsyncTask: vi.fn(),
  resumeAsyncTask: vi.fn(),
  deleteQueuedMessage: vi.fn(),
}));
vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));

import { ComposerTaskNotices } from "@/features/chat/components/ComposerTaskNotices";
import { TaskNoticeRow } from "@/features/chat/components/message_parts/TaskNoticeRow";
import { TaskSidePanel } from "@/features/chat/components/message_parts/RunSidePanels";
import { TaskTreeCards } from "@/features/chat/components/message_parts/TaskTreeCards";
import { TimelineSequence } from "@/features/chat/components/message_parts/TimelineSequence";
import {
  BackgroundTasksContext,
  createInferenceHandlers,
  foldTimeline,
  useBackgroundTasks,
  type BackgroundTasksContextValue,
} from "@/features/inference";
import {
  applyTaskFrame,
  applyTaskSocketFrame,
  createTaskTree,
  requestTaskStop,
} from "@/features/inference/taskTree";
import { AsyncTaskSchema } from "@/shared/lib/schemas";
import type {
  AsyncTask,
  AsyncTaskTreeState,
  ConversationChannelFrame,
  ConversationDetail,
  MessageOut,
} from "@/shared/lib/types";

const CONV = "conv-1";
const T0 = Date.now();

function task(id: string, overrides: Record<string, unknown> = {}): AsyncTask {
  return AsyncTaskSchema.parse({
    task_id: id,
    conversation_id: CONV,
    spawned_by_message_id: "msg-ai-1",
    name: "researcher",
    description: "Find the sources",
    status: "running",
    started_at: T0,
    ...overrides,
  });
}

function treeOf(...tasks: AsyncTask[]): AsyncTaskTreeState {
  return tasks.reduce(
    (tree, item) => applyTaskFrame(tree, item, "TASK_STARTED", T0),
    createTaskTree(CONV),
  );
}

function contextValue(
  tree: AsyncTaskTreeState,
  overrides: Partial<BackgroundTasksContextValue> = {},
): BackgroundTasksContextValue {
  return {
    tree,
    openTaskId: null,
    openTask: vi.fn(),
    viewTask: vi.fn(),
    stopTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    isDecisionSent: () => false,
    ...overrides,
  };
}

function withTasks(value: BackgroundTasksContextValue, node: Parameters<typeof render>[0]) {
  return <BackgroundTasksContext.Provider value={value}>{node}</BackgroundTasksContext.Provider>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("task tree cards", () => {
  it("draws the subtree with a Stop on each active row; Stop does not open the card", () => {
    const tree = treeOf(
      task("root"),
      task("child", { parent_task_id: "root", name: "fact-checker", status: "waiting" }),
      task("done", { parent_task_id: "root", name: "summarizer", status: "success" }),
    );
    const value = contextValue(tree);
    render(withTasks(value, <TaskTreeCards roots={[tree.tasks.root]} tasks={value} />));

    const stopRoot = screen.getByRole("button", { name: "Stop researcher" });
    fireEvent.click(stopRoot);
    expect(value.stopTask).toHaveBeenCalledWith("root");
    expect(value.openTask).not.toHaveBeenCalled();

    // The waiting child is active too; the settled one has no Stop.
    expect(screen.getByRole("button", { name: "Stop fact-checker" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop summarizer" })).toBeNull();

    // A card opens the drill-down, at any depth.
    fireEvent.click(screen.getByRole("button", { name: /^Open Fact Checker/ }));
    expect(value.openTask).toHaveBeenCalledWith("child");
    expect(
      screen.getByRole("button", { name: /^Open Fact Checker, Awaiting approval/ }),
    ).toBeTruthy();
  });

  it("shows a disabled Stopping… while the cancel is in flight", () => {
    const tree = requestTaskStop(treeOf(task("root")), "root", T0);
    const value = contextValue(tree);
    render(withTasks(value, <TaskTreeCards roots={[tree.tasks.root]} tasks={value} />));
    const stopping = screen.getByRole("button", { name: "Stopping researcher" });
    expect(stopping).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Open Researcher, Stopping/ })).toBeTruthy();
  });
});

describe("a run's timeline with a launched task", () => {
  it("renders the 'Started task' reference live from the tree", () => {
    const timeline = foldTimeline([
      { type: "TEXT_MESSAGE_CONTENT", delta: "On it." },
      { type: "CUSTOM", name: "TASK_LAUNCHED", value: { task_id: "root", name: "researcher" } },
    ]);
    const tree = treeOf(task("root", { status: "waiting_children" }));
    render(
      withTasks(
        contextValue(tree),
        <TimelineSequence
          timeline={finalizeLike(timeline)}
          runId="msg-ai-1"
          isStreaming={false}
          expandedThinking={{}}
          onToggleThinking={() => {}}
        />,
      ),
    );
    expect(screen.getByText("Started task in the background")).toBeInTheDocument();
    // The run is over, the task is not: its card still reads its own status.
    expect(
      screen.getByRole("button", { name: /^Open Researcher, Sub-agents working/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop researcher" })).toBeInTheDocument();
  });

  it("shows the launch alone, with no guessed status, when the tree does not know the task", () => {
    const timeline = foldTimeline(
      [{ type: "CUSTOM", name: "TASK_LAUNCHED", value: { task_id: "x", name: "writer" } }],
      { status: "completed" },
    );
    render(
      <TimelineSequence
        timeline={timeline}
        runId="m"
        isStreaming={false}
        expandedThinking={{}}
        onToggleThinking={() => {}}
      />,
    );
    const card = screen.getByRole("button", { name: "Writer" });
    expect(card).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
});

// A settled run's timeline, as a reload reads it.
function finalizeLike(timeline: ReturnType<typeof foldTimeline>) {
  return { ...timeline, terminal: true, terminalStatus: "completed" as const };
}

describe("the drill-down", () => {
  it("opens on a nested task with its path, live events, approval card and Stop", async () => {
    let tree = treeOf(
      task("root"),
      task("leaf", {
        parent_task_id: "root",
        name: "fact-checker",
        status: "waiting",
        model: "gpt-5",
      }),
    );
    tree = applyTaskSocketFrame(
      tree,
      "leaf",
      {
        type: "snapshot",
        task: null,
        events: [
          { type: "TEXT_MESSAGE_CONTENT", delta: "Checking the claim." },
          {
            type: "CUSTOM",
            name: "HITL_INTERRUPT",
            value: {
              thread_id: "leaf",
              interrupt: {
                id: "int-1",
                value: { action_requests: [{ name: "execute", args: {} }] },
              },
            },
          },
        ],
      },
      T0,
    );
    const value = contextValue(tree, { openTaskId: "leaf" });
    render(withTasks(value, <TaskSidePanel />));

    const dialog = await screen.findByRole("dialog");
    // The path walks back up to the root; the root is a link.
    const path = within(dialog).getByRole("navigation", { name: "Task path" });
    fireEvent.click(within(path).getByRole("button", { name: "Researcher" }));
    expect(value.openTask).toHaveBeenCalledWith("root");

    expect(within(dialog).getByText("Checking the claim.")).toBeInTheDocument();
    expect(within(dialog).getByText("gpt-5")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }));
    await act(async () => {});
    expect(value.resumeTask).toHaveBeenCalledWith(
      "leaf",
      expect.objectContaining({ interruptId: "int-1", threadId: "leaf", decision: "approve" }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop fact-checker" }));
    expect(value.stopTask).toHaveBeenCalledWith("leaf");
  });

  it("is closed while no task is open", () => {
    render(withTasks(contextValue(treeOf(task("root"))), <TaskSidePanel />));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("notice row", () => {
  const notice: MessageOut = {
    id: "n1",
    sender: "user",
    content: "",
    created_at: new Date(T0),
    updated_at: new Date(T0),
    attachments: [],
    kind: "task_notification",
    taskNotice: { taskId: "root", name: "researcher", status: "success", durationMs: 134_000 },
  };

  it("is one compact line that opens the task's drill-down", () => {
    const value = contextValue(treeOf(task("root", { status: "success" })));
    render(withTasks(value, <TaskNoticeRow message={notice} />));
    const line = screen.getByRole("button", { name: /Researcher finished · 2m 14s/ });
    fireEvent.click(line);
    expect(value.openTask).toHaveBeenCalledWith("root");
  });

  it("is plain text when the task is not in the tree", () => {
    render(<TaskNoticeRow message={notice} />);
    expect(screen.getByText("Researcher finished · 2m 14s")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("composer notices", () => {
  it("shows the queued chip and cancels it with its ×", () => {
    const onCancel = vi.fn();
    render(
      <ComposerTaskNotices
        queuedMessage={{
          id: null,
          content: "and check the 2025 numbers",
          attachmentCount: 0,
          commandName: null,
          queuedAt: T0,
        }}
        onCancelQueued={onCancel}
      />,
    );
    const chip = screen.getByRole("status");
    expect(within(chip).getByText("Queued")).toBeInTheDocument();
    expect(within(chip).getByText("and check the 2025 numbers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the queued message" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("prompts for a waiting task's approval and opens its drill-down", () => {
    const value = contextValue(treeOf(task("w", { name: "fact-checker", status: "waiting" })));
    render(
      withTasks(value, <ComposerTaskNotices queuedMessage={null} onCancelQueued={() => {}} />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review fact-checker's approval" }));
    expect(value.openTask).toHaveBeenCalledWith("w");
  });
});

describe("useBackgroundTasks", () => {
  let channelFrame: (frame: ConversationChannelFrame) => void = () => {};

  beforeEach(() => {
    api.listConversationTasks.mockResolvedValue([task("root")]);
    api.connectConversationChannel.mockImplementation(
      (_user: string, _conv: string, onFrame: (frame: ConversationChannelFrame) => void) => {
        channelFrame = onFrame;
        return new Promise(() => {});
      },
    );
    api.connectTaskSocket.mockImplementation(() => new Promise(() => {}));
  });

  function mount(onRunStarted = vi.fn(), toast = vi.fn()) {
    const hook = renderHook(() =>
      useBackgroundTasks({ userId: "u-1", conversationId: CONV, onRunStarted, toast }),
    );
    return { ...hook, onRunStarted, toast };
  }

  it("hydrates on open, then follows the channel's frames", async () => {
    const { result } = mount();
    await act(async () => {});
    expect(api.listConversationTasks).toHaveBeenCalledWith("u-1", CONV, expect.anything());
    expect(result.current.tree.tasks.root.status).toBe("running");
    act(() =>
      channelFrame({
        type: "task",
        event: "TASK_SETTLED",
        task: task("root", { status: "success" }),
      }),
    );
    expect(result.current.tree.tasks.root.status).toBe("success");
  });

  it("hands a run it did not start to onRunStarted, and a queued send's run clears the chip", async () => {
    const { result, onRunStarted } = mount();
    await act(async () => {});
    act(() =>
      result.current.holdQueuedMessage({
        id: null,
        content: "next",
        attachmentCount: 0,
        commandName: null,
        queuedAt: T0,
      }),
    );
    expect(result.current.queuedMessage?.content).toBe("next");
    const run = { id: "r2", conversationId: CONV } as never;
    act(() => channelFrame({ type: "run_started", run, fromQueue: false }));
    expect(onRunStarted).toHaveBeenCalledWith(run, { fromQueue: false });
    // A wake-up run does not clear the chip…
    expect(result.current.queuedMessage).not.toBeNull();
    // …the queued message's own run does, and so does `queue: null`.
    act(() => channelFrame({ type: "run_started", run, fromQueue: true }));
    expect(result.current.queuedMessage).toBeNull();
    act(() =>
      channelFrame({
        type: "queue",
        queuedMessage: {
          id: "q",
          content: "x",
          attachmentCount: 0,
          commandName: null,
          queuedAt: T0,
        },
      }),
    );
    expect(result.current.queuedMessage?.id).toBe("q");
    act(() => channelFrame({ type: "queue", queuedMessage: null }));
    expect(result.current.queuedMessage).toBeNull();
  });

  it("stops optimistically, then reconciles from the cancel answer", async () => {
    let answer: (value: AsyncTask) => void = () => {};
    api.cancelAsyncTask.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = mount();
    await act(async () => {});
    let stopping: Promise<void> = Promise.resolve();
    act(() => {
      stopping = result.current.stopTask("root");
    });
    expect(result.current.tree.stopRequestedAt.root).toBeDefined();
    await act(async () => {
      answer(task("root", { status: "cancelled" }));
      await stopping;
    });
    expect(result.current.tree.tasks.root.status).toBe("cancelled");
  });

  it("rolls the stop back and says so when the cancel fails", async () => {
    api.cancelAsyncTask.mockRejectedValue(new Error("nope"));
    const { result, toast } = mount();
    await act(async () => {});
    await act(async () => {
      await result.current.stopTask("root");
    });
    expect(result.current.tree.stopRequestedAt.root).toBeUndefined();
    expect(toast).toHaveBeenCalled();
  });

  it("follows a waiting task's own socket, for its approval", async () => {
    api.listConversationTasks.mockResolvedValue([task("w", { status: "waiting" })]);
    mount();
    await act(async () => {});
    expect(api.connectTaskSocket).toHaveBeenCalledWith(
      "u-1",
      "w",
      expect.any(Function),
      expect.objectContaining({ since: expect.any(Function) }),
    );
  });

  it("cancels the queued message optimistically and restores the chip on failure", async () => {
    api.deleteQueuedMessage.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
    const { result } = mount();
    await act(async () => {});
    const held = { id: "q", content: "x", attachmentCount: 0, commandName: null, queuedAt: T0 };
    act(() => result.current.holdQueuedMessage(held));
    await act(async () => {
      await result.current.cancelQueuedMessage();
    });
    expect(result.current.queuedMessage).toEqual(held);

    api.deleteQueuedMessage.mockResolvedValue(undefined);
    let cancelled: unknown = null;
    await act(async () => {
      cancelled = await result.current.cancelQueuedMessage();
    });
    expect(cancelled).toEqual(held);
    expect(result.current.queuedMessage).toBeNull();
  });
});

describe("the send flow while a run streams", () => {
  it("queues the message instead of starting a run, with no optimistic bubble", async () => {
    const setMessages = vi.fn();
    const onMessageQueued = vi.fn();
    const queueInferenceSend = vi.fn(async () => ({
      queued: true as const,
      queuedMessage: null,
    }));
    const beginInferenceRun = vi.fn();
    const setShowAiTransition = vi.fn();
    const conversation = {
      id: CONV,
      agent: { id: "agent-1" },
      messages: [{ id: "u1", sender: "user", parentMessageId: null }],
    } as unknown as ConversationDetail;
    const { handleSendMessage } = createInferenceHandlers({
      userId: "u-1",
      selectedAgent: "agent-1",
      isPrivateMode: false,
      messages: conversation.messages as MessageOut[],
      attachments: [],
      agents: [],
      currentConversation: conversation,
      currentMessage: "and check the 2025 numbers",
      pendingCommand: null,
      isSendingMessage: false,
      setMessages,
      setCurrentMessage: vi.fn(),
      setPendingCommand: vi.fn(),
      setAttachments: vi.fn(),
      setIsSendingMessage: vi.fn(),
      setCurrentConversation: vi.fn(),
      setConversations: vi.fn(),
      toast: vi.fn(),
      setThinkingState: vi.fn(),
      setShowAiTransition,
      streamAbortRef: { current: null },
      beginInferenceRun,
      isConversationStreaming: true,
      queueInferenceSend,
      onMessageQueued,
    });
    await handleSendMessage();
    expect(queueInferenceSend).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "send", conversationId: CONV, parentMessageId: "u1" }),
    );
    expect(beginInferenceRun).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setShowAiTransition).not.toHaveBeenCalledWith(true);
    expect(onMessageQueued).toHaveBeenCalledWith(
      expect.objectContaining({ content: "and check the 2025 numbers" }),
    );
  });
});
