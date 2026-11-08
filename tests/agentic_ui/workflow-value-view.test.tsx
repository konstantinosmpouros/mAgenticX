// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { humanizeKey, looksLikeMarkdown, outputSummary, valueShape } from "@/features/workflows/lib/valueView";
import { ValueView } from "@/features/workflows/components/workflow_view_parts/ValueView";

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

describe("ValueView", () => {
  const output = {
    score: 93,
    healthy: true,
    verdict: "Healthy",
    report: "# Health Report\n\n**Verdict:** Healthy",
    reasons: ["Active", "Popular"],
  };

  it("shows fields with labels, rendered markdown and chips by default", () => {
    render(<ValueView value={output} title="Output" />);
    const region = screen.getByRole("region", { name: "Output" });
    expect(within(region).getByText("Score")).toBeInTheDocument();
    expect(within(region).getByText("93")).toBeInTheDocument();
    expect(within(region).getByText("Yes")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "Health Report" })).toBeInTheDocument();
    expect(within(region).getByText("Popular")).toBeInTheDocument();
  });

  it("never shows raw JSON: nested values read as fields and numbered items", () => {
    render(<ValueView value={{ rows: [{ a: { deep: 1 } }, { a: { deep: 2 } }] }} title="Output" />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getAllByText("Deep")).toHaveLength(2);
    expect(screen.queryByText("deep:")).toBeNull();
  });

  it("leaves hidden keys out, and shows nothing when every key is hidden", () => {
    const { unmount } = render(<ValueView value={{ text: "Hi", model: "m" }} title="Details" hideKeys={["text"]} />);
    expect(screen.queryByText("Hi")).toBeNull();
    expect(screen.getByText("Model")).toBeInTheDocument();
    unmount();
    render(<ValueView value={{ text: "Hi" }} title="Details" hideKeys={["text"]} />);
    expect(screen.queryByRole("region", { name: "Details" })).toBeNull();
  });

  it("says when there is nothing", () => {
    render(<ValueView value={null} title="Input" emptyText="No input." />);
    expect(screen.getByText("No input.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
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
