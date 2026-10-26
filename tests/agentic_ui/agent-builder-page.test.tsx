// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The canvas builder as a page (plan 44 P3+P4): the start screen, building a
 * team on the canvas down to the third level, the restore banner, the leave
 * guard, the two-step save with Retry, and the YAML help with the server's
 * live lists. React Flow is swapped for a light stand-in that renders the
 * builder's own node components.
 */

const api = vi.hoisted(() => ({
  getAgentModels: vi.fn(async () => [
    { id: "openai:gpt-5", label: "GPT-5", default: true },
    { id: "openai:gpt-4o-mini", label: "GPT-4o mini", default: false },
  ]),
  getBuiltinTools: vi.fn(async () => [
    { name: "write_file", description: "Create a file.", group: "Filesystem", hitlDefault: true, locked: false, gateable: true, mainOnly: false },
    { name: "execute", description: "Run code.", group: "Execution", hitlDefault: true, locked: true, gateable: true, mainOnly: false },
    { name: "ask_user", description: "Ask you.", group: "Interaction", hitlDefault: false, locked: false, gateable: false, mainOnly: true },
  ]),
  getTools: vi.fn(async () => []),
  getAgentTools: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  validateMyAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  renderMyAgentYaml: vi.fn(async () => "name: X\n"),
  setAgentToolApprovals: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  importMyAgent: vi.fn(),
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

vi.mock("@xyflow/react", () => {
  type MockNode = { id: string; type: string; data: unknown; ariaLabel?: string };
  const ReactFlow = ({
    nodes,
    nodeTypes,
    onNodeClick,
  }: {
    nodes: MockNode[];
    nodeTypes: Record<string, (props: { id: string; data: unknown }) => JSX.Element>;
    onNodeClick?: (event: unknown, node: MockNode) => void;
  }) => (
    <div data-testid="react-flow">
      {nodes.map((node) => {
        const NodeView = nodeTypes[node.type];
        return (
          <div
            key={node.id}
            className={`react-flow__node react-flow__node-${node.type}`}
            data-id={node.id}
            tabIndex={0}
            role="group"
            aria-label={node.ariaLabel}
            onClick={(event) => onNodeClick?.(event, node)}
          >
            <NodeView id={node.id} data={node.data} />
          </div>
        );
      })}
    </div>
  );
  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: JSX.Element }) => children,
    useReactFlow: () => ({ fitView: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setCenter: vi.fn() }),
    Handle: () => null,
    Controls: () => null,
    Background: () => null,
    BaseEdge: () => null,
    getSmoothStepPath: () => [""],
    Position: { Top: "top", Bottom: "bottom" },
    BackgroundVariant: { Dots: "dots" },
  };
});

import AgentBuilderPage from "@/features/agents/pages/AgentBuilderPage";
import type { AgentsPageContext } from "@/features/agents/context";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";
import { draftStorageKey, writeStoredDraft } from "@/features/agents/lib/draftStorage";
import { emptyDraft } from "@/features/agents/lib/agentSpec";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Agent } from "@/shared/lib/types";

const created: Agent = {
  id: "c9",
  name: "Market Researcher",
  description: "",
  icon: (() => null) as unknown as Agent["icon"],
  isActive: true,
  kind: "custom",
};

const userAgents = (over: Partial<UserAgentsHandlers> = {}): UserAgentsHandlers => ({
  myAgents: [],
  loadingMyAgents: false,
  refreshMyAgents: vi.fn(async () => {}),
  getAgentDefinition: vi.fn(async () => null),
  validateAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  createAgent: vi.fn(async () => created),
  updateAgent: vi.fn(async () => created),
  deleteAgent: vi.fn(async () => true),
  busyAgentId: null,
  ...over,
});

const context = (over: Partial<AgentsPageContext> = {}): AgentsPageContext => ({
  userId: "u1",
  agents: [],
  mySkills: [],
  userAgents: userAgents(),
  refreshCatalog: vi.fn(async () => {}),
  onChatWith: vi.fn(),
  onSchedule: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(path: string, ctx: AgentsPageContext = context()) {
  render(
    <SidebarProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/agents" element={<Outlet context={ctx} />}>
              <Route index element={<p>Gallery</p>} />
              <Route path="new" element={<AgentBuilderPage mode="create" />} />
              <Route path=":agentId" element={<p>Agent page</p>} />
            </Route>
          </Routes>
          <Where />
        </MemoryRouter>
      </TooltipProvider>
    </SidebarProvider>,
  );
  return ctx;
}

const where = () => screen.getByTestId("where").textContent;
const canvasNode = (label: RegExp) =>
  screen.getAllByRole("group").find((el) => label.test(el.getAttribute("aria-label") ?? ""))!;

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("starting a new agent", () => {
  it("offers the canvas and an import, and opens the canvas", async () => {
    renderAt("/agents/new");
    expect(await screen.findByRole("button", { name: /Import a YAML/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start on the canvas/ }));
    expect(where()).toBe("/agents/new?via=canvas");
    expect(await screen.findByRole("textbox", { name: "Agent name" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add a sub-agent" })).toBeInTheDocument();
  });
});

describe("building a team on the canvas", () => {
  it("adds sub-agents three levels deep and no further", async () => {
    renderAt("/agents/new?via=canvas");
    fireEvent.click(await screen.findByRole("button", { name: "Add a sub-agent" }));
    expect(await screen.findByText(/Sub-agent · level 1 of 3/)).toBeInTheDocument();
    const name = await screen.findByPlaceholderText("fact-checker");
    fireEvent.change(name, { target: { value: "Researcher One" } });
    // The name keeps to the slug's shape as it is typed.
    expect(name).toHaveValue("researcher-one");

    fireEvent.click(screen.getByRole("button", { name: "Add a sub-agent under researcher-one" }));
    expect(await screen.findByText(/level 2 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a sub-agent under this sub-agent" }));
    expect(await screen.findByText(/level 3 of 3/)).toBeInTheDocument();

    const third = canvasNode(/level 3 of 3/);
    expect(within(third).queryByRole("button", { name: /Add a sub-agent under/ })).toBeNull();
    expect(within(third).getByLabelText(/Level 3 of 3/)).toBeInTheDocument();
    // …and the inspector says why.
    expect(await screen.findByText(/three levels is the most/)).toBeInTheDocument();
  });

  it("asks before deleting a node that has a team", async () => {
    renderAt("/agents/new?via=canvas");
    fireEvent.click(await screen.findByRole("button", { name: "Add a sub-agent" }));
    fireEvent.change(await screen.findByPlaceholderText("fact-checker"), { target: { value: "lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a sub-agent under lead" }));
    await screen.findByText(/level 2 of 3/);

    fireEvent.click(within(canvasNode(/^lead,/)).getByRole("button", { name: "Delete lead" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1 sub-agent below it/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Add a sub-agent" })).toBeInTheDocument();
  });
});

describe("unsaved work", () => {
  it("offers to restore what an earlier visit left, and restores it", async () => {
    writeStoredDraft(draftStorageKey("u1", null), { ...emptyDraft(), name: "Left Behind" }, Date.now());
    renderAt("/agents/new?via=canvas");
    expect(await screen.findByText(/Restore unsaved changes from/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("Left Behind");
    await waitFor(() => expect(screen.queryByText(/Restore unsaved changes from/)).toBeNull());
  });

  it("asks before leaving with unsaved changes", async () => {
    renderAt("/agents/new?via=canvas");
    fireEvent.change(await screen.findByRole("textbox", { name: "Agent name" }), {
      target: { value: "Half Done" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Leave without saving?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(where()).toBe("/agents/new?via=canvas");
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(where()).toBe("/agents"));
  });
});

describe("saving", () => {
  const fill = async () => {
    fireEvent.change(await screen.findByRole("textbox", { name: "Agent name" }), {
      target: { value: "Market Researcher" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Instructions/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: /^Instructions/ }), {
      target: { value: "You research." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Approvals/ }));
    const row = (await screen.findByRole("radiogroup", { name: /write_file/ })) as HTMLElement;
    fireEvent.click(within(row).getByRole("radio", { name: "Don't ask" }));
    expect(screen.getByText("This agent will write files without asking.")).toBeInTheDocument();
  };

  it("creates the agent, then saves the approval choices, and lands on its page", async () => {
    const ctx = renderAt("/agents/new?via=canvas");
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(where()).toBe("/agents/c9"));
    const [payload] = (ctx.userAgents.createAgent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.spec).toMatchObject({ slug: "market-researcher", name: "Market Researcher" });
    expect(payload.spec).not.toHaveProperty("hitl");
    expect(api.setAgentToolApprovals).toHaveBeenCalledWith("u1", "c9", { write_file: false });
  });

  it("stays on Approvals with Retry when the choices fail to save", async () => {
    api.setAgentToolApprovals.mockRejectedValueOnce(new Error("down"));
    const ctx = renderAt("/agents/new?via=canvas");
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/The agent is saved, but these choices aren/)).toBeInTheDocument();
    expect(where()).toBe("/agents/new?via=canvas&section=approvals");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(where()).toBe("/agents/c9"));
    // The agent was created once; Retry only re-sent the choices.
    expect(ctx.userAgents.createAgent).toHaveBeenCalledTimes(1);
    expect(api.setAgentToolApprovals).toHaveBeenCalledTimes(2);
  });

  it("doesn't save past a builder issue, and takes the user to it", async () => {
    const ctx = renderAt("/agents/new?via=canvas");
    await screen.findByRole("textbox", { name: "Agent name" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(ctx.userAgents.createAgent).not.toHaveBeenCalled();
    expect(await screen.findByText("Give the agent a name.")).toBeInTheDocument();
  });
});

describe("the YAML help", () => {
  it("opens beside the import with the live models and built-in tools", async () => {
    renderAt("/agents/new?via=import");
    fireEvent.click(await screen.findByRole("button", { name: /How to write an agent.yaml/ }));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByText("A complete example")).toBeInTheDocument();
    const models = await within(panel).findByLabelText("Allowed models");
    await waitFor(() => expect(within(models).getByText("openai:gpt-4o-mini")).toBeInTheDocument());
    const tools = within(panel).getByLabelText("Built-in tools");
    expect(within(tools).getByText("write_file")).toBeInTheDocument();
    expect(within(tools).getByText("always asks")).toBeInTheDocument();
    expect(within(tools).getByText("never asks")).toBeInTheDocument();
    expect(panel.querySelector("#yaml-help-subagents-tools")).not.toBeNull();
  });
});
