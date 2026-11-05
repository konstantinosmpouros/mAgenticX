// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import catalogJson from "./fixtures/workflow-catalog.json";
import { NodePalette } from "@/features/workflows/components/builder/builder_parts/NodePalette";
import { SchemaForm } from "@/features/workflows/components/builder/builder_parts/SchemaForm";
import { ExecutionDetails } from "@/features/workflows/components/workflow_view_parts/ExecutionDetails";
import { kindBlurb, kindCategory, kindMeta } from "@/features/workflows/lib/kinds";
import { defaultConfig, fieldsFromSchema } from "@/features/workflows/lib/builder/schemaForm";
import { checkSpec, kindFields } from "@/features/workflows/lib/builder/validate";
import { templatePaths } from "@/features/workflows/lib/builder/templates";
import { reduceRunEvents } from "@/features/workflows/lib/runReducer";
import { WorkflowCatalogSchema } from "@/shared/lib/schemas";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { WorkflowNodeKindInfo, WorkflowRunEvent, WorkflowSpec } from "@/shared/lib/types";

/**
 * The four step kinds added after the first catalogue — `llm`, `set`, `wait`,
 * `code` — and the catalogue's `available` / `unavailableReason`: each kind's
 * look and blurb, an unavailable kind disabled in the palette and flagged by
 * the checks, the llm / set checks, the forms the `"x-widget"` hints pick
 * (code editor, JSON schema editor, state-write map), and an llm step's
 * streamed text in the run's details.
 */

const catalog = WorkflowCatalogSchema.parse(catalogJson) as WorkflowNodeKindInfo[];
const info = (kind: string): WorkflowNodeKindInfo => {
  const found = catalog.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no ${kind} in the fixture`);
  return found;
};
const REASON = "No sandbox runner is configured on this server.";
/** The fixture with `code` switched off, as a server without a sandbox sends it. */
const withoutSandbox = WorkflowCatalogSchema.parse(
  (catalogJson as Array<Record<string, unknown>>).map((entry) =>
    entry.kind === "code" ? { ...entry, available: false, unavailableReason: REASON } : entry,
  ),
) as WorkflowNodeKindInfo[];

const spec = (nodes: WorkflowSpec["nodes"], state: WorkflowSpec["state"] = []): WorkflowSpec => ({
  version: 1,
  name: "New kinds",
  inputs: [],
  state,
  nodes: [
    { id: "start", kind: "trigger.manual", config: {}, position: { x: 0, y: 0 } },
    ...nodes,
    { id: "done", kind: "end", config: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    ...["start", ...nodes.map((node) => node.id)].map((source, index, all) => ({
      id: `e${index}`,
      source,
      target: all[index + 1] ?? "done",
    })),
  ],
});
const node = (id: string, kind: string, config: Record<string, unknown>) => ({
  id,
  kind,
  config,
  position: { x: 0, y: 0 },
});

describe("catalogue fields", () => {
  it("reads available / unavailableReason, defaulting to available", () => {
    expect(info("llm")).toMatchObject({ available: true, unavailableReason: null });
    const [old] = WorkflowCatalogSchema.parse([{ kind: "wait", label: "Wait", configSchema: {} }]);
    expect(old).toMatchObject({ available: true, unavailableReason: null });
    expect(withoutSandbox.find((entry) => entry.kind === "code")).toMatchObject({
      available: false,
      unavailableReason: REASON,
    });
  });
});

describe("kind look", () => {
  it("gives each new kind its family, glyph and blurb", () => {
    expect(kindMeta("llm")).toMatchObject({ category: "llm", accent: "var(--primary-glow)" });
    expect(kindMeta("llm").icon.displayName).toBe("Sparkles");
    expect(kindMeta("code")).toMatchObject({ category: "code", accent: "var(--info)" });
    expect(kindMeta("code").icon.displayName).toBe("CodeXml");
    expect(kindCategory("set")).toBe("transform");
    expect(kindCategory("wait")).toBe("wait");
    // `agent` is still an agent; `llm` no longer is.
    expect(kindCategory("agent")).toBe("agent");
    expect(kindBlurb("llm")).toBe("Ask a model, get text or JSON");
    expect(kindBlurb("set")).toBe("Write values into state");
    expect(kindBlurb("wait")).toBe("Pause for a while");
    expect(kindBlurb("code")).toBe("Run Python in the sandbox");
  });

  it("offers each new kind's known output fields to later steps", () => {
    const paths = templatePaths(
      spec([node("ask", "llm", { prompt: "hi" }), node("run", "code", { code: "x" }), node("w", "wait", { seconds: 1 })]),
      "done",
    ).map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "nodes.ask.output.text",
        "nodes.ask.output.data",
        "nodes.run.output.stdout",
        "nodes.run.output.exitCode",
        "nodes.w.output.waitedSeconds",
      ]),
    );
  });
});

describe("palette", () => {
  const renderPalette = (kinds: readonly WorkflowNodeKindInfo[], onAdd = vi.fn()) => {
    render(
      <TooltipProvider>
        <NodePalette catalog={kinds} isLoading={false} error={null} onRetry={vi.fn()} onAdd={onAdd} />
      </TooltipProvider>,
    );
    return onAdd;
  };

  it("lists the new kinds under their groups and adds them on click", () => {
    const onAdd = renderPalette(catalog);
    expect(within(screen.getByRole("region", { name: "AI" })).getByRole("button", { name: "Add LLM" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tools" })).getByRole("button", { name: "Add Code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Code" }));
    expect(onAdd).toHaveBeenCalledWith("code");
    expect(screen.getByRole("button", { name: "Add Set state" })).toHaveTextContent("Write values into state");
  });

  it("shows an unavailable kind disabled: not draggable, a click adds nothing", () => {
    const onAdd = renderPalette(withoutSandbox);
    expect(screen.queryByRole("button", { name: "Add Code" })).toBeNull();
    const row = screen.getByRole("button", { name: "Add Code (unavailable)" });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAttribute("draggable", "false");
    expect(row).toHaveTextContent("Unavailable");
    expect(row).not.toHaveTextContent("Run Python in the sandbox");
    fireEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
    // The others still add.
    fireEvent.click(screen.getByRole("button", { name: "Add LLM" }));
    expect(onAdd).toHaveBeenCalledWith("llm");
  });
});

describe("client checks", () => {
  const issuesOn = (issues: ReturnType<typeof checkSpec>, nodeId: string) =>
    issues.filter((issue) => issue.nodeId === nodeId).map((issue) => [issue.field, issue.message]);

  it("flags a step whose kind the server can't run, with the reason", () => {
    const shape = spec([node("calc", "code", { code: "result = 1" })]);
    expect(issuesOn(checkSpec(shape, catalog), "calc")).toEqual([]);
    expect(issuesOn(checkSpec(shape, withoutSandbox), "calc")).toEqual([["kind", REASON]]);
  });

  it("asks for a schema when the llm step answers in JSON", () => {
    const ask = (config: Record<string, unknown>) => issuesOn(checkSpec(spec([node("ask", "llm", config)]), catalog), "ask");
    expect(ask({ prompt: "Summarise", output: "text" })).toEqual([]);
    expect(ask({ prompt: "Summarise", output: "json" })).toEqual([["config.json_schema", "Give the JSON output a schema."]]);
    expect(ask({ prompt: "Summarise", output: "json", json_schema: { type: "object" } })).toEqual([]);
    expect(ask({ output: "text" })).toEqual([["config.prompt", "Prompt is required."]]);
  });

  it("lets set write declared state fields only, and at least one", () => {
    const state: WorkflowSpec["state"] = [{ name: "count", type: "number", reducer: "overwrite" }];
    const put = (values: Record<string, unknown>) =>
      issuesOn(checkSpec(spec([node("put", "set", { values })], state), catalog), "put");
    expect(put({ count: "{{state.count}}" })).toEqual([]);
    expect(put({ count: "1", total: "2" })).toEqual([["config.values", "'total' is not a declared state field."]]);
    expect(put({})).toEqual([["config.values", "Add at least 1 entry."]]);
  });

  it("does not read the code step's code as templates, but does its inputs", () => {
    const issues = checkSpec(
      spec([node("calc", "code", { code: 'print("{{state.nope}}")', inputs: { n: "{{state.missing}}" } })]),
      catalog,
    );
    expect(issuesOn(issues, "calc")).toEqual([
      ["config.inputs", "'state.missing' reads an undeclared state field 'missing'."],
    ]);
  });

  it("checks wait's seconds against its range", () => {
    const wait = (seconds: unknown) => issuesOn(checkSpec(spec([node("w", "wait", { seconds })]), catalog), "w");
    expect(wait(5)).toEqual([]);
    expect(wait(601)).toEqual([["config.seconds", "Seconds is at most 600."]]);
  });
});

describe("x-widget forms", () => {
  const renderForm = (kind: string, config: Record<string, unknown>, stateNames: string[] = []) =>
    render(
      <SchemaForm
        nodeId="n1"
        fields={kindFields(info(kind))}
        config={config}
        onChange={vi.fn()}
        issues={[]}
        paths={[{ path: "input.topic", group: "input", hint: "string" }]}
        assignPaths={[]}
        barePaths={[]}
        stateNames={stateNames}
      />,
    );

  it("reads the hints, on the property or inside an optional's anyOf", () => {
    const widgets = (kind: string) =>
      Object.fromEntries(fieldsFromSchema(info(kind).configSchema).map((field) => [field.key, field.widget]));
    expect(widgets("llm")).toMatchObject({
      model: "enum",
      system: "textarea",
      prompt: "textarea",
      output: "enum",
      json_schema: "json",
      max_output_tokens: "number",
      timeout_seconds: "number",
      assign: "assign",
    });
    expect(widgets("code")).toMatchObject({ code: "code", inputs: "map", timeout_seconds: "number" });
    expect(widgets("set")).toMatchObject({ values: "assign" });
    // A hint only inside the anyOf branch counts too.
    const [nested] = fieldsFromSchema({
      properties: { src: { anyOf: [{ type: "string", "x-widget": "code" }, { type: "null" }], default: null } },
    });
    expect(nested).toMatchObject({ key: "src", widget: "code", templated: false });
    expect(defaultConfig(info("code").configSchema)).toEqual({ code: "" });
  });

  it("edits code in a monospace area with no path helper, and Tab indents", () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        nodeId="n1"
        fields={kindFields(info("code"))}
        config={{ code: "x = 1" }}
        onChange={onChange}
        issues={[]}
        paths={[{ path: "input.topic", group: "input", hint: "string" }]}
        assignPaths={[]}
        barePaths={[]}
        stateNames={[]}
      />,
    );
    const code = screen.getByLabelText(/^Code/) as HTMLTextAreaElement;
    expect(code.tagName).toBe("TEXTAREA");
    expect(code.className).toContain("font-mono");
    expect(code).toHaveAttribute("spellcheck", "false");
    expect(Number(code.getAttribute("rows"))).toBeGreaterThanOrEqual(10);
    // Only the inputs map offers the helper, not the code.
    const codeField = code.closest("div.space-y-5 > *") as HTMLElement;
    expect(within(codeField).queryByRole("button", { name: "Insert a value from the run" })).toBeNull();

    code.setSelectionRange(0, 0);
    fireEvent.keyDown(code, { key: "Tab" });
    expect(onChange.mock.lastCall?.[0]).toEqual({ code: "  x = 1" });
    // Escape hands Tab back to focus navigation.
    onChange.mockClear();
    fireEvent.keyDown(code, { key: "Escape" });
    fireEvent.keyDown(code, { key: "Tab" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("gives the llm prompt the path helper and its JSON schema the JSON editor", () => {
    renderForm("llm", { prompt: "Hi", output: "json", json_schema: { type: "object" } });
    const prompt = screen.getByLabelText(/^Prompt/);
    const promptField = prompt.closest("div.space-y-5 > *") as HTMLElement;
    expect(within(promptField).getByRole("button", { name: "Insert a value from the run" })).toBeInTheDocument();
    const schema = screen.getByLabelText(/^Json schema/) as HTMLTextAreaElement;
    expect(schema.tagName).toBe("TEXTAREA");
    expect(schema.className).toContain("font-mono");
    expect(JSON.parse(schema.value)).toEqual({ type: "object" });
    // The model is a choice of the allowed ids, the default marked.
    const model = screen.getByLabelText(/^Model/);
    expect(model).toBeInTheDocument();
  });

  it("edits set's values with the state-write editor", () => {
    renderForm("set", { values: { count: "1" } }, ["count", "total"]);
    expect(screen.getByText("Values")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add state write" })).toHaveLength(2);
  });
});

describe("llm run text", () => {
  it("folds the streamed text into the execution and shows it on Output", () => {
    const at = (seq: number, type: string, payload: Record<string, unknown>): WorkflowRunEvent => ({
      seq,
      type,
      nodeId: "ask",
      executionId: "ask#1",
      parentExecutionId: null,
      payload: {
        type,
        ...payload,
        workflow: { runId: "r1", nodeId: "ask", executionId: "ask#1", parentExecutionId: null, iteration: 1 },
      },
      createdAt: `2026-11-05T10:00:0${seq}Z`,
    });
    const view = reduceRunEvents([
      at(1, "STEP_STARTED", { stepName: "ask" }),
      at(2, "TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "The answer " }),
      at(3, "TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "is 42." }),
      at(4, "CUSTOM", {
        name: "workflow.node_output",
        value: { output: { text: "The answer is 42.", model: "openai:gpt-4o-mini" }, branch: null },
      }),
      at(5, "STEP_FINISHED", { stepName: "ask" }),
    ]);
    const execution = view.executions.find((entry) => entry.executionId === "ask#1");
    expect(execution?.text).toBe("The answer is 42.");
    render(<ExecutionDetails execution={execution!} label="Ask" kindLabel="LLM" onResume={vi.fn()} />);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("region", { name: "Streamed text" })).toHaveTextContent("The answer is 42.");
  });
});
