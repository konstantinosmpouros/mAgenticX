// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { AgentMapDetail } from "@/features/chat/components/agent_map/AgentMapDetail";
import { taskAgentNodes, type AgentMapAnswer } from "@/features/chat/lib/agentMap";
import { buildTaskCardTree } from "@/features/chat/lib/taskTreeAdapter";
import { BackgroundTasksContext, type BackgroundTasksContextValue } from "@/features/inference";
import { applyTaskFrame, applyTaskSocketFrame, createTaskTree } from "@/features/inference/taskTree";
import { AsyncTaskSchema } from "@/shared/lib/schemas";
import type { AsyncTask, AsyncTaskTreeState } from "@/shared/lib/types";

// The agent map's detail view of a background task (plan 41) must read as the
// task drill-down does: the task's own events (the orchestrator's follow-up
// instructions included) and its approval, answerable from the map.

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

function waitingTree(): AsyncTaskTreeState {
  let tree = applyTaskFrame(createTaskTree(CONV), task("w", { status: "waiting" }), "TASK_STARTED", T0);
  tree = applyTaskSocketFrame(
    tree,
    "w",
    {
      type: "snapshot",
      task: null,
      events: [
        { type: "TEXT_MESSAGE_CONTENT", delta: "Drafting the essay." },
        { type: "CUSTOM", name: "TASK_INPUT", value: { text: "Make it shorter, please." } },
        { type: "TEXT_MESSAGE_CONTENT", delta: "Running the word count." },
        {
          type: "CUSTOM",
          name: "HITL_INTERRUPT",
          value: {
            thread_id: "w",
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
  return tree;
}

function contextValue(tree: AsyncTaskTreeState): BackgroundTasksContextValue {
  return {
    tree,
    openTaskId: null,
    openTask: vi.fn(),
    viewTask: vi.fn(),
    stopTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    isDecisionSent: () => false,
  };
}

function renderDetail(value: BackgroundTasksContextValue) {
  const roots = Object.values(value.tree.tasks);
  const [node] = taskAgentNodes("msg-ai-1", buildTaskCardTree(value.tree, roots, T0));
  const answer: AgentMapAnswer = {
    id: "msg-ai-1",
    number: 1,
    question: "Write an essay",
    live: false,
    subagentCount: 1,
    runningCount: 0,
    nodes: [node],
  };
  return render(
    <BackgroundTasksContext.Provider value={value}>
      <AgentMapDetail
        node={node}
        answer={answer}
        ancestors={[]}
        agentName="Assistant"
        onOpenNode={vi.fn()}
        now={T0}
      />
    </BackgroundTasksContext.Provider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the agent map's detail of a background task", () => {
  it("shows the orchestrator's follow-up instruction from the task's own events", () => {
    renderDetail(contextValue(waitingTree()));
    expect(screen.getByText("Make it shorter, please.")).toBeInTheDocument();
    expect(screen.getByText("Running the word count.")).toBeInTheDocument();
  });

  it("lets the user answer the task's approval from the map", async () => {
    const value = contextValue(waitingTree());
    renderDetail(value);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await act(async () => {});
    expect(value.resumeTask).toHaveBeenCalledWith(
      "w",
      expect.objectContaining({ interruptId: "int-1", threadId: "w", decision: "approve" }),
    );
  });

  it("streams the task while it is open and lets go when it closes", () => {
    const value = contextValue(waitingTree());
    const view = renderDetail(value);
    expect(value.viewTask).toHaveBeenLastCalledWith("w");
    view.unmount();
    expect(value.viewTask).toHaveBeenLastCalledWith(null);
    expect(value.openTask).not.toHaveBeenCalled();
  });
});
