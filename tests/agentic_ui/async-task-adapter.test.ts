import { describe, expect, it } from "vitest";

import { buildAgentMap, taskAgentNodes } from "@/features/chat/lib/agentMap";

import {
  buildTaskCardTree,
  canStopTask,
  formatTaskDuration,
  taskElapsedLabel,
  taskNoticeText,
  taskSubagentStatus,
  taskToSubagentBlock,
  taskUsageLabel,
} from "@/features/chat/lib/taskTreeAdapter";
import {
  applyTaskFrame,
  applyTaskSocketFrame,
  createTaskTree,
  requestTaskStop,
  rootTasksForMessage,
} from "@/features/inference/taskTree";
import { subagentRunStatus } from "@/features/inference/timeline";
import { AsyncTaskSchema } from "@/shared/lib/schemas";
import type { AsyncTask } from "@/shared/lib/types";

/**
 * The adapter that feeds the established sub-agent cards from the task tree
 * (plan 41): no new chrome, so everything a task has — status, depth, model,
 * usage, elapsed time — must arrive in the card's own shapes.
 */

const T0 = Date.parse("2026-11-06T10:00:00Z");

function task(id: string, overrides: Record<string, unknown> = {}): AsyncTask {
  return AsyncTaskSchema.parse({
    task_id: id,
    conversation_id: "c",
    spawned_by_message_id: "m",
    name: "researcher",
    description: "Find the sources",
    model: "gpt-5",
    status: "running",
    usage: { input_tokens: 1234, output_tokens: 56 },
    started_at: T0,
    ...overrides,
  });
}

describe("status vocabulary", () => {
  it("maps every task status onto a card status", () => {
    expect(taskSubagentStatus("pending")).toBe("pending");
    expect(taskSubagentStatus("running")).toBe("running");
    expect(taskSubagentStatus("waiting_children")).toBe("waiting_children");
    expect(taskSubagentStatus("waiting")).toBe("awaiting_approval");
    expect(taskSubagentStatus("stopping")).toBe("stopping");
    expect(taskSubagentStatus("success")).toBe("done");
    expect(taskSubagentStatus("error")).toBe("failed");
    expect(taskSubagentStatus("cancelled")).toBe("cancelled");
  });

  it("offers Stop on every active status, not once settled or already stopping", () => {
    for (const status of ["pending", "running", "waiting_children", "waiting"] as const) {
      expect(canStopTask(status)).toBe(true);
    }
    for (const status of ["success", "error", "cancelled", "stopping"] as const) {
      expect(canStopTask(status)).toBe(false);
    }
    expect(canStopTask(null)).toBe(false);
  });
});

describe("labels", () => {
  it("words durations compactly", () => {
    expect(formatTaskDuration(400)).toBe("<1s");
    expect(formatTaskDuration(42_000)).toBe("42s");
    expect(formatTaskDuration(134_000)).toBe("2m 14s");
    expect(formatTaskDuration(3_900_000)).toBe("1h 05m");
  });

  it("counts elapsed time live while working, and to the settle once settled", () => {
    expect(taskElapsedLabel(task("t"), T0 + 5_000)).toBe("5s");
    const settled = task("t", { status: "success", settled_at: T0 + 134_000 });
    expect(taskElapsedLabel(settled, T0 + 999_999)).toBe("2m 14s");
    expect(taskElapsedLabel(task("t", { started_at: null }), T0)).toBeNull();
  });

  it("words usage, and says nothing before any", () => {
    expect(taskUsageLabel({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(taskUsageLabel({ inputTokens: 1234, outputTokens: 56 })).toMatch(/in · 56 out$/);
  });

  it("writes the notice row's line", () => {
    expect(
      taskNoticeText({ taskId: "t", name: "researcher", status: "success", durationMs: 134_000 }),
    ).toBe("Researcher finished · 2m 14s");
    expect(taskNoticeText({ taskId: "t", name: "writer", status: "error", durationMs: null })).toBe(
      "Writer failed",
    );
    expect(
      taskNoticeText({ taskId: "t", name: "writer", status: "cancelled", durationMs: 1000 }),
    ).toBe("Writer was stopped · 1s");
  });
});

describe("taskToSubagentBlock", () => {
  it("builds an async card the run status can never end", () => {
    const block = taskToSubagentBlock(task("t1"), "running");
    expect(block).toMatchObject({
      kind: "subagent",
      id: "task:t1",
      taskId: "t1",
      asyncTask: true,
      spawned: true,
      status: "running",
      label: "Researcher",
    });
    expect(subagentRunStatus(block, { terminal: true, interrupts: [] }, false)).toBe("running");
  });

  it("shows the result preview as the response when no live events are at hand", () => {
    const block = taskToSubagentBlock(
      task("t1", { status: "success", result_preview: "Three sources found." }),
      "success",
    );
    expect(block.blocks).toEqual([
      expect.objectContaining({ kind: "content", text: "Three sources found." }),
    ]);
  });

  it("prefers the node's own streamed text over the preview", () => {
    let tree = applyTaskFrame(createTaskTree("c"), task("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      { type: "event", seq: "1", event: { type: "TEXT_MESSAGE_CONTENT", delta: "live text" } },
      T0,
    );
    const block = taskToSubagentBlock(
      { ...tree.tasks.t1, resultPreview: "old preview" },
      "running",
      tree.nodes.t1,
    );
    expect(block.blocks.map((nested) => (nested.kind === "content" ? nested.text : ""))).toEqual([
      "live text",
    ]);
  });
});

describe("buildTaskCardTree", () => {
  it("nests three levels deep and gives each card its own status (stopping included)", () => {
    let tree = createTaskTree("c");
    tree = applyTaskFrame(tree, task("root"), "TASK_STARTED", T0);
    tree = applyTaskFrame(
      tree,
      task("mid", { parent_task_id: "root", name: "helper", status: "waiting_children" }),
      "TASK_STARTED",
      T0,
    );
    tree = applyTaskFrame(
      tree,
      task("leaf", { parent_task_id: "mid", name: "sub-helper", status: "waiting" }),
      "TASK_STARTED",
      T0,
    );
    tree = requestTaskStop(tree, "mid", T0);
    const cards = buildTaskCardTree(tree, [tree.tasks.root], T0 + 3_000);
    const [root] = cards.roots;
    const [mid] = cards.childrenOf(root);
    const [leaf] = cards.childrenOf(mid);
    expect([root.taskId, mid.taskId, leaf.taskId]).toEqual(["root", "mid", "leaf"]);
    expect(cards.statusOf(root)).toBe("running");
    expect(cards.statusOf(mid)).toBe("stopping");
    expect(cards.statusOf(leaf)).toBe("awaiting_approval");
    expect(cards.childrenOf(leaf)).toEqual([]);
    expect(cards.taskOf(mid)).toMatchObject({ status: "stopping", task: { taskId: "mid" } });
  });

  it("puts the task's model, usage and elapsed time on the card", () => {
    const tree = applyTaskFrame(createTaskTree("c"), task("root"), "TASK_STARTED", T0);
    const cards = buildTaskCardTree(tree, [tree.tasks.root], T0 + 42_000);
    const item = cards.itemOf(cards.roots[0]);
    expect(item.model).toBe("gpt-5");
    expect(item.elapsedLabel).toBe("42s");
    expect(item.usageLabel).toMatch(/56 out$/);
  });
});

describe("agent map with background tasks", () => {
  it("counts an answer's async sub-agents at every depth, even with no timeline", () => {
    let tree = createTaskTree("c");
    tree = applyTaskFrame(tree, task("root"), "TASK_STARTED", T0);
    tree = applyTaskFrame(
      tree,
      task("child", { parent_task_id: "root", name: "helper", status: "success", settled_at: T0 + 5_000 }),
      "TASK_STARTED",
      T0,
    );
    const map = buildAgentMap(
      [{ messageId: "m", number: 1, question: "Do it", timeline: null, live: false }],
      (messageId) =>
        taskAgentNodes(messageId, buildTaskCardTree(tree, rootTasksForMessage(tree, messageId), T0)),
    );
    expect(map.subagentCount).toBe(2);
    expect(map.runningCount).toBe(1);
    const [answer] = map.answers;
    expect(answer.nodes[0].title).toBe("Researcher");
    expect(answer.nodes[0].children[0]).toMatchObject({ depth: 2, durationMs: 5_000, status: "done" });
  });

  it("leaves an answer without tasks or sub-agents out", () => {
    const map = buildAgentMap(
      [{ messageId: "m", number: 1, question: "Hi", timeline: null, live: false }],
      () => [],
    );
    expect(map.subagentCount).toBe(0);
  });
});
