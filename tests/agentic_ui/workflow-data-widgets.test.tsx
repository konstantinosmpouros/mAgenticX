// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import catalogJson from "./fixtures/workflow-catalog.json";
import { NodeInspector } from "@/features/workflows/components/builder/builder_parts/NodeInspector";
import { SchemaForm } from "@/features/workflows/components/builder/builder_parts/SchemaForm";
import { draftReducer } from "@/features/workflows/lib/builder/draft";
import { slugFromLabel } from "@/features/workflows/lib/builder/ids";
import { fieldsToSchema, schemaToFields } from "@/features/workflows/lib/builder/jsonSchema";
import { defaultConfig } from "@/features/workflows/lib/builder/schemaForm";
import { contextPreview } from "@/features/workflows/lib/builder/stepData";
import { checkSpec, kindFields } from "@/features/workflows/lib/builder/validate";
import { WorkflowCatalogSchema } from "@/shared/lib/schemas";
import type { WorkflowNodeDef, WorkflowNodeKindInfo, WorkflowSpec } from "@/shared/lib/types";

/**
 * How data moves between steps in the builder: "Data from earlier steps"
 * (`context`), an llm step's "Conversation" (`memory` + `thread`), the
 * structured-output builder over `json_schema`, the ids those fields hold
 * kept in line on rename / delete, their checks, and the step id that
 * follows the label.
 */

const catalog = WorkflowCatalogSchema.parse(catalogJson) as WorkflowNodeKindInfo[];
const info = (kind: string): WorkflowNodeKindInfo => {
  const found = catalog.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no ${kind} in the fixture`);
  return found;
};

const node = (id: string, kind: string, config: Record<string, unknown> = {}, label: string | null = null): WorkflowNodeDef => ({
  id,
  kind,
  label,
  config,
  position: { x: 0, y: 0 },
});

/** start → fetch → extract → summarize → calc → done. */
function graph(overrides: Record<string, Record<string, unknown>> = {}, extraEdges: WorkflowSpec["edges"] = []): WorkflowSpec {
  const nodes = [
    node("start", "trigger.manual"),
    node("fetch", "fetch", { url: "https://example.test" }, "Fetch page"),
    node("extract", "llm", { prompt: "Pull the facts" }, "Extract facts"),
    node("summarize", "llm", { prompt: "Summarise", context: { mode: "previous", count: 3, steps: [] }, memory: "continue", thread: "" }, "Summarize"),
    node("calc", "code", { code: "result = 1" }, "Crunch"),
    node("done", "end"),
  ].map((entry) => (overrides[entry.id] ? { ...entry, config: { ...entry.config, ...overrides[entry.id] } } : entry));
  const ids = nodes.map((entry) => entry.id);
  return {
    version: 1,
    name: "Data",
    inputs: [],
    nodes,
    edges: [
      ...ids.slice(0, -1).map((source, index) => ({ id: `e${index}`, source, target: ids[index + 1] })),
      ...extraEdges,
    ],
  };
}

const configOf = (spec: WorkflowSpec, id: string) => spec.nodes.find((entry) => entry.id === id)?.config ?? {};

function renderForm(spec: WorkflowSpec, nodeId: string, onChange = vi.fn()) {
  const target = spec.nodes.find((entry) => entry.id === nodeId)!;
  const view = render(
    <SchemaForm
      nodeId={nodeId}
      fields={kindFields(info(target.kind))}
      config={target.config}
      onChange={onChange}
      issues={[]}
      paths={[]}
      barePaths={[]}
      spec={spec}
    />,
  );
  return { onChange, view };
}

const lastConfig = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.lastCall?.[0] as Record<string, unknown>;

describe("slugFromLabel", () => {
  const none = new Set<string>();
  it("lower-cases, joins words with _ and trims symbols", () => {
    expect(slugFromLabel("Summarize news!", "llm", none)).toBe("summarize_news");
    expect(slugFromLabel("  --Fetch // page??  ", "fetch", none)).toBe("fetch_page");
  });
  it("transliterates Greek, accents included", () => {
    expect(slugFromLabel("Σύνοψη ειδήσεων", "llm", none)).toBe("synopsi_eidiseon");
    expect(slugFromLabel("Ούζο & Ψάρι", "llm", none)).toBe("ouzo_psari");
    expect(slugFromLabel("Χρόνος ΆΩ", "llm", none)).toBe("chronos_ao");
  });
  it("falls back to the kind's stem when empty or not starting with a letter", () => {
    expect(slugFromLabel("", "trigger.manual", none)).toBe("trigger");
    expect(slugFromLabel("123 go", "llm", none)).toBe("llm");
    expect(slugFromLabel("!!!", "fetch", none)).toBe("fetch");
  });
  it("avoids taken ids and reserved names, and caps the length", () => {
    expect(slugFromLabel("Fetch page", "fetch", new Set(["fetch_page"]))).toBe("fetch_page_2");
    expect(slugFromLabel("State", "llm", none)).toBe("state_node");
    expect(slugFromLabel("Output", "llm", none)).toBe("output_node");
    expect(slugFromLabel("History", "llm", none)).toBe("history_node");
    expect(slugFromLabel("Conversations", "llm", none)).toBe("conversations_node");
    const long = slugFromLabel("word ".repeat(30), "llm", none);
    expect(long.length).toBeLessThanOrEqual(56);
    expect(long.endsWith("_")).toBe(false);
  });
});

describe("defaults", () => {
  it("starts a new llm / code step with context, memory and thread", () => {
    const context = { mode: "previous", count: 3, steps: [] };
    expect(defaultConfig(info("llm").configSchema)).toEqual({ prompt: "", memory: "continue", thread: "", context });
    expect(defaultConfig(info("code").configSchema)).toEqual({ code: "", context });
    // Never one shared default object between two nodes.
    expect(defaultConfig(info("llm").configSchema).context).not.toBe(defaultConfig(info("llm").configSchema).context);
  });
});

describe("Data from earlier steps", () => {
  it("offers the four modes and previews the step just before", () => {
    renderForm(graph(), "summarize");
    const group = screen.getByRole("radiogroup", { name: "Data from earlier steps" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Previous step",
      "Last steps",
      "Pick steps",
      "None",
    ]);
    expect(within(group).getByRole("radio", { name: "Previous step" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Sends: Extract facts.")).toBeInTheDocument();
  });

  it("says 'the step that ran just before' when several steps lead in", () => {
    const spec = graph({}, [{ id: "extra", source: "fetch", target: "summarize" }]);
    renderForm(spec, "summarize");
    expect(screen.getByText("Sends: the step that ran just before (Fetch page or Extract facts).")).toBeInTheDocument();
  });

  it("switches mode and steps the count for 'Last steps'", () => {
    const { onChange } = renderForm(graph(), "summarize");
    fireEvent.click(screen.getByRole("radio", { name: "Last steps" }));
    expect(lastConfig(onChange).context).toEqual({ mode: "last", count: 3, steps: [] });

    onChange.mockClear();
    renderForm(graph({ summarize: { context: { mode: "last", count: 3, steps: [] } } }), "summarize", onChange);
    expect(screen.getByText("Sends: the last 3 steps that ran (in a loop, every run of a step).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More steps" }));
    expect(lastConfig(onChange).context).toEqual({ mode: "last", count: 4, steps: [] });
  });

  it("picks upstream steps, kept in the order picked", () => {
    const { onChange } = renderForm(graph({ summarize: { context: { mode: "steps", count: 3, steps: ["extract"] } } }), "summarize");
    const list = screen.getByRole("list", { name: "Steps to send" });
    // Only steps before this one: no Crunch (after it), not itself.
    expect(within(list).queryByText("Crunch")).toBeNull();
    expect(within(list).queryByText("Summarize")).toBeNull();
    expect(within(list).getByRole("checkbox", { name: /Extract facts/ })).toBeChecked();
    fireEvent.click(within(list).getByRole("checkbox", { name: /Fetch page/ }));
    expect(lastConfig(onChange).context).toEqual({ mode: "steps", count: 3, steps: ["extract", "fetch"] });
    expect(screen.getByText("Sends: Extract facts.")).toBeInTheDocument();
  });

  it("previews each mode as one line", () => {
    const spec = graph();
    expect(contextPreview(spec, "summarize", { mode: "steps", count: 3, steps: ["extract", "fetch"] })).toBe(
      "Sends: Extract facts, Fetch page.",
    );
    expect(contextPreview(spec, "summarize", { mode: "last", count: 1, steps: [] })).toBe(
      "Sends: the last step that ran (in a loop, every run of it).",
    );
    expect(contextPreview(spec, "summarize", { mode: "none", count: 3, steps: [] })).toBe("Sends nothing from earlier steps.");
    expect(contextPreview(spec, "start", { mode: "previous", count: 3, steps: [] })).toBe("Nothing leads into this step yet.");
  });

  it("tells a code step where the data arrives", () => {
    renderForm(graph({ calc: { context: { mode: "previous", count: 3, steps: [] } } }), "calc");
    expect(screen.getByText(/in input\.json/)).toBeInTheDocument();
    expect(screen.getByText("Sends: Summarize.")).toBeInTheDocument();
  });
});

describe("Conversation", () => {
  it("shows memory as radio cards, not a separate select", () => {
    const { onChange } = renderForm(graph(), "summarize");
    expect(screen.queryByRole("combobox", { name: /^Memory/ })).toBeNull();
    const memory = screen.getByRole("radiogroup", { name: "Memory" });
    expect(within(memory).getByRole("radio", { name: /Remember earlier turns/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(memory).getByRole("radio", { name: /Start fresh every time/ }));
    expect(lastConfig(onChange).memory).toBe("fresh");
  });

  it("shares with another llm step by id and says who shares it", () => {
    const spec = graph({ summarize: { thread: "extract" } });
    renderForm(spec, "summarize");
    expect(screen.getByRole("combobox", { name: "Share with" })).toHaveTextContent("Extract facts");
    expect(screen.getByText(/Shared with:/)).toHaveTextContent("Shared with: Extract facts");
  });

  it("offers 'This step only' by default, and shows the sharer on the shared step", () => {
    const spec = graph({ summarize: { thread: "extract" } });
    renderForm(spec, "extract");
    expect(screen.getByRole("combobox", { name: "Share with" })).toHaveTextContent("This step only");
    expect(screen.getByText(/Shared with:/)).toHaveTextContent("Shared with: Summarize");
  });
});

describe("structured output builder", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string", description: "Headline" }, score: { type: "number" } },
    required: ["title"],
    additionalProperties: false,
  };

  it("round-trips a flat schema", () => {
    const fields = schemaToFields(schema);
    expect(fields).toEqual([
      { name: "title", type: "string", description: "Headline", required: true },
      { name: "score", type: "number", description: "", required: false },
    ]);
    expect(fieldsToSchema(fields!)).toEqual(schema);
    expect(schemaToFields(null)).toEqual([]);
    expect(schemaToFields({ type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } })).toBeNull();
    expect(schemaToFields({ $ref: "#/$defs/X" })).toBeNull();
  });

  it("edits fields and writes the schema", () => {
    const { onChange } = renderForm(graph({ summarize: { output: "json", json_schema: schema } }), "summarize");
    expect(screen.getByLabelText("Reply field 1 name")).toHaveValue("title");
    expect(screen.getByRole("switch", { name: "Reply field 1 required" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Reply field 2 required" })).toHaveAttribute("aria-checked", "false");
    fireEvent.change(screen.getByLabelText("Reply field 2 name"), { target: { value: "rank" } });
    expect(lastConfig(onChange).json_schema).toEqual({
      type: "object",
      properties: { title: { type: "string", description: "Headline" }, rank: { type: "number" } },
      required: ["title"],
      additionalProperties: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByLabelText("Reply field 3 name")).toHaveValue("");
  });

  it("opens a schema it can't show in JSON, with a note", () => {
    const nested = { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } };
    renderForm(graph({ summarize: { output: "json", json_schema: nested } }), "summarize");
    expect(screen.getByText(/opens as JSON/)).toBeInTheDocument();
    const editor = screen.getByLabelText(/^Reply format/) as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual(nested);
    expect(screen.getByRole("button", { name: "Use the builder" })).toBeDisabled();
  });

  it("is hidden while the step answers in text", () => {
    renderForm(graph({ summarize: { output: "text" } }), "summarize");
    expect(screen.queryByText("Reply format")).toBeNull();
  });
});

describe("rename and delete", () => {
  const shared = graph({
    summarize: { context: { mode: "steps", count: 3, steps: ["extract", "fetch"] }, thread: "extract" },
  });

  it("renames ids in context.steps and thread", () => {
    const next = draftReducer(shared, { type: "rename-node", from: "extract", to: "facts" });
    expect(configOf(next, "summarize").context).toEqual({ mode: "steps", count: 3, steps: ["facts", "fetch"] });
    expect(configOf(next, "summarize").thread).toBe("facts");
  });

  it("drops a deleted step from context.steps and clears a thread naming it", () => {
    const next = draftReducer(shared, { type: "remove", nodeIds: ["extract"], edgeIds: [] });
    expect(configOf(next, "summarize").context).toEqual({ mode: "steps", count: 3, steps: ["fetch"] });
    expect(configOf(next, "summarize").thread).toBe("");
  });
});

describe("checks", () => {
  const issuesOn = (spec: WorkflowSpec, id: string, field: string) =>
    checkSpec(spec, catalog)
      .filter((issue) => issue.nodeId === id && issue.field === field)
      .map((issue) => issue.message);

  it("flags picked steps that don't exist or are the step itself", () => {
    const spec = graph({ summarize: { context: { mode: "steps", count: 3, steps: ["ghost", "summarize", "fetch"] } } });
    expect(issuesOn(spec, "summarize", "config.context.steps")).toEqual([
      "'ghost' is not a step in this workflow.",
      "A step can't use its own output as context.",
    ]);
    // A leftover list is ignored outside "Pick steps", as the engine does.
    const leftover = graph({ summarize: { context: { mode: "previous", count: 3, steps: ["ghost"] } } });
    expect(issuesOn(leftover, "summarize", "config.context.steps")).toEqual([]);
  });

  it("checks the count's range", () => {
    const spec = graph({ summarize: { context: { mode: "last", count: 11, steps: [] } } });
    expect(issuesOn(spec, "summarize", "config.context")).toEqual(["Send between 1 and 10 steps."]);
  });

  it("reserves `steps` in a code step's inputs while it is sent context", () => {
    const message = "'steps' is reserved for the data from earlier steps.";
    expect(issuesOn(graph({ calc: { inputs: { steps: "x" } } }), "calc", "config.inputs.steps")).toEqual([message]);
    expect(
      issuesOn(graph({ calc: { inputs: { steps: "x" }, context: { mode: "none", count: 3, steps: [] } } }), "calc", "config.inputs.steps"),
    ).toEqual([]);
  });

  it("needs a shared thread to name an llm step", () => {
    expect(issuesOn(graph({ summarize: { thread: "fetch" } }), "summarize", "config.thread")).toEqual([
      "'fetch' is not an LLM step in this workflow.",
    ]);
    expect(issuesOn(graph({ summarize: { thread: "extract" } }), "summarize", "config.thread")).toEqual([]);
  });
});

describe("inspector: the id follows the label", () => {
  it("renames on blur, rewriting references, and shows the id under Advanced", () => {
    let spec = graph({
      calc: { inputs: { s: "{{nodes.summarize.output.text}}" } },
      extract: { thread: "summarize" },
    });
    let selected = "summarize";
    const onRename = vi.fn((to: string) => {
      spec = draftReducer(spec, { type: "rename-node", from: selected, to });
      selected = to;
    });
    const onLabel = vi.fn((label: string) => {
      spec = draftReducer(spec, { type: "update-node", id: selected, patch: { label } });
    });
    const tree = () => {
      const current = spec.nodes.find((entry) => entry.id === selected)!;
      return (
        <NodeInspector
          key={selected}
          node={current}
          info={info(current.kind)}
          spec={spec}
          issues={[]}
          onRename={onRename}
          onLabel={onLabel}
          onConfig={vi.fn()}
        />
      );
    };
    const view = render(tree());
    expect(screen.queryByLabelText(/^Step id/)).toBeNull();

    const label = screen.getByLabelText("Label");
    fireEvent.focus(label);
    fireEvent.change(label, { target: { value: "Σύντομη περίληψη" } });
    view.rerender(tree());
    // Typing alone never renames.
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText("Label"));
    expect(onRename).toHaveBeenCalledWith("syntomi_perilipsi");
    view.rerender(tree());

    expect(configOf(spec, "calc").inputs).toEqual({ s: "{{nodes.syntomi_perilipsi.output.text}}" });
    expect(configOf(spec, "extract").thread).toBe("syntomi_perilipsi");
    expect(spec.edges.some((edge) => edge.source === "syntomi_perilipsi")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    expect(screen.getByText("syntomi_perilipsi", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Internal id:/)).toBeInTheDocument();
  });

  it("does not rename when the label is committed unchanged", () => {
    const spec = graph();
    const onRename = vi.fn();
    const current = spec.nodes.find((entry) => entry.id === "fetch")!;
    render(
      <NodeInspector node={current} info={info("fetch")} spec={spec} issues={[]} onRename={onRename} onLabel={vi.fn()} onConfig={vi.fn()} />,
    );
    const label = screen.getByLabelText("Label");
    fireEvent.focus(label);
    fireEvent.keyDown(label, { key: "Enter" });
    fireEvent.blur(label);
    expect(onRename).not.toHaveBeenCalled();
  });
});
