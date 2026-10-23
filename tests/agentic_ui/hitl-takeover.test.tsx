// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HitlInputTakeover } from "@/features/chat/components/HitlInputTakeover";
import {
  approvalHeadline,
  presentApproval,
  presentInterrupt,
  type ApprovalField,
} from "@/features/chat/lib/approvalPresentation";
import { isGenericHitlDescription } from "@/features/inference";

/**
 * The approval surface. Worth covering before the ChatPage restructure moves it:
 * a sub-agent approval failing here is what produced a run that died with no
 * message, and the failure was only visible by exercising the UI.
 */
const interrupt = {
  interruptId: "int-1",
  threadId: "thread-1",
  content: {
    id: "int-1",
    value: { action_requests: [{ action: "write_file", args: { file_path: "/out/a.txt" } }] },
  },
};

const renderTakeover = (onResolve: (d: unknown[]) => Promise<void>) =>
  render(
    <HitlInputTakeover interrupt={interrupt} pendingCount={1} onResolve={onResolve as never} />,
  );

// What LangChain's HumanInTheLoopMiddleware writes when a gate has no
// description of its own: a Python repr of the arguments, escaped newlines and all.
const MIDDLEWARE_DESCRIPTION =
  "Tool execution requires approval\n\nTool: task\nArgs: {'description': 'Draw the flow\\n```mermaid\\ngraph TD\\n```', 'subagent_type': 'general-purpose'}";

const TASK_BRIEF = "## Goal\nDraw the login flow.\n\n```mermaid\ngraph TD\n  A-->B\n```";

const taskInterrupt = {
  interruptId: "int-task",
  threadId: "thread-1",
  content: {
    id: "int-task",
    value: {
      action_requests: [
        {
          name: "task",
          args: { description: TASK_BRIEF, subagent_type: "general-purpose" },
          description: MIDDLEWARE_DESCRIPTION,
        },
      ],
    },
  },
};

const kinds = (fields: ApprovalField[]) => fields.map((field) => field.kind);

describe("HitlInputTakeover", () => {
  it("names the action awaiting approval", () => {
    renderTakeover(async () => {});
    expect(screen.getByText("Write a.txt")).toBeInTheDocument();
  });

  it("sends an approve decision", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderTakeover(onResolve);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0]).toEqual([expect.objectContaining({ decision: "approve" })]);
  });

  it("surfaces a failed decision instead of failing silently", async () => {
    // The run-died-with-no-message case: onResolve rejects, and the component
    // must say so rather than leaving the user staring at a dead prompt.
    const onResolve = vi.fn().mockRejectedValue(new Error("stale interrupt"));
    renderTakeover(onResolve);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(screen.getByText(/stale interrupt/)).toBeInTheDocument());
  });

  it("shows a sub-agent hand-off as its brief, without the middleware's repr or an arguments dump", async () => {
    render(
      <HitlInputTakeover interrupt={taskInterrupt} pendingCount={1} onResolve={vi.fn() as never} />,
    );
    expect(screen.getByText("Hand off to the general-purpose sub-agent")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show approval details/i }));

    expect(screen.getByRole("heading", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByText("Draw the login flow.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Tool execution requires approval/);
    expect(document.body.textContent).not.toMatch(/Arguments/i);
    expect(document.body.textContent).not.toMatch(/subagent_type|\\n/);
  });

  it("titles each card of a batch by what it does", () => {
    const batch = {
      interruptId: "int-batch",
      threadId: "thread-1",
      content: {
        value: {
          action_requests: [
            { name: "execute", args: { command: "rm -rf build" } },
            { name: "write_file", args: { file_path: "/out/b.md", content: "# Hi" } },
          ],
        },
      },
    };
    render(<HitlInputTakeover interrupt={batch} pendingCount={1} onResolve={vi.fn() as never} />);
    expect(screen.getByText("Run a shell command")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  });
});

describe("approval presenter", () => {
  it("task: names the sub-agent and keeps the brief as Markdown", () => {
    const [summary] = presentInterrupt(taskInterrupt.content);
    expect(summary.title).toBe("Hand off to the general-purpose sub-agent");
    expect(summary.fields).toEqual([{ kind: "markdown", value: TASK_BRIEF }]);
    expect(summary.note).toBeUndefined();
  });

  it("task: drops a trailing 'agent' and restores a double-escaped brief", () => {
    const summary = presentApproval({
      toolName: "task",
      args: { description: "Line one\\nLine two", subagent_type: "research_agent" },
    });
    expect(summary.title).toBe("Hand off to the research sub-agent");
    expect(summary.fields[0]).toEqual({ kind: "markdown", value: "Line one\nLine two" });
  });

  it("write_file: the path, then the content as code in the file's language", () => {
    const summary = presentApproval({
      toolName: "write_file",
      args: { file_path: "/out/report.py", content: "print('hi')\n" },
    });
    expect(summary.title).toBe("Write report.py");
    expect(summary.fields).toEqual([
      { kind: "text", label: "File", value: "/out/report.py", mono: true },
      { kind: "code", label: "Content", value: "print('hi')\n", language: "python" },
    ]);
  });

  it("edit_file: the path and the change as a diff", () => {
    const summary = presentApproval({
      toolName: "edit_file",
      args: { file_path: "/a.md", old_string: "old", new_string: "new", replace_all: true },
    });
    expect(summary.title).toBe("Edit a.md");
    expect(kinds(summary.fields)).toEqual(["text", "text", "code"]);
    expect(summary.fields[2]).toMatchObject({ language: "diff", value: "- old\n+ new" });
  });

  it("execute: the command in a code block, in full", () => {
    const command = `python -c "${"x".repeat(200)}"`;
    const summary = presentApproval({ toolName: "execute", args: { command } });
    expect(summary.title).toBe("Run a shell command");
    expect(summary.fields).toEqual([{ kind: "code", value: command, language: "bash" }]);
  });

  it("MCP: 'Server · Tool' and the arguments as labelled values", () => {
    const summary = presentApproval(
      { toolName: "tavily-search", args: { query: "solar output 2026", max_results: 5, topic: "" } },
      "tavily",
    );
    expect(summary.title).toBe("Tavily · Search");
    expect(summary.fields).toEqual([
      { kind: "text", label: "Query", value: "solar output 2026" },
      { kind: "text", label: "Max results", value: "5" },
    ]);
    // A `server/tool` name is recognised before the catalog has loaded.
    expect(presentApproval({ toolName: "arxiv/search_papers", args: {} }).title).toBe(
      "arXiv · Search papers",
    );
  });

  it("unknown tools: a humanised name and a clean key/value list — never JSON for flat values", () => {
    const summary = presentApproval({
      toolName: "send_slackMessage",
      args: {
        channel: "#ops",
        urgent: true,
        tags: ["a", "b"],
        options: { retry: 2 },
        empty: null,
      },
    });
    expect(summary.title).toBe("Send slack message");
    expect(summary.fields).toEqual([
      { kind: "text", label: "Channel", value: "#ops" },
      { kind: "text", label: "Urgent", value: "Yes" },
      { kind: "text", label: "Tags", value: "a, b" },
      { kind: "code", label: "Options", value: '{\n  "retry": 2\n}', language: "json" },
    ]);
  });

  it("long or multi-line text becomes a block, not an inline value", () => {
    const long = "word ".repeat(60).trim();
    const summary = presentApproval({
      toolName: "post_note",
      args: { body: long, lines: "one\ntwo" },
    });
    expect(kinds(summary.fields)).toEqual(["prose", "prose"]);
    expect(summary.fields[0]).toMatchObject({ label: "Body", value: long });
  });

  it("drops the middleware's generic description but keeps one an agent wrote", () => {
    expect(isGenericHitlDescription(MIDDLEWARE_DESCRIPTION)).toBe(true);
    expect(isGenericHitlDescription("Tool execution requires approval")).toBe(true);
    expect(isGenericHitlDescription("Deletes the production table.")).toBe(false);
    const summary = presentApproval({
      toolName: "drop_table",
      args: { table: "users" },
      description: "Deletes the production table.",
    });
    expect(summary.note).toBe("Deletes the production table.");
  });

  it("a free-form interrupt reads as its question", () => {
    const [summary] = presentInterrupt({ value: { question: "Proceed with the migration?" } });
    expect(summary.fields).toEqual([{ kind: "markdown", value: "Proceed with the migration?" }]);
  });

  it("the headline counts the rest of a batch", () => {
    const summaries = presentInterrupt({
      value: {
        action_requests: [
          { name: "execute", args: { command: "ls" } },
          { name: "read_file", args: { file_path: "/a/b.txt" } },
        ],
      },
    });
    expect(approvalHeadline(summaries)).toBe("Run a shell command (+1 more)");
  });
});

describe("approval summary rendering", () => {
  it("clips a long brief behind Show more", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: do the thing.`).join("\n\n");
    const content = {
      value: {
        action_requests: [{ name: "task", args: { description: long, subagent_type: "writer" } }],
      },
    };
    render(
      <HitlInputTakeover
        interrupt={{ interruptId: "int-long", threadId: "t", content }}
        pendingCount={1}
        onResolve={vi.fn() as never}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /show approval details/i }));
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
