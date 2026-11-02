// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The builder's "Try it" (plan 40 P3): the panel opens from the bar, a message
 * sends the draft as it is now (with the approval choices and the saved
 * agent's id), a later message after an edit carries the new draft under a
 * "Draft changed" marker, the builder's own rules block a send, Reset deletes
 * the trial conversation, and the server's 422 shows in the panel. The bridge
 * is mocked; React Flow is swapped for a light stand-in as in the page test.
 */

const api = vi.hoisted(() => ({
  getAgentModels: vi.fn(async () => [{ id: "openai:gpt-5", label: "GPT-5", default: true }]),
  getBuiltinTools: vi.fn(async () => [
    { name: "write_file", description: "Create a file.", group: "Filesystem", hitlDefault: true, locked: false, gateable: true, mainOnly: false },
  ]),
  getTools: vi.fn(async () => []),
  getAgentTools: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  validateMyAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  renderMyAgentYaml: vi.fn(async () => "name: X\n"),
  setAgentToolApprovals: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  startAgentTrial: vi.fn(),
  resetAgentTrial: vi.fn(async () => undefined),
  cancelInferenceRun: vi.fn(),
  connectInferenceWebSocket: vi.fn(async () => undefined),
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

// The markdown renderer pulls a stylesheet Node can't load; plain text stands in.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
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
            data-id={node.id}
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
// Loaded up front: the builder lazy-loads the panel, and a cold load can outlast findBy's wait.
import "@/features/agents/components/builder/TryItPanel";
import type { AgentsPageContext } from "@/features/agents/context";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";
import { ApiError } from "@/shared/lib/http";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Agent } from "@/shared/lib/types";

const saved: Agent = {
  id: "c9",
  name: "Market Researcher",
  description: "",
  icon: (() => null) as unknown as Agent["icon"],
  isActive: true,
  kind: "custom",
};

const detail = {
  id: "c9",
  slug: "market-researcher",
  name: "Market Researcher",
  description: "",
  icon: "Bot",
  version: "1.0.0",
  type: "deep agent",
  spec: { slug: "market-researcher", name: "Market Researcher", prompt: "./AGENT.md", model: { main: "openai:gpt-5" } },
  files: [{ path: "AGENT.md", content: "You research.", encoding: "utf-8" as const }],
};

const userAgents = (over: Partial<UserAgentsHandlers> = {}): UserAgentsHandlers => ({
  myAgents: [],
  loadingMyAgents: false,
  refreshMyAgents: vi.fn(async () => {}),
  getAgentDefinition: vi.fn(async () => null),
  validateAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  createAgent: vi.fn(async () => saved),
  updateAgent: vi.fn(async () => saved),
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

function renderAt(path: string, ctx: AgentsPageContext = context()) {
  const view = render(
    <SidebarProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/agents" element={<Outlet context={ctx} />}>
              <Route path="new" element={<AgentBuilderPage mode="create" />} />
              <Route path=":agentId/edit" element={<AgentBuilderPage mode="edit" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </SidebarProvider>,
  );
  return { ctx, view };
}

const message = (id: string, sender: "user" | "ai", content: string, parent: string | null) => ({
  id,
  sender,
  content,
  parentMessageId: parent,
  created_at: new Date(),
  updated_at: new Date(),
  attachments: [],
});

/** A start's answer for turn `n`, the run already finished (no socket needed). */
const started = (n: number, question: string, answer: string) => {
  const user = message(`q${n}`, "user", question, n > 1 ? `a${n - 1}` : null);
  const reply = message(`a${n}`, "ai", answer, user.id);
  return {
    detail: { id: "t1", title: "Trial", messages: [user, reply] },
    summary: { id: "t1", title: "Trial", isPrivate: true },
    run: {
      id: `r${n}`,
      userId: "u1",
      conversationId: "t1",
      assistantMessageId: reply.id,
      parentMessageId: user.id,
      status: "completed",
      messagePath: [user.id, reply.id],
      rawEvents: [],
      content: answer,
      startedAt: new Date(),
      updatedAt: new Date(),
    },
    message: reply,
  };
};

const fill = async () => {
  fireEvent.change(await screen.findByRole("textbox", { name: "Agent name" }), {
    target: { value: "Market Researcher" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Instructions/ }));
  fireEvent.change(await screen.findByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "You research." },
  });
};

const openTryIt = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Try it" }));
  return screen.findByRole("dialog", { name: "Try it" });
};

const sendFrom = async (panel: HTMLElement, text: string) => {
  const box = within(panel).getByRole("textbox", { name: "Message the draft" });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
};

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("Try it", () => {
  it("opens the panel from the bar", async () => {
    renderAt("/agents/new?via=canvas");
    await screen.findByRole("textbox", { name: "Agent name" });
    const panel = await openTryIt();
    expect(within(panel).getByText(/Runs the uncommitted draft/)).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Message the draft" })).toBeInTheDocument();
  });

  it("sends the current draft, then the edited one under a Draft changed marker", async () => {
    api.startAgentTrial
      .mockResolvedValueOnce(started(1, "Hi", "First answer"))
      .mockResolvedValueOnce(started(2, "Again", "Second answer"));
    renderAt("/agents/new?via=canvas");
    await fill();
    const panel = await openTryIt();

    await sendFrom(panel, "Hi");
    expect(await within(panel).findByText("First answer")).toBeInTheDocument();
    expect(api.startAgentTrial).toHaveBeenCalledTimes(1);
    const [owner, first] = api.startAgentTrial.mock.calls[0];
    expect(owner).toBe("u1");
    expect(first).toMatchObject({ agentId: null, conversationId: null, message: "Hi", approvals: {} });
    expect(first.draft.spec).toMatchObject({ slug: "market-researcher", name: "Market Researcher" });
    expect(first.draft.files).toEqual([
      expect.objectContaining({ path: "AGENT.md", content: "You research." }),
    ]);
    expect(within(panel).queryByText("Draft changed")).toBeNull();
    // The composer cleared once the message went.
    expect(within(panel).getByRole("textbox", { name: "Message the draft" })).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
      target: { value: "You research, briefly." },
    });
    await sendFrom(panel, "Again");
    expect(await within(panel).findByText("Second answer")).toBeInTheDocument();
    const [, second] = api.startAgentTrial.mock.calls[1];
    expect(second).toMatchObject({ conversationId: "t1", message: "Again" });
    expect(second.draft.files).toEqual([
      expect.objectContaining({ path: "AGENT.md", content: "You research, briefly." }),
    ]);
    expect(within(panel).getAllByText("Draft changed")).toHaveLength(1);
  });

  it("sends the saved agent's id and says it uses its real memory", async () => {
    api.startAgentTrial.mockResolvedValueOnce(started(1, "Hi", "From the saved agent"));
    const handlers = userAgents({ getAgentDefinition: vi.fn(async () => detail) });
    renderAt("/agents/c9/edit", context({ agents: [saved], userAgents: handlers }));
    await screen.findByRole("textbox", { name: "Agent name" });
    const panel = await openTryIt();
    expect(within(panel).getByText(/real memory/)).toBeInTheDocument();
    await sendFrom(panel, "Hi");
    await within(panel).findByText("From the saved agent");
    expect(api.startAgentTrial.mock.calls[0][1]).toMatchObject({ agentId: "c9" });
  });

  it("doesn't send past a builder issue, and takes the user to it", async () => {
    renderAt("/agents/new?via=canvas");
    await screen.findByRole("textbox", { name: "Agent name" });
    const panel = await openTryIt();
    await sendFrom(panel, "Hi");
    expect(api.startAgentTrial).not.toHaveBeenCalled();
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/Fix this first/);
    expect(screen.getAllByText("Give the agent a name.").length).toBeGreaterThan(0);
    // The panel stays open, the text kept.
    expect(within(panel).getByRole("textbox", { name: "Message the draft" })).toHaveValue("Hi");
  });

  it("Reset deletes the trial conversation and clears the chat", async () => {
    api.startAgentTrial.mockResolvedValueOnce(started(1, "Hi", "First answer"));
    renderAt("/agents/new?via=canvas");
    await fill();
    const panel = await openTryIt();
    await sendFrom(panel, "Hi");
    await within(panel).findByText("First answer");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Reset" }));
    });
    expect(api.resetAgentTrial).toHaveBeenCalledWith("u1", "t1");
    expect(within(panel).queryByText("First answer")).toBeNull();
  });

  it("deletes the trial conversation when the builder is left", async () => {
    api.startAgentTrial.mockResolvedValueOnce(started(1, "Hi", "First answer"));
    const { view } = renderAt("/agents/new?via=canvas");
    await fill();
    const panel = await openTryIt();
    await sendFrom(panel, "Hi");
    await within(panel).findByText("First answer");
    view.unmount();
    await waitFor(() => expect(api.resetAgentTrial).toHaveBeenCalledWith("u1", "t1"));
  });

  it("follows a live run on its socket and stops it", async () => {
    const live = started(1, "Hi", "");
    live.run.status = "running";
    api.startAgentTrial.mockResolvedValueOnce(live);
    api.connectInferenceWebSocket.mockImplementationOnce(() => new Promise(() => undefined));
    api.cancelInferenceRun.mockResolvedValueOnce({ ...live.run, status: "cancelled" });
    renderAt("/agents/new?via=canvas");
    await fill();
    const panel = await openTryIt();
    await sendFrom(panel, "Hi");
    expect(api.connectInferenceWebSocket).toHaveBeenCalledWith(
      "u1",
      "r1",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    await act(async () => {
      fireEvent.click(await within(panel).findByRole("button", { name: "Stop" }));
    });
    expect(api.cancelInferenceRun).toHaveBeenCalledWith("u1", "r1");
    expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("shows the server's 422 and places its issues", async () => {
    api.startAgentTrial.mockRejectedValueOnce(
      new ApiError("The agent definition is invalid.", {
        status: 422,
        detailObject: {
          message: "The agent definition is invalid.",
          errors: ["model.main: That model isn't allowed."],
          issues: [{ path: "model.main", message: "That model isn't allowed.", severity: "error" }],
        },
      }),
    );
    renderAt("/agents/new?via=canvas");
    await fill();
    const panel = await openTryIt();
    await sendFrom(panel, "Hi");
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "The agent definition is invalid.",
    );
    expect((await screen.findAllByText("That model isn't allowed.")).length).toBeGreaterThan(0);
    // The question did not stay in the transcript; it is still in the composer.
    expect(within(panel).getByText(/Send a message to try/)).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Message the draft" })).toHaveValue("Hi");
  });
});
