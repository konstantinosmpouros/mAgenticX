// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import catalogJson from "./fixtures/workflow-catalog.json";
import { typeTemplate } from "./templateField";

const api = vi.hoisted(() => ({ getWorkflowTools: vi.fn() }));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

import { SchemaForm } from "@/features/workflows/components/builder/builder_parts/SchemaForm";
import { resetWorkflowTools } from "@/features/workflows/hooks/useWorkflowTools";
import { fieldDomId } from "@/features/workflows/lib/builder/ids";
import {
  argFromText,
  groupTools,
  pruneArgs,
  toolArgProblems,
  toolArgs,
  toolNodeSubtitle,
} from "@/features/workflows/lib/builder/toolArgs";
import { checkSpec, kindFields } from "@/features/workflows/lib/builder/validate";
import { WorkflowCatalogSchema, WorkflowToolCatalogSchema } from "@/shared/lib/schemas";
import type { WorkflowNodeKindInfo, WorkflowSpec, WorkflowToolCatalog } from "@/shared/lib/types";

/**
 * The tool step's inspector: a searchable tool picker over
 * `GET /v1/workflows/tools` (grouped "Built-in" then by server), the picked
 * tool's required arguments shown as fields, optional ones added and removed
 * on demand, the arguments kept across a pick only where the new tool takes
 * them, the checks ("Pick a tool.", "'query' is required."), and the plain
 * map the arguments fall back to when the tool can't be found.
 */

const catalog = WorkflowCatalogSchema.parse(catalogJson) as WorkflowNodeKindInfo[];
const toolKind = catalog.find((entry) => entry.kind === "tool")!;

const TOOLS: WorkflowToolCatalog = WorkflowToolCatalogSchema.parse({
  mcpAvailable: true,
  tools: [
    {
      source: "native",
      name: "search_past_conversations",
      server: null,
      description: "Search your earlier chats.\nSecond line.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for" },
          limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: 5 },
        },
        required: ["query"],
      },
    },
    {
      source: "mcp",
      name: "tavily-search",
      server: "tavily",
      description: "Search the web.",
      inputSchema: {
        type: "object",
        $defs: { Depth: { type: "string", enum: ["basic", "advanced"] } },
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "number", description: "How many results" },
          search_depth: { $ref: "#/$defs/Depth" },
          include_images: { type: "boolean" },
          domains: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
    },
    { source: "mcp", name: "fetch", server: null, description: "", inputSchema: "not a schema" },
    { name: "" },
  ],
});

const tool = (name: string) => TOOLS.tools.find((entry) => entry.name === name)!;

/** The tool step's form, re-rendered with each write as the inspector does; `onChange` sees every write. */
const renderForm = (initial: Record<string, unknown>) => {
  const onChange = vi.fn();
  let config = initial;
  const form = () => (
    <SchemaForm
      nodeId="call"
      fields={kindFields(toolKind)}
      config={config}
      onChange={(next) => {
        config = next;
        onChange(next);
        view.rerender(form());
      }}
      issues={[]}
      paths={[]}
      barePaths={[]}
    />
  );
  const view = render(form());
  return onChange;
};

const lastConfig = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.lastCall?.[0] as Record<string, unknown>;

beforeEach(() => {
  resetWorkflowTools();
  api.getWorkflowTools.mockReset();
  api.getWorkflowTools.mockResolvedValue(TOOLS);
});

afterEach(() => {
  resetWorkflowTools();
});

describe("tool list → arguments (pure)", () => {
  it("reads the envelope loosely: rows without a name dropped, a bad schema read as none", () => {
    expect(TOOLS.mcpAvailable).toBe(true);
    expect(TOOLS.tools.map((entry) => entry.name)).toEqual(["search_past_conversations", "tavily-search", "fetch"]);
    expect(tool("fetch").inputSchema).toEqual({});
    expect(WorkflowToolCatalogSchema.parse({ mcpAvailable: false }).tools).toEqual([]);
  });

  it("reads each argument's type, required, choices and default", () => {
    expect(toolArgs(tool("tavily-search").inputSchema).map((arg) => [arg.name, arg.label, arg.type, arg.required])).toEqual([
      ["query", "Query", "string", true],
      ["maxResults", "Max results", "number", false],
      ["search_depth", "Search depth", "string", false],
      ["include_images", "Include images", "boolean", false],
      ["domains", "Domains", "array", false],
    ]);
    expect(toolArgs(tool("tavily-search").inputSchema)[2].options).toEqual(["basic", "advanced"]);
    const limit = toolArgs(tool("search_past_conversations").inputSchema)[1];
    expect(limit).toMatchObject({ type: "integer", required: false, hasDefault: true, default: 5 });
    expect(toolArgs({})).toEqual([]);
  });

  it("groups Built-in first, then each server (an unknown one under MCP), and searches", () => {
    expect(groupTools(TOOLS.tools).map((group) => [group.label, group.tools.map((entry) => entry.name)])).toEqual([
      ["Built-in", ["search_past_conversations"]],
      ["tavily", ["tavily-search"]],
      ["MCP", ["fetch"]],
    ]);
    expect(groupTools(TOOLS.tools, "web").map((group) => group.label)).toEqual(["tavily"]);
  });

  it("keeps only the arguments the new tool takes, and stores a number literal as a number", () => {
    expect(pruneArgs({ query: "x", limit: 3, junk: 1 }, tool("tavily-search"))).toEqual({ query: "x" });
    expect(argFromText("number", "2.5")).toBe(2.5);
    expect(argFromText("integer", "{{input.n}}")).toBe("{{input.n}}");
    expect(argFromText("string", "3")).toBe("3");
    expect(toolNodeSubtitle({ tool: { source: "mcp", name: "tavily-search" } })).toBe("tavily-search");
    expect(toolNodeSubtitle({})).toBeNull();
  });

  it("checks required arguments and number arguments", () => {
    expect(toolArgProblems(tool("tavily-search"), {})).toEqual([
      { field: "config.args.query", message: "'query' is required." },
    ]);
    expect(toolArgProblems(tool("tavily-search"), { query: "{{input.q}}", maxResults: "lots" })).toEqual([
      { field: "config.args.maxResults", message: "'maxResults' must be a number." },
    ]);
    expect(toolArgProblems(tool("tavily-search"), { query: "a", maxResults: "{{input.n}}" })).toEqual([]);
  });
});

describe("tool step checks", () => {
  const spec = (config: Record<string, unknown>): WorkflowSpec => ({
    version: 1,
    name: "Tools",
    inputs: [],
    nodes: [
      { id: "start", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
      { id: "call", kind: "tool", label: null, config, position: { x: 300, y: 0 } },
      { id: "done", kind: "end", label: null, config: {}, position: { x: 600, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "call", branch: null },
      { id: "e2", source: "call", target: "done", branch: null },
    ],
  });
  const onCall = (config: Record<string, unknown>, tools: WorkflowToolCatalog | null) =>
    checkSpec(spec(config), catalog, tools)
      .filter((issue) => issue.nodeId === "call")
      .map((issue) => [issue.field, issue.message]);

  it("asks for a tool, then for its required arguments once the tool list is in", () => {
    expect(onCall({}, TOOLS)).toEqual([["config.tool", "Pick a tool."]]);
    const picked = { tool: { source: "mcp", name: "tavily-search" } };
    expect(onCall(picked, TOOLS)).toEqual([["config.args.query", "'query' is required."]]);
    expect(onCall({ ...picked, args: { query: "cats" } }, TOOLS)).toEqual([]);
    // No tool list (not loaded, gateway down): the arguments are left to the server.
    expect(onCall(picked, null)).toEqual([]);
  });
});

describe("tool step inspector", () => {
  it("picks a tool from the grouped list, keeping only the arguments it takes", async () => {
    const onChange = renderForm({ args: { query: "news", limit: 3 } });
    fireEvent.click(await screen.findByRole("button", { name: /^Tool/ }));
    const list = await screen.findByRole("listbox", { name: "Tools" });
    expect(within(list).getByRole("group", { name: "Built-in" })).toBeTruthy();
    const server = within(list).getByRole("group", { name: "tavily" });
    // One line of description per row.
    expect(within(list).getByText("Search your earlier chats.")).toBeTruthy();
    fireEvent.click(within(server).getByRole("option", { name: /tavily-search/ }));
    expect(lastConfig(onChange)).toEqual({ tool: { source: "mcp", name: "tavily-search" }, args: { query: "news" } });
    // The picked tool's description under the picker; its required argument shown.
    expect(screen.getByText("Search the web.")).toBeTruthy();
    expect(document.getElementById(fieldDomId("call", "config.args.query"))).toBeTruthy();
  });

  it("searches the list", async () => {
    renderForm({});
    expect((await screen.findByRole("button", { name: /^Tool/ })).textContent).toContain("Choose a tool");
    fireEvent.click(await screen.findByRole("button", { name: /^Tool/ }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search tools" }), { target: { value: "earlier" } });
    const list = screen.getByRole("listbox", { name: "Tools" });
    expect(within(list).getAllByRole("option").map((row) => row.getAttribute("title"))).toEqual([
      "Search your earlier chats.\nSecond line.",
    ]);
  });

  it("shows required arguments; optional ones are added, filled and removed", async () => {
    const onChange = renderForm({ tool: { source: "mcp", name: "tavily-search" }, args: { query: "x" } });
    expect(await screen.findByText("Query")).toBeTruthy();
    expect(screen.getByText("Search query.")).toBeTruthy();
    expect(screen.queryByText("Max results")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add optional argument" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Max results/ }));
    const field = document.getElementById(fieldDomId("call", "config.args.maxResults"))!;
    expect(field).toBeTruthy();
    // Added, not filled: nothing written yet.
    expect(onChange).not.toHaveBeenCalled();
    typeTemplate(field, "7");
    expect(lastConfig(onChange).args).toEqual({ query: "x", maxResults: 7 });

    fireEvent.click(screen.getByRole("button", { name: "Remove Max results" }));
    expect(lastConfig(onChange).args).toEqual({ query: "x" });
    expect(document.getElementById(fieldDomId("call", "config.args.maxResults"))).toBeNull();
  });

  it("shows a stored argument the tool doesn't take, marked, with remove", async () => {
    const onChange = renderForm({ tool: { source: "mcp", name: "tavily-search" }, args: { query: "x", stale: 1 } });
    expect(await screen.findByText("unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove stale" }));
    expect(lastConfig(onChange).args).toEqual({ query: "x" });
  });

  it("falls back to the plain map when the tool isn't listed", async () => {
    renderForm({ tool: { source: "mcp", name: "gone" }, args: { q: "kept" } });
    expect(await screen.findByText("This tool isn't available any more. Pick another.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tool/ }).textContent).toContain("gone");
    expect((screen.getByLabelText("Entry 1 name") as HTMLInputElement).value).toBe("q");
  });

  it("keeps the tool and its arguments when the list can't be loaded", async () => {
    api.getWorkflowTools.mockReset();
    api.getWorkflowTools.mockRejectedValue(new Error("down"));
    renderForm({ tool: { source: "mcp", name: "tavily-search" }, args: { query: "kept" } });
    expect(await screen.findByText("The tool list couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText("tavily-search")).toBeTruthy();
    expect((screen.getByLabelText("Entry 1 name") as HTMLInputElement).value).toBe("query");
    api.getWorkflowTools.mockResolvedValue(TOOLS);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.getElementById(fieldDomId("call", "config.args.query"))).toBeTruthy());
  });
});
