// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import catalogJson from "./fixtures/workflow-catalog.json";
import { templateText, typeTemplate } from "./templateField";
import { NodeInspector } from "@/features/workflows/components/builder/builder_parts/NodeInspector";
import { TemplateField } from "@/features/workflows/components/builder/builder_parts/TemplateField";
import { setCaretOffset } from "@/features/workflows/lib/builder/templateDom";
import {
  describeTemplateRef,
  parseTemplate,
  renameNodeReferences,
  templatePaths,
} from "@/features/workflows/lib/builder/templates";
import { WorkflowCatalogSchema } from "@/shared/lib/schemas";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { WorkflowNodeKindInfo, WorkflowSpec, WorkflowTemplatePath } from "@/shared/lib/types";

/**
 * The template chip editor and what it offers: a `{{path}}` shows as a chip
 * with a friendly label (and the value stays the same template string), the
 * picker (each field's `{ }`) inserts at the caret, a drop lands in
 * the field, an llm step hands on its answer (JSON schema properties too, its
 * conversation under "More"), and a step inside a loop offers "Every run".
 */

const catalog = WorkflowCatalogSchema.parse(catalogJson) as WorkflowNodeKindInfo[];
const info = (kind: string) => catalog.find((entry) => entry.kind === kind) ?? null;

const at = { x: 0, y: 0 };
const node = (id: string, kind: string, config: Record<string, unknown> = {}, label?: string) => ({
  id,
  kind,
  config,
  position: at,
  ...(label ? { label } : {}),
});

/** start → fetch ("Fetch page") → ask (llm) → done, with an input and a variable (`facts`, written by a Set step off to the side). */
const linear = (askConfig: Record<string, unknown> = { prompt: "hi" }): WorkflowSpec => ({
  version: 1,
  name: "Linear",
  inputs: [{ name: "topic", type: "string", required: true }] as WorkflowSpec["inputs"],
  nodes: [
    node("start", "trigger.manual"),
    node("fetch", "fetch", { url: "https://example.com" }, "Fetch page"),
    node("ask", "llm", askConfig, "Ask AI"),
    node("done", "end"),
    node("note", "set", { values: { facts: "{{nodes.fetch.output.body}}" } }),
  ],
  edges: [
    { id: "e1", source: "start", target: "fetch" },
    { id: "e2", source: "fetch", target: "ask" },
    { id: "e3", source: "ask", target: "done" },
  ],
});

/** start → loop; loop continue → fetch → loop; loop done → after → end. */
const looped = (): WorkflowSpec => ({
  version: 1,
  name: "Looped",
  inputs: [],
  nodes: [
    node("start", "trigger.manual"),
    node("loop", "loop", { max_iterations: 3 }),
    node("fetch", "fetch", { url: "https://example.com" }, "Fetch page"),
    node("after", "llm", { prompt: "sum up" }),
    node("end", "end"),
  ],
  edges: [
    { id: "e1", source: "start", target: "loop" },
    { id: "e2", source: "loop", target: "fetch", branch: "continue" },
    { id: "e3", source: "fetch", target: "loop" },
    { id: "e4", source: "loop", target: "after", branch: "done" },
    { id: "e5", source: "after", target: "end" },
  ],
});

const label = (path: string, paths: readonly WorkflowTemplatePath[]) => {
  const ref = describeTemplateRef(path, paths);
  return ref.valid ? `${ref.source} › ${ref.label}` : `invalid:${ref.label}`;
};

describe("template paths", () => {
  it("round-trips a template through its segments exactly", () => {
    const value = "Hi {{ input.topic }}, see {{nodes.fetch.output.body}}{{state.facts}} {{ broken";
    const segments = parseTemplate(value);
    expect(segments.filter((s) => s.type === "ref").map((s) => (s.type === "ref" ? s.path : ""))).toEqual([
      "input.topic",
      "nodes.fetch.output.body",
      "state.facts",
    ]);
    expect(segments.map((s) => (s.type === "text" ? s.text : s.raw)).join("")).toBe(value);
  });

  it("labels a path by its source and field, and flags what the field can't read", () => {
    const paths = templatePaths(linear(), "done");
    expect(label("nodes.fetch.output.body", paths)).toBe("Fetch page › Body");
    expect(label("nodes.fetch.output.body.items", paths)).toBe("Fetch page › Body › items");
    expect(label("input.topic", paths)).toBe("Run input › topic");
    expect(label("state.facts", paths)).toBe("Variable › facts");
    expect(label("nodes.ask.output.text", paths)).toBe("Ask AI › Answer");
    expect(label("nodes.ghost.output", paths)).toBe("invalid:nodes.ghost.output");
    expect(label("output.text", paths)).toBe("invalid:output.text");
    expect(label("input.nope", paths)).toBe("invalid:input.nope");
    expect(label("state.nope", paths)).toBe("invalid:state.nope");
    // A variable reads anywhere, even in a step before the Set that writes it.
    expect(label("state.facts", templatePaths(linear(), "fetch"))).toBe("Variable › facts");
  });

  it("offers an llm step's answer first and its conversation only under More", () => {
    const paths = templatePaths(linear(), "done").filter((entry) => entry.nodeId === "ask");
    expect(paths[0]).toMatchObject({ path: "nodes.ask.output.text", label: "Answer" });
    expect(paths.find((entry) => entry.path === "nodes.ask.output.messages")).toMatchObject({
      label: "Conversation",
      more: true,
    });
    expect(paths.find((entry) => entry.path === "nodes.ask.output.model")?.more).toBe(true);
    expect(paths.some((entry) => entry.path === "nodes.ask.output.data")).toBe(false);
  });

  it("offers a JSON-mode answer and each of its schema's properties", () => {
    const spec = linear({
      prompt: "rate it",
      output: "json",
      json_schema: { type: "object", properties: { title: { type: "string" }, score: { type: "number", title: "Score" } } },
    });
    const paths = templatePaths(spec, "done").filter((entry) => entry.nodeId === "ask" && !entry.more);
    expect(paths.map((entry) => [entry.path, entry.label, entry.hint])).toEqual([
      ["nodes.ask.output.data", "Answer", "object"],
      ["nodes.ask.output.data.title", "title", "string"],
      ["nodes.ask.output.data.score", "Score", "number"],
    ]);
    expect(label("nodes.ask.output.data", templatePaths(spec, "done"))).toBe("Ask AI › Answer");
  });

  it("lists earlier steps nearest first", () => {
    const sources = templatePaths(linear(), "done")
      .filter((entry) => entry.group === "node")
      .map((entry) => entry.nodeId);
    expect([...new Set(sources)]).toEqual(["ask", "fetch", "start"]);
  });

  it("offers Every run and Run N for a step inside a loop, to the steps after it", () => {
    const after = templatePaths(looped(), "after");
    expect(after.find((entry) => entry.path === "nodes.fetch.outputs")).toMatchObject({ label: "Every run", hint: "list" });
    expect(after.find((entry) => entry.path === "nodes.fetch.outputs.1")).toMatchObject({ label: "Run 2", section: "Runs" });
    expect(label("nodes.fetch.outputs", after)).toBe("Fetch page › Every run");
    expect(label("nodes.fetch.outputs.1", after)).toBe("Fetch page › Run 2");
    expect(label("nodes.fetch.outputs.1.body", after)).toBe("Fetch page › Run 2 › body");
    expect(label("nodes.fetch.outputs.6", after)).toBe("Fetch page › Run 7");
    // A step outside any loop has no list of runs.
    expect(templatePaths(linear(), "done").some((entry) => entry.path.endsWith(".outputs"))).toBe(false);
  });

  it("renames `outputs` references with the step", () => {
    expect(renameNodeReferences("{{nodes.fetch.outputs}} {{nodes.fetch.outputs.0.body}}", "fetch", "page")).toBe(
      "{{nodes.page.outputs}} {{nodes.page.outputs.0.body}}",
    );
  });
});

const PATHS = templatePaths(linear(), "done");

const renderField = (value: string, onChange = vi.fn(), multiline = false) => {
  const view = render(
    <TemplateField id="f1" ariaLabel="Message" value={value} onChange={onChange} paths={PATHS} multiline={multiline} mono={false} />,
  );
  const field = screen.getByRole("textbox", { name: "Message" });
  const rerender = (next: string) =>
    view.rerender(
      <TemplateField id="f1" ariaLabel="Message" value={next} onChange={onChange} paths={PATHS} multiline={multiline} mono={false} />,
    );
  return { field, onChange, rerender };
};

describe("template chip editor", () => {
  it("shows each placeholder as a chip and serializes back to the same template", () => {
    const value = "Hi {{nodes.fetch.output.body}} and {{nope.x}}";
    const { field } = renderField(value);
    const chips = field.querySelectorAll<HTMLElement>("[data-raw]");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("Fetch page›Body");
    expect(chips[0].getAttribute("contenteditable")).toBe("false");
    expect(chips[0].dataset.valid).toBe("true");
    expect(chips[1].dataset.valid).toBe("false");
    expect(chips[1].textContent).toBe("nope.x");
    expect(templateText(field)).toBe(value);
  });

  it("turns typed {{…}} text into a chip and emits the template", () => {
    const { field, onChange } = renderField("");
    typeTemplate(field, "About {{input.topic}}");
    expect(onChange).toHaveBeenLastCalledWith("About {{input.topic}}");
    const chip = field.querySelector<HTMLElement>("[data-raw]");
    expect(chip?.textContent).toBe("Run input›topic");
  });

  it("keeps the DOM when the parent echoes the value back, and redraws on an outside change", () => {
    const { field, onChange, rerender } = renderField("");
    typeTemplate(field, "plain");
    const textNode = field.firstChild;
    rerender(onChange.mock.lastCall?.[0] as string);
    expect(field.firstChild).toBe(textNode);
    rerender("{{state.facts}}");
    expect(field.querySelector("[data-raw]")?.textContent).toBe("Variable›facts");
  });

  it("inserts the picked value as a chip at the caret", async () => {
    const { field, onChange } = renderField("Hi there");
    field.focus();
    setCaretOffset(field, 3);
    fireEvent.click(screen.getByRole("button", { name: "Insert a value from the run" }));
    const group = await screen.findByRole("group", { name: "Fetch page" });
    fireEvent.click(within(group).getByRole("button", { name: /Body/ }));
    expect(onChange).toHaveBeenLastCalledWith("Hi {{nodes.fetch.output.body}}there");
    expect(field.querySelector("[data-raw]")?.textContent).toBe("Fetch page›Body");
  });

  it("keeps an llm step's conversation under More in the picker, and searches by name", async () => {
    renderField("");
    fireEvent.click(screen.getByRole("button", { name: "Insert a value from the run" }));
    const ask = await screen.findByRole("group", { name: "Ask AI" });
    expect(within(ask).getByRole("button", { name: /Answer/ })).toBeInTheDocument();
    expect(within(ask).queryByRole("button", { name: /Conversation/ })).toBeNull();
    const more = screen.getByRole("group", { name: "More" });
    expect(within(more).getByRole("button", { name: /Ask AI.*Conversation/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search data" }), { target: { value: "status" } });
    expect(screen.getByRole("button", { name: /Status code/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Ask AI" })).toBeNull();
  });

  it("accepts a dropped {{path}} as a chip", () => {
    const { field, onChange } = renderField("Read ");
    const data = { getData: (type: string) => (type === "text/plain" ? "{{input.topic}}" : "") };
    fireEvent.drop(field, { dataTransfer: data, clientX: 0, clientY: 0 });
    expect(onChange).toHaveBeenLastCalledWith("Read {{input.topic}}");
    expect(field.querySelector("[data-raw]")?.textContent).toBe("Run input›topic");
  });

  it("deletes a chip as one unit with Backspace", () => {
    const { field, onChange } = renderField("a {{input.topic}} b");
    field.focus();
    setCaretOffset(field, "a {{input.topic}}".length);
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith("a  b");
    expect(field.querySelector("[data-raw]")).toBeNull();
  });

  it("pastes plain text only, single-line fields folding newlines", () => {
    const { field, onChange } = renderField("");
    field.focus();
    const clipboardData = { getData: () => "one\ntwo {{state.facts}}" };
    fireEvent.paste(field, { clipboardData });
    expect(onChange).toHaveBeenLastCalledWith("one two {{state.facts}}");
  });

  it("takes Enter as a newline only when multiline", () => {
    const single = renderField("x");
    single.field.focus();
    setCaretOffset(single.field, 1);
    fireEvent.keyDown(single.field, { key: "Enter" });
    expect(single.onChange).not.toHaveBeenCalled();
  });
});

describe("data from earlier steps in a field", () => {
  const renderInspector = (spec: WorkflowSpec, nodeId: string, onConfig = vi.fn()) => {
    const target = spec.nodes.find((entry) => entry.id === nodeId)!;
    render(
      <TooltipProvider>
        <NodeInspector
          node={target}
          info={info(target.kind)}
          spec={spec}
          issues={[]}
          onRename={vi.fn()}
          onLabel={vi.fn()}
          onConfig={onConfig}
        />
      </TooltipProvider>,
    );
    return onConfig;
  };

  it("has no separate panel: a field's { } lists earlier steps' values and inserts the one picked", () => {
    const spec = linear();
    spec.nodes.push(node("post", "fetch", { url: "https://example.com/" }, "Post result"));
    spec.edges = spec.edges.map((edge) => (edge.id === "e3" ? { ...edge, target: "post" } : edge));
    spec.edges.push({ id: "e4", source: "post", target: "done" });
    const onConfig = renderInspector(spec, "post");
    expect(screen.queryByRole("button", { name: "Data from earlier steps" })).toBeNull();

    const url = screen.getByRole("textbox", { name: /^URL/ });
    url.focus();
    act(() => setCaretOffset(url, "https://example.com/".length));
    fireEvent.click(screen.getAllByRole("button", { name: "Insert a value from the run" })[0]);
    expect(screen.getByRole("group", { name: "Ask AI" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Fetch page" })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("nodes.ask.output.text"));
    expect(onConfig.mock.lastCall?.[0]).toMatchObject({ url: "https://example.com/{{nodes.ask.output.text}}" });
  });

  it("leaves out Advanced on a trigger", () => {
    renderInspector(linear(), "start");
    expect(screen.queryByRole("button", { name: /^Advanced/ })).toBeNull();
  });

  it("keeps Advanced (the internal id only) on a step others read by id", () => {
    renderInspector(linear(), "fetch");
    const advanced = screen.getByRole("button", { name: /^Advanced/ });
    expect(advanced).toHaveAccessibleName(/^Advanced$/);
    fireEvent.click(advanced);
    expect(screen.getByText("fetch")).toBeInTheDocument();
    expect(screen.queryByText(/Save to a variable/)).toBeNull();
  });

  it("hides it on an end step too", () => {
    renderInspector(linear(), "done");
    expect(screen.queryByRole("button", { name: /^Advanced/ })).toBeNull();
  });

  it("offers a looped step run by run after a loop, and finds a later run by search", () => {
    const onConfig = renderInspector(looped(), "after");
    fireEvent.click(screen.getAllByRole("button", { name: "Insert a value from the run" })[0]);
    const fetch = within(screen.getByRole("group", { name: "Fetch page" }));
    expect(fetch.getByText("Last run")).toBeInTheDocument();
    expect(fetch.getByText("Runs")).toBeInTheDocument();
    expect(fetch.getByText("Every run")).toBeInTheDocument();
    expect(fetch.getByText("Run 5")).toBeInTheDocument();
    expect(fetch.queryByText("Run 7")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search data" }), { target: { value: "run 7" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Fetch page" })).getByTitle("nodes.fetch.outputs.6"));
    expect(JSON.stringify(onConfig.mock.lastCall?.[0])).toContain("{{nodes.fetch.outputs.6}}");
  });

  it("lists every variable in the picker, even one written after this step", () => {
    renderInspector(linear(), "fetch");
    fireEvent.click(screen.getAllByRole("button", { name: "Insert a value from the run" })[0]);
    expect(within(screen.getByRole("group", { name: "Variables" })).getByText("facts")).toBeInTheDocument();
  });
});
