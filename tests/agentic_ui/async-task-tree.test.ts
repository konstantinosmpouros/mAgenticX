import { describe, expect, it } from "vitest";

import {
  STOP_GRACE_MS,
  applyTaskFrame,
  applyTaskSocketFrame,
  createTaskTree,
  failTaskStop,
  hydrateTaskTree,
  requestTaskStop,
  rootTasksForMessage,
  taskAncestry,
  taskChildrenIndex,
  taskDisplayStatus,
  waitingTasks,
} from "@/features/inference/taskTree";
import {
  AsyncTaskListSchema,
  AsyncTaskSchema,
  InferenceStartOrQueueSchema,
  toConversationChannelFrame,
  toTaskSocketFrame,
} from "@/shared/lib/schemas";
import { transformMessage } from "@/shared/lib/consts";
import type { AsyncTask, AsyncTaskStatus, TaskSocketFrame } from "@/shared/lib/types";

/**
 * The conversation-level task tree (plan 41 §3.9): frames from the
 * conversation channel, the hydration read, the Stop button's optimistic state
 * and one task's own socket all fold into it, in whatever order they land.
 */

const CONV = "conv-1";
const T0 = Date.parse("2026-11-06T10:00:00Z");

/** A wire `TaskOut` (snake_case, as §14.1 writes it), parsed like the bridge's. */
function wireTask(id: string, overrides: Record<string, unknown> = {}): AsyncTask {
  return AsyncTaskSchema.parse({
    task_id: id,
    conversation_id: CONV,
    user_id: "u-1",
    parent_task_id: null,
    root_run_id: "msg-ai-1",
    branch_thread_id: "thread-1",
    spawned_by_message_id: "msg-ai-1",
    depth: 1,
    name: "researcher",
    subagent_path: "researcher",
    description: "Find the sources",
    model: "gpt-5",
    status: "running",
    result_preview: null,
    error: null,
    usage: { input_tokens: 100, output_tokens: 20 },
    started_at: new Date(T0).toISOString(),
    settled_at: null,
    ...overrides,
  });
}

function withStatus(task: AsyncTask, status: AsyncTaskStatus, settledAt: number | null = null) {
  return { ...task, status, settledAt };
}

describe("TaskOut wire contract", () => {
  it("reads snake_case and camelCase alike", () => {
    const snake = wireTask("t1");
    const camel = AsyncTaskSchema.parse({
      taskId: "t1",
      conversationId: CONV,
      parentTaskId: null,
      rootRunId: "msg-ai-1",
      branchThreadId: "thread-1",
      spawnedByMessageId: "msg-ai-1",
      depth: 1,
      name: "researcher",
      subagentPath: "researcher",
      description: "Find the sources",
      model: "gpt-5",
      status: "running",
      usage: { inputTokens: 100, outputTokens: 20 },
      startedAt: new Date(T0).toISOString(),
    });
    expect(camel).toEqual(snake);
    expect(snake.startedAt).toBe(T0);
    expect(snake.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("reads an unknown status as working, never as settled", () => {
    expect(wireTask("t1", { status: "exploded" }).status).toBe("running");
  });

  it("caps the result preview at 2000 characters", () => {
    expect(wireTask("t1", { result_preview: "x".repeat(5000) }).resultPreview).toHaveLength(2000);
  });

  it("drops list rows without an id and degrades a non-list to empty", () => {
    expect(AsyncTaskListSchema.parse([{ name: "no id" }, { task_id: "t1" }])).toHaveLength(1);
    expect(AsyncTaskListSchema.parse({ items: [] })).toEqual([]);
  });

  it("tells a queued send from a started one", () => {
    const queued = InferenceStartOrQueueSchema.parse({
      queued: true,
      queued_message: { content: "and also check X", attachments: [{}, {}] },
    });
    expect(queued).toMatchObject({
      queued: true,
      queuedMessage: { content: "and also check X", attachmentCount: 2 },
    });
    expect(InferenceStartOrQueueSchema.parse({ run: { id: "r" } })).toMatchObject({
      queued: false,
    });
  });

  it("parses the conversation channel's three frames and ignores the rest", () => {
    expect(
      toConversationChannelFrame({ type: "task", event: "TASK_SETTLED", task: { task_id: "t1" } }),
    ).toMatchObject({ type: "task", event: "TASK_SETTLED", task: { taskId: "t1" } });
    expect(
      toConversationChannelFrame({ type: "run_started", run: { id: "r2" }, from_queue: true }),
    ).toMatchObject({ type: "run_started", fromQueue: true });
    expect(toConversationChannelFrame({ type: "queue", queued_message: null })).toEqual({
      type: "queue",
      queuedMessage: null,
    });
    expect(toConversationChannelFrame({ type: "run_started", run: {} })).toBeNull();
    expect(toConversationChannelFrame({ type: "task", task: {} })).toBeNull();
    expect(toConversationChannelFrame({ type: "nope" })).toBeNull();
  });

  it("parses the task socket's frames", () => {
    expect(
      toTaskSocketFrame({ type: "event", seq: "17-0", event: { type: "TEXT_MESSAGE_CONTENT" } }),
    ).toMatchObject({ type: "event", seq: "17-0" });
    expect(toTaskSocketFrame({ type: "event", event: {} })).toBeNull();
    expect(toTaskSocketFrame({ type: "terminal", status: "success" })).toMatchObject({
      type: "terminal",
      status: "success",
      task: null,
    });
  });
});

describe("transformMessage whitelists the plan-41 fields", () => {
  it("keeps kind and task_notice on a wake-up row", () => {
    const message = transformMessage({
      id: "m1",
      sender: "user",
      content: "",
      kind: "task_notification",
      task_notice: { task_id: "t1", name: "researcher", status: "success", duration_ms: 134_000 },
      created_at: new Date(T0).toISOString(),
      updated_at: new Date(T0).toISOString(),
    });
    expect(message.kind).toBe("task_notification");
    expect(message.taskNotice).toEqual({
      taskId: "t1",
      name: "researcher",
      status: "success",
      durationMs: 134_000,
    });
  });

  it("reads an ordinary message as no notice, and junk kinds as none", () => {
    const message = transformMessage({ id: "m2", sender: "user", kind: "something-else" });
    expect(message.kind).toBeNull();
    expect(message.taskNotice).toBeNull();
  });
});

describe("task tree: frames in any order", () => {
  it("files a child that arrives before its parent under it once the parent lands", () => {
    let tree = createTaskTree(CONV);
    const child = wireTask("child", { parent_task_id: "root", depth: 2, name: "helper" });
    tree = applyTaskFrame(tree, child, "TASK_STARTED", T0);
    // No parent yet: not a root of the message either (it is not depth 1).
    expect(rootTasksForMessage(tree, "msg-ai-1")).toEqual([]);
    tree = applyTaskFrame(tree, wireTask("root"), "TASK_STARTED", T0);
    expect(rootTasksForMessage(tree, "msg-ai-1").map((task) => task.taskId)).toEqual(["root"]);
    expect(
      taskChildrenIndex(tree)
        .get("root")
        ?.map((task) => task.taskId),
    ).toEqual(["child"]);
    expect(taskAncestry(tree, "child").map((task) => task.taskId)).toEqual(["root", "child"]);
  });

  it("never lets a late TASK_STARTED roll back a status", () => {
    let tree = createTaskTree(CONV);
    const task = wireTask("t1");
    tree = applyTaskFrame(tree, withStatus(task, "waiting_children"), "TASK_STATUS", T0);
    tree = applyTaskFrame(tree, withStatus(task, "pending"), "TASK_STARTED", T0);
    expect(tree.tasks.t1.status).toBe("waiting_children");
    const settled = withStatus(task, "success", T0 + 5_000);
    tree = applyTaskFrame(tree, settled, "TASK_SETTLED", T0);
    tree = applyTaskFrame(tree, withStatus(task, "pending"), "TASK_STARTED", T0);
    expect(tree.tasks.t1.status).toBe("success");
    expect(tree.tasks.t1.settledAt).toBe(T0 + 5_000);
  });

  it("lets a settled task reopen (an update after an error)", () => {
    let tree = createTaskTree(CONV);
    const task = wireTask("t1");
    tree = applyTaskFrame(tree, withStatus(task, "error", T0 + 1000), "TASK_SETTLED", T0);
    tree = applyTaskFrame(tree, withStatus(task, "running"), "TASK_STATUS", T0 + 2000);
    expect(tree.tasks.t1.status).toBe("running");
  });

  it("never lowers usage on a stale frame", () => {
    let tree = createTaskTree(CONV);
    tree = applyTaskFrame(
      tree,
      wireTask("t1", { usage: { input_tokens: 900 } }),
      "TASK_STATUS",
      T0,
    );
    tree = applyTaskFrame(
      tree,
      wireTask("t1", { usage: { input_tokens: 100 } }),
      "TASK_STATUS",
      T0,
    );
    expect(tree.tasks.t1.usage.inputTokens).toBe(900);
  });

  it("ignores a frame for another conversation", () => {
    const tree = createTaskTree(CONV);
    const next = applyTaskFrame(
      tree,
      wireTask("t1", { conversation_id: "other" }),
      "TASK_STATUS",
      T0,
    );
    expect(next).toBe(tree);
  });
});

describe("task tree: reload hydration", () => {
  it("builds the whole tree from GET …/tasks", () => {
    const rows = [
      wireTask("root"),
      wireTask("mid", { parent_task_id: "root", depth: 2, name: "helper" }),
      wireTask("leaf", { parent_task_id: "mid", depth: 3, name: "sub-helper", status: "waiting" }),
    ];
    const tree = hydrateTaskTree(createTaskTree(CONV), rows, 0, T0);
    expect(Object.keys(tree.tasks).sort()).toEqual(["leaf", "mid", "root"]);
    expect(taskAncestry(tree, "leaf").map((task) => task.name)).toEqual([
      "researcher",
      "helper",
      "sub-helper",
    ]);
    expect(waitingTasks(tree).map((task) => task.taskId)).toEqual(["leaf"]);
  });

  it("does not overwrite a task a frame wrote after the read went out", () => {
    let tree = createTaskTree(CONV);
    const issuedAt = tree.clock;
    // The read is in flight; the task settles over the channel meanwhile.
    tree = applyTaskFrame(tree, wireTask("t1", { status: "success" }), "TASK_SETTLED", T0);
    // The read answers with the older state.
    tree = hydrateTaskTree(
      tree,
      [wireTask("t1", { status: "running" }), wireTask("t2")],
      issuedAt,
      T0,
    );
    expect(tree.tasks.t1.status).toBe("success");
    expect(tree.tasks.t2.status).toBe("running");
  });

  it("lets a read issued after the frame win", () => {
    let tree = createTaskTree(CONV);
    tree = applyTaskFrame(tree, wireTask("t1", { status: "running" }), "TASK_STATUS", T0);
    const issuedAt = tree.clock;
    tree = hydrateTaskTree(tree, [wireTask("t1", { status: "success" })], issuedAt, T0);
    expect(tree.tasks.t1.status).toBe("success");
  });
});

describe("task tree: Stop", () => {
  it("shows stopping at once, and the settle clears it", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = requestTaskStop(tree, "t1", T0);
    expect(taskDisplayStatus(tree, "t1")).toBe("stopping");
    tree = applyTaskFrame(tree, wireTask("t1", { status: "cancelled" }), "TASK_SETTLED", T0 + 500);
    expect(taskDisplayStatus(tree, "t1")).toBe("cancelled");
  });

  it("stays stopping when the cancel answer is still running (the cascade is async)", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = requestTaskStop(tree, "t1", T0);
    tree = applyTaskFrame(tree, wireTask("t1", { status: "running" }), "TASK_STATUS", T0 + 100);
    expect(taskDisplayStatus(tree, "t1")).toBe("stopping");
  });

  it("rolls back when the cancel request fails", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = requestTaskStop(tree, "t1", T0);
    tree = failTaskStop(tree, "t1");
    expect(taskDisplayStatus(tree, "t1")).toBe("running");
  });

  it("does not revive a stopped task from a frame emitted before the cancel", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = requestTaskStop(tree, "t1", T0);
    tree = applyTaskFrame(tree, wireTask("t1", { status: "cancelled" }), "TASK_SETTLED", T0 + 200);
    tree = applyTaskFrame(tree, wireTask("t1", { status: "running" }), "TASK_STATUS", T0 + 400);
    expect(tree.tasks.t1.status).toBe("cancelled");
    // Past the grace window a running frame is a real reopen.
    tree = applyTaskFrame(
      tree,
      wireTask("t1", { status: "running" }),
      "TASK_STATUS",
      T0 + STOP_GRACE_MS + 1,
    );
    expect(tree.tasks.t1.status).toBe("running");
  });

  it("ignores a stop on a settled task", () => {
    const tree = applyTaskFrame(
      createTaskTree(CONV),
      wireTask("t1", { status: "success" }),
      "TASK_SETTLED",
      T0,
    );
    expect(requestTaskStop(tree, "t1", T0)).toBe(tree);
  });
});

describe("task tree: a node's own socket", () => {
  const event = (seq: string, body: Record<string, unknown>): TaskSocketFrame => ({
    type: "event",
    seq,
    event: body,
  });

  it("folds a node's events with the run reducer and drops a replayed entry", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      { type: "snapshot", task: null, events: [{ type: "TEXT_MESSAGE_CONTENT", delta: "Hel" }] },
      T0,
    );
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      event("5-0", { type: "TEXT_MESSAGE_CONTENT", delta: "lo" }),
      T0,
    );
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      event("5-0", { type: "TEXT_MESSAGE_CONTENT", delta: "lo" }),
      T0,
    );
    const blocks = tree.nodes.t1.timeline.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "content", text: "Hello" });
    expect(tree.nodes.t1.lastSeq).toBe("5-0");
  });

  it("keeps what the node folded when a reconnect's snapshot carries no log", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      event("3-0", { type: "TEXT_MESSAGE_CONTENT", delta: "So far" }),
      T0,
    );
    const parsed = toTaskSocketFrame({
      type: "snapshot",
      task: { task_id: "t1", status: "running" },
    });
    expect(parsed).toMatchObject({ type: "snapshot", events: null });
    tree = applyTaskSocketFrame(tree, "t1", parsed as TaskSocketFrame, T0);
    expect(tree.nodes.t1.timeline.blocks[0]).toMatchObject({ kind: "content", text: "So far" });
    expect(tree.nodes.t1.lastSeq).toBe("3-0");
  });

  it("carries a node's own launches as task_ref blocks (its children)", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      event("1-0", {
        type: "CUSTOM",
        name: "TASK_LAUNCHED",
        value: { task_id: "child", name: "helper", description: "dig" },
      }),
      T0,
    );
    expect(tree.nodes.t1.timeline.blocks[0]).toMatchObject({ kind: "task_ref", taskId: "child" });
  });

  it("closes the node's timeline and settles the row on the terminal frame", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(tree, "t1", event("1-0", { type: "THINKING_START" }), T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      { type: "terminal", status: "success", task: null },
      T0 + 9_000,
    );
    expect(tree.tasks.t1.status).toBe("success");
    expect(tree.tasks.t1.settledAt).toBe(T0 + 9_000);
    expect(tree.nodes.t1.timeline.terminal).toBe(true);
    expect(tree.nodes.t1.timeline.terminalStatus).toBe("completed");
  });

  it("takes a task embedded in a snapshot as its state", () => {
    let tree = applyTaskFrame(createTaskTree(CONV), wireTask("t1"), "TASK_STARTED", T0);
    tree = applyTaskSocketFrame(
      tree,
      "t1",
      { type: "snapshot", task: wireTask("t1", { status: "waiting" }), events: [] },
      T0,
    );
    expect(tree.tasks.t1.status).toBe("waiting");
  });
});
