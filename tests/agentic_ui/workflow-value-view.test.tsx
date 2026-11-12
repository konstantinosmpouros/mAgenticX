// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { humanizeKey, looksLikeMarkdown, outputSummary, valueShape } from "@/features/workflows/lib/valueView";
import type { WorkflowExecution } from "@/shared/lib/types";
import { ValueTree } from "@/features/workflows/components/workflow_view_parts/ValueTree";
import { ValuePanel } from "@/features/workflows/components/workflow_view_parts/ValuePanel";
import { StepOutput } from "@/features/workflows/components/workflow_view_parts/StepOutput";

// Streamdown pulls in KaTeX's CSS, which the test runner cannot load: the reply renders as plain text here.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

describe("value view helpers", () => {
  it("reads keys as labels", () => {
    expect(humanizeKey("days_since_push")).toBe("Days since push");
    expect(humanizeKey("openIssues")).toBe("Open issues");
    expect(humanizeKey("score")).toBe("Score");
  });

  it("tells markdown from a plain line", () => {
    expect(looksLikeMarkdown("# Report\n\n**Verdict:** Healthy")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("Healthy")).toBe(false);
  });

  it("picks a shape per value", () => {
    expect(valueShape(null)).toBe("empty");
    expect(valueShape("")).toBe("empty");
    expect(valueShape(true)).toBe("boolean");
    expect(valueShape(93)).toBe("number");
    expect(valueShape("Healthy")).toBe("text");
    expect(valueShape(["a", "b"])).toBe("chips");
    expect(valueShape(["A fairly long reason that does not fit a chip at all, really"])).toBe("list");
    expect(valueShape([{ city: "Athens", temp: 21 }])).toBe("records");
    expect(valueShape([{ nested: { deep: 1 } }])).toBe("tree");
    expect(valueShape({ a: 1 })).toBe("object");
    expect(valueShape({})).toBe("empty");
  });
});

const exec = (over: Partial<WorkflowExecution>): WorkflowExecution => ({
  executionId: "step#1",
  nodeId: "step",
  iteration: 1,
  parentExecutionId: null,
  status: "succeeded",
  startSeq: 1,
  endSeq: 2,
  startedAt: "2026-11-04T10:00:00Z",
  durationMs: 391,
  input: null,
  output: null,
  branch: null,
  error: null,
  stateDelta: [],
  toolCalls: [],
  text: "",
  approval: null,
  events: [],
  ...over,
});

describe("ValueTree", () => {
  it("shows the top level and folds nested values behind a preview", () => {
    render(<ValueTree value={{ name: "langgraph", owner: { login: "octo", id: 7 }, topics: ["a", "b", "c"] }} />);
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("langgraph")).toBeInTheDocument();
    const owner = screen.getByRole("button", { name: /owner/ });
    expect(owner).toHaveAttribute("aria-expanded", "false");
    expect(owner).toHaveTextContent("{2 keys}");
    expect(screen.getByRole("button", { name: /topics/ })).toHaveTextContent("[3 items]");
    expect(screen.queryByText("login")).toBeNull();
    fireEvent.click(owner);
    expect(owner).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("octo")).toBeInTheDocument();
  });

  it("types its values: numbers, yes / no chips, null", () => {
    render(<ValueTree value={{ size: 532079, fork: false, archived: true, license: null }} />);
    expect(screen.getByText("532,079")).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("pages a long level and clamps a long string", () => {
    const items = Array.from({ length: 45 }, (_, index) => `item-${index}`);
    render(<ValueTree value={{ items, readme: "x".repeat(400) }} openDepth={2} />);
    expect(screen.getByText("item-19")).toBeInTheDocument();
    expect(screen.queryByText("item-20")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(screen.getByText("item-39")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getByText("item-44")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: /Show more · 400 chars/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});

describe("ValuePanel", () => {
  it("switches between the tree and the raw JSON, and keeps the copy button", async () => {
    render(<ValuePanel title="Input" value={{ url: "https://example.test", query: { page: 2 } }} />);
    const region = screen.getByRole("region", { name: "Input" });
    expect(within(region).getByRole("radio", { name: "Tree" })).toHaveAttribute("aria-checked", "true");
    expect(within(region).getByRole("button", { name: "Copy input as JSON" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: /query/ })).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("radio", { name: "Raw JSON" }));
    await waitFor(() => expect(region.querySelector("pre")?.textContent).toContain('"page": 2'));
    expect(within(region).queryByRole("button", { name: /query/ })).toBeNull();
  });

  it("says when there is nothing", () => {
    render(<ValuePanel title="Input" value={null} emptyText="No input." />);
    expect(screen.getByText("No input.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("StepOutput", () => {
  const fetchOutput = {
    ok: true,
    status: 200,
    url: "https://api.github.com/repos/langchain-ai/langgraph",
    contentType: "application/json; charset=utf-8",
    headers: { etag: "W/abc", "x-ratelimit-remaining": "59" },
    body: { id: 1, name: "langgraph", owner: { login: "langchain-ai", id: 2 } },
  };

  it("leads an HTTP step with status, method and URL; the tree shows only the body", () => {
    render(
      <StepOutput
        kind="fetch"
        execution={exec({ input: { url: fetchOutput.url, method: "GET" }, output: fetchOutput })}
      />,
    );
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByTitle(fetchOutput.url)).toHaveTextContent("api.github.com/repos/langchain-ai/langgraph");
    expect(screen.getByText("JSON")).toBeInTheDocument();
    const body = screen.getByRole("list", { name: "Response body" });
    expect(within(body).getByText("langgraph")).toBeInTheDocument();
    expect(within(body).getByRole("button", { name: /owner/ })).toHaveTextContent("{2 keys}");
    // Not repeated: what the summary says stays out of the tree.
    expect(within(body).queryByText("status")).toBeNull();
    expect(within(body).queryByText("contentType")).toBeNull();
    // Headers sit folded in their own group.
    const headers = screen.getByRole("button", { name: /Response headers/ });
    expect(headers).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("etag")).toBeNull();
    fireEvent.click(headers);
    expect(screen.getByText("etag")).toBeInTheDocument();
  });

  it("tones a client error by its class, with an icon and text", () => {
    render(<StepOutput kind="fetch" execution={exec({ output: { ...fetchOutput, ok: false, status: 404, body: "" } })} />);
    expect(screen.getByText("404").closest("span")).toHaveClass("text-warning");
    expect(screen.getByText("Not Found")).toBeInTheDocument();
    expect(screen.getByText("The response had no body.")).toBeInTheDocument();
  });

  it("says a router's branch and keeps the raw output one click away", () => {
    render(<StepOutput kind="router" execution={exec({ output: { case: "healthy" }, branch: "healthy" })} />);
    expect(screen.getByText("Branch taken")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Raw JSON" })).toHaveAttribute("aria-expanded", "false");
  });

  it("lists a Set step's variables once", () => {
    render(<StepOutput kind="set" execution={exec({ output: { verdict: "Healthy", needs_attention: false } })} />);
    const list = screen.getByRole("list", { name: "Variables written" });
    expect(within(list).getByText("verdict")).toBeInTheDocument();
    expect(within(list).getByText("Healthy")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy")).toHaveLength(1);
  });

  it("shows a code step's exit code, its result and stderr folded", () => {
    render(
      <StepOutput
        kind="code"
        execution={exec({
          output: { result: { stars: 44581 }, stdout: "", stderr: "warn\n", exitCode: 0, durationMs: 289 },
        })}
      />,
    );
    expect(screen.getByText("Exit 0")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Result" })).getByText("44,581")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^stderr/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^stdout/ })).toBeNull();
  });

  it("renders an llm reply and keeps the conversation out of the tree", () => {
    const reply = "# Report\n\nAll good.";
    render(
      <StepOutput
        kind="llm"
        execution={exec({ text: reply, output: { text: reply, model: "openai:gpt-4o-mini", messages: [] } })}
      />,
    );
    const response = screen.getByRole("region", { name: "Response" });
    expect(response).toHaveTextContent("All good.");
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.queryByText("messages")).toBeNull();
  });
});

describe("outputSummary", () => {
  it("says what a step produced in one line", () => {
    expect(outputSummary({ text: "# Report\n\nAll **good** here" })).toBe("Report All good here");
    expect(outputSummary({ result: { score: 93, status: "healthy" } })).toBe("Score 93 · Status healthy");
    expect(outputSummary({ status: 200, body: [1, 2, 3] })).toBe("3 items");
    expect(outputSummary(null)).toBe("");
    expect(outputSummary({ data: "x" }, "Streamed answer")).toBe("Streamed answer");
  });
});
