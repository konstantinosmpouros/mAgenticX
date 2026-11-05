// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workflow builder as a page (plan 38, step 3): a new workflow starts
 * empty (no name, no steps; the user adds the trigger from the palette, and
 * the checks ask for both); a palette click adds a step after the selected one (and
 * connects them); the inspector edits its schema-generated form; Create runs
 * the server's validate, creates, and moves to the edit route without
 * remounting or reloading; a later Save reports the new version; a 422 is
 * placed in the Issues menu; Delete asks first (inside the page). React Flow
 * is a light stand-in that renders the shared node card.
 */

const api = vi.hoisted(() => ({
  getWorkflowCatalog: vi.fn(),
  validateWorkflow: vi.fn(async () => ({ ok: true, errors: [] })),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(async () => undefined),
  getWorkflow: vi.fn(),
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

vi.mock("@xyflow/react", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  type MockNode = {
    id: string;
    type: string;
    data: unknown;
    ariaLabel?: string;
    selected?: boolean;
  };
  /** Every selection the stand-in reported, in order (the real one's SelectionListener). */
  const reported: string[][] = [];
  const ReactFlow = ({
    nodes,
    nodeTypes,
    onSelectionChange,
    onPaneContextMenu,
    onNodeContextMenu,
  }: {
    onPaneContextMenu?: (event: React.MouseEvent) => void;
    onNodeContextMenu?: (event: React.MouseEvent, node: MockNode) => void;
    nodes: MockNode[];
    nodeTypes: Record<
      string,
      (props: { id: string; data: unknown; selected?: boolean }) => JSX.Element
    >;
    onSelectionChange?: (selection: { nodes: MockNode[]; edges: unknown[] }) => void;
  }) => {
    // As React Flow's SelectionListener: report the nodes it holds as
    // selected whenever they change *or the handler changes identity*. Its
    // copy of the nodes is a render behind a pick the builder makes itself.
    const picked = nodes.filter((node) => node.selected);
    const pickedKey = picked.map((node) => node.id).join(",");
    useEffect(() => {
      reported.push(picked.map((node) => node.id));
      onSelectionChange?.({ nodes: picked, edges: [] });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pickedKey, onSelectionChange]);
    return (
      <div data-testid="react-flow" onContextMenu={(event) => onPaneContextMenu?.(event)}>
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
              onClick={() => onSelectionChange?.({ nodes: [node], edges: [] })}
              onContextMenu={(event) => {
                event.stopPropagation();
                onNodeContextMenu?.(event, node);
              }}
            >
              <NodeView id={node.id} data={node.data} />
            </div>
          );
        })}
      </div>
    );
  };
  return {
    __reported: reported,
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: JSX.Element }) => children,
    useReactFlow: () => ({
      fitView: async () => true,
      deleteElements: vi.fn(),
      screenToFlowPosition: (point: { x: number; y: number }) => point,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setCenter: vi.fn(),
      setViewport: vi.fn(),
    }),
    useInternalNode: () => undefined,
    applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
    applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
    Handle: () => null,
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: JSX.Element }) => children,
    getBezierPath: () => ["", 0, 0],
    Controls: () => null,
    ControlButton: () => null,
    Background: () => null,
    ConnectionLineType: { Bezier: "default" },
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    BackgroundVariant: { Dots: "dots" },
  };
});

import catalog from "./fixtures/workflow-catalog.json";
import WorkflowBuilderPage from "@/features/workflows/components/builder/WorkflowBuilderPage";
import { workflowEditPath, workflowPath } from "@/features/workflows/lib/routes";
import { ApiError } from "@/shared/lib/http";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { PALETTE_OPEN_STORAGE_KEY } from "@/features/workflows/lib/builder/consts";
import { kindBlurb, kindMeta } from "@/features/workflows/lib/kinds";
import { SidebarProvider, useSidebar } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Workflow, WorkflowSpec } from "@/shared/lib/types";

const saved = (spec: WorkflowSpec, version: number): Workflow => ({
  id: "wf-9",
  name: spec.name,
  description: null,
  spec,
  latestVersionNo: version,
  createdAt: null,
  updatedAt: null,
});

const spies = { onSaved: vi.fn(), onDeleted: vi.fn(), onExit: vi.fn(), onOpenView: vi.fn() };

/** The route view, minus the shell: params in, navigation out. */
function Route_() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  return (
    <WorkflowBuilderPage
      workflowId={workflowId ?? null}
      onSaved={spies.onSaved}
      onCreated={(id) => navigate(workflowEditPath(id), { replace: true })}
      onOpenView={spies.onOpenView}
      onDeleted={spies.onDeleted}
      onExit={spies.onExit}
    />
  );
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <Routes>
            <Route path="/workflows/new" element={<Route_ />} />
            <Route path="/workflows/:workflowId/edit" element={<Route_ />} />
          </Routes>
          <Where />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function SidebarState() {
  return <p data-testid="sidebar-state">{useSidebar().state}</p>;
}

/** The builder beside a probe of the sidebar's state; `leave()` unmounts the builder alone. */
function renderLeavable(sidebarOpen: boolean) {
  const tree = (builder: boolean) => (
    <MemoryRouter initialEntries={["/workflows/new"]}>
      <TooltipProvider>
        <SidebarProvider defaultOpen={sidebarOpen}>
          <Routes>
            <Route path="/workflows/new" element={builder ? <Route_ /> : <p>left</p>} />
          </Routes>
          <SidebarState />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>
  );
  const view = render(tree(true));
  return { leave: () => view.rerender(tree(false)) };
}

const canvas = () => screen.findByTestId("react-flow");
const drawerEl = () => screen.queryByTestId("workflow-inspector-drawer");
const node = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
  api.getWorkflowCatalog.mockResolvedValue(catalog);
  api.validateWorkflow.mockResolvedValue({ ok: true, errors: [] });
  document.cookie = "mx_csrf=tok";
  window.localStorage.clear();
  // The palette is shut by default; these tests work in it.
  window.localStorage.setItem(PALETTE_OPEN_STORAGE_KEY, "true");
});

/** The user starts the workflow: the trigger from the palette (picked once added). */
async function addTrigger() {
  fireEvent.click(await screen.findByRole("button", { name: "Add Manual trigger" }));
  await waitFor(() => expect(node("trigger")).not.toBeNull());
}

const nameIt = (name: string) =>
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: name } });

async function buildFetchAfterTrigger() {
  await canvas();
  await screen.findByRole("button", { name: "Add HTTP request" });
  await addTrigger();
  nameIt("Poller");
  // Pick the trigger, then add a step: it goes after it, connected.
  fireEvent.click(node("trigger")!);
  fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
  await waitFor(() => expect(node("fetch")).not.toBeNull());
  const url = await screen.findByLabelText(/^URL/);
  fireEvent.change(url, { target: { value: "https://example.com/{{input.x}}" } });
}

describe("workflow builder page", () => {
  it("creates a workflow, then saves new versions on the same builder", async () => {
    let created: WorkflowSpec | null = null;
    api.createWorkflow.mockImplementation(async (_user: string, spec: WorkflowSpec) => {
      created = spec;
      return saved(spec, 1);
    });
    renderAt("/workflows/new");
    await buildFetchAfterTrigger();
    // `input.x` is not declared: the Issues menu says so at once.
    fireEvent.keyDown(screen.getByRole("button", { name: /issue/ }), { key: "Enter" });
    expect(await screen.findAllByText(/undeclared input 'x'/)).not.toHaveLength(0);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.change(await screen.findByLabelText(/^URL/), {
      target: { value: "https://example.com/a" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledTimes(1));
    expect(api.validateWorkflow).toHaveBeenCalled();
    const sent = created as unknown as WorkflowSpec;
    expect(sent.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["trigger", "trigger.manual"],
      ["fetch", "fetch"],
    ]);
    expect(sent.nodes[1].config).toEqual({ url: "https://example.com/a" });
    expect(sent.edges).toEqual([{ id: "e1", source: "trigger", target: "fetch", branch: null }]);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/workflows/wf-9/edit"),
    );
    expect(spies.onSaved).toHaveBeenCalled();
    // Same builder: nothing reloaded, the step still there, Save (not Create) now.
    expect(api.getWorkflow).not.toHaveBeenCalled();
    expect(node("fetch")).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();

    api.updateWorkflow.mockImplementation(async (_user: string, _id: string, spec: WorkflowSpec) =>
      saved(spec, 2),
    );
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Poll" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateWorkflow).toHaveBeenCalledTimes(1));
    expect(api.updateWorkflow.mock.calls[0][1]).toBe("wf-9");
    expect((api.updateWorkflow.mock.calls[0][2] as WorkflowSpec).nodes[1].label).toBe("Poll");
    expect(await screen.findByText("v2")).toBeInTheDocument();
  });

  it("moves the pick to a step added after another, once (no bounce back to the old pick)", async () => {
    const reported = ((await import("@xyflow/react")) as unknown as { __reported: string[][] })
      .__reported;
    renderAt("/workflows/new");
    await canvas();
    await screen.findByRole("button", { name: "Add HTTP request" });
    await addTrigger();
    fireEvent.click(node("trigger")!);
    await screen.findByTestId("workflow-inspector-drawer");
    reported.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    await waitFor(() => expect(node("fetch")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 300));
    // React Flow's stale "trigger" was never handed back: the pick went to the new step and stayed.
    expect(reported.filter((ids) => ids.join() === "trigger")).toEqual([]);
    expect(reported.at(-1)).toEqual(["fetch"]);
    expect(
      within(screen.getByTestId("workflow-inspector-drawer")).getByRole("heading", {
        name: "fetch",
      }),
    ).toBeInTheDocument();
  });

  it("places a 422's issues in the Issues menu and stays put", async () => {
    api.createWorkflow.mockRejectedValue(
      new ApiError("The workflow is invalid.", {
        status: 422,
        detailObject: {
          message: "The workflow is invalid.",
          errors: [
            { nodeId: "fetch", path: "nodes[1].config.url", message: "The URL is refused." },
          ],
        },
      }),
    );
    renderAt("/workflows/new");
    await canvas();
    await screen.findByRole("button", { name: "Add HTTP request" });
    await addTrigger();
    nameIt("Poller");
    fireEvent.click(node("trigger")!);
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    fireEvent.change(await screen.findByLabelText(/^URL/), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalled());
    expect(await screen.findAllByText("The URL is refused.")).not.toHaveLength(0);
    expect(screen.getByTestId("where").textContent).toBe("/workflows/new");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("refuses to save with client errors and goes to the first one", async () => {
    renderAt("/workflows/new");
    await canvas();
    await screen.findByRole("button", { name: "Add HTTP request" });
    // Added with nothing picked: unconnected, and its URL is empty.
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    await waitFor(() => expect(node("fetch")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(within(node("fetch")!).getByTestId("workflow-node-issues-fetch")).toBeInTheDocument(),
    );
    expect(api.createWorkflow).not.toHaveBeenCalled();
    expect(api.validateWorkflow.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("opens a saved workflow for editing and deletes it after a confirm in the page", async () => {
    const spec: WorkflowSpec = {
      version: 1,
      name: "Nightly",
      description: "",
      inputs: [],
      state: [],
      nodes: [
        { id: "start", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [],
    };
    api.getWorkflow.mockResolvedValue(saved(spec, 3));
    renderAt("/workflows/wf-9/edit");
    await canvas();
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Nightly");
    expect(screen.getByText("v3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(spies.onOpenView).toHaveBeenCalledWith("wf-9");

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete workflow/ }));
    const dialog = await screen.findByRole("dialog");
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workflow" }));
    await waitFor(() => expect(api.deleteWorkflow).toHaveBeenCalledWith("u1", "wf-9"));
    await waitFor(() => expect(spies.onDeleted).toHaveBeenCalled());
  });

  it("places a step dropped from the palette without opening the drawer; a click on it does", async () => {
    renderAt("/workflows/new");
    await canvas();
    const data = new Map<string, string>([["application/x-magenticx-workflow-kind", "trigger.manual"]]);
    const dataTransfer = { types: [...data.keys()], getData: (type: string) => data.get(type) ?? "" };
    fireEvent.drop(screen.getByTestId("workflow-canvas"), { dataTransfer, clientX: 200, clientY: 200 });
    await waitFor(() => expect(node("trigger")).not.toBeNull());
    expect(drawerEl()).toBeNull();
    fireEvent.click(node("trigger")!);
    expect(await screen.findByTestId("workflow-inspector-drawer")).toBeInTheDocument();
  });

  it("opens the inspector as a drawer on a pick, and closes it with × or Esc", async () => {
    renderAt("/workflows/new");
    await canvas();
    // Nothing picked: no drawer at all (nothing of it left at the canvas's edge).
    expect(drawerEl()).toBeNull();
    await addTrigger();

    fireEvent.click(node("trigger")!);
    const drawer = await screen.findByTestId("workflow-inspector-drawer");
    expect(drawer).toHaveAttribute("data-state", "open");
    expect(within(drawer).getByText("Edit the step")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close the inspector" }));
    await waitFor(() => expect(drawerEl()).toBeNull());

    fireEvent.click(node("trigger")!);
    const again = await screen.findByTestId("workflow-inspector-drawer");
    fireEvent.keyDown(within(again).getByRole("button", { name: "Close the inspector" }), {
      key: "Escape",
    });
    await waitFor(() => expect(drawerEl()).toBeNull());
  });

  it("deletes any step, a trigger too, from its card; the inspector has no delete of its own", async () => {
    renderAt("/workflows/new");
    await canvas();
    await addTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Add Manual trigger" }));
    await waitFor(() => expect(node("trigger_2")).not.toBeNull());
    expect(within(screen.getByTestId("workflow-inspector-drawer")).queryByRole("button", { name: /Delete step/ })).toBeNull();
    fireEvent.click(within(node("trigger_2")!).getByRole("button", { name: /^Delete / }));
    await waitFor(() => expect(node("trigger_2")).toBeNull());
    fireEvent.click(within(node("trigger")!).getByRole("button", { name: /^Delete / }));
    await waitFor(() => expect(node("trigger")).toBeNull());
  });

  it("autosaves unsaved edits and offers them back; Restore puts them on the canvas", async () => {
    const key = "workflow-draft:u1:new";
    const first = renderAt("/workflows/new");
    await canvas();
    await addTrigger();
    nameIt("Half done");
    await waitFor(() => expect(window.localStorage.getItem(key)).not.toBeNull(), { timeout: 2000 });
    first.unmount();

    renderAt("/workflows/new");
    await canvas();
    const banner = await screen.findByTestId("workflow-restore-banner");
    expect(banner).toHaveTextContent(/Restore unsaved changes from/);
    // Nothing on the canvas until the user says so.
    expect(node("trigger")).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(node("trigger")).not.toBeNull());
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Half done");
    await waitFor(() => expect(screen.queryByTestId("workflow-restore-banner")).toBeNull());
    // Restored is unsaved work: still a draft, and Undo goes back to the empty start.
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("Discard forgets the stored draft; a save clears it; an untouched workflow stores nothing", async () => {
    const key = "workflow-draft:u1:new";
    window.localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        spec: { version: 1, name: "Old", description: "", inputs: [], state: [], nodes: [], edges: [] },
      }),
    );
    const first = renderAt("/workflows/new");
    await canvas();
    fireEvent.click(within(await screen.findByTestId("workflow-restore-banner")).getByRole("button", { name: "Discard" }));
    expect(window.localStorage.getItem(key)).toBeNull();
    // Opened and left untouched: nothing written.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(window.localStorage.getItem(key)).toBeNull();
    first.unmount();

    api.createWorkflow.mockImplementation(async (_user: string, spec: WorkflowSpec) => saved(spec, 1));
    renderAt("/workflows/new");
    await buildFetchAfterTrigger();
    fireEvent.change(await screen.findByLabelText(/^URL/), { target: { value: "https://example.com/a" } });
    await waitFor(() => expect(window.localStorage.getItem(key)).not.toBeNull(), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(window.localStorage.getItem("workflow-draft:u1:wf-9")).toBeNull();
  });

  it("leaves nothing of a shut drawer in the canvas frame, which clips", async () => {
    renderAt("/workflows/new");
    await canvas();
    const frame = screen.getByTestId("workflow-canvas-frame");
    // Clipped, and no scroll container: nothing inside can scroll it sideways.
    expect(frame.className).toMatch(/\boverflow-clip\b/);
    fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
    await screen.findByTestId("workflow-inspector-drawer");
    fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
    await waitFor(() => expect(drawerEl()).toBeNull());
    // No region, no close button, no inspector left behind (hidden or not).
    expect(within(frame).queryByRole("region", { name: "Inspector", hidden: true })).toBeNull();
    expect(
      within(frame).queryByRole("button", { name: "Close the inspector", hidden: true }),
    ).toBeNull();
    expect(within(frame).queryByLabelText("Edit the selection")).toBeNull();
  });

  it("opens the workflow's settings from the top bar; a pick takes the drawer over", async () => {
    renderAt("/workflows/new");
    await canvas();
    expect(drawerEl()).toBeNull();
    const settings = screen.getByRole("button", { name: "Workflow settings" });
    expect(settings).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(settings);
    const drawer = await screen.findByTestId("workflow-inspector-drawer");
    expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer).getByText("Workflow settings")).toBeInTheDocument();

    await addTrigger();
    fireEvent.click(node("trigger")!);
    await waitFor(() => expect(within(drawerEl()!).getByText("Edit the step")).toBeInTheDocument());
    expect(settings).toHaveAttribute("aria-pressed", "false");

    // Settings again: the pick is dropped, the settings show; once more closes the drawer.
    fireEvent.click(settings);
    await waitFor(() =>
      expect(within(drawerEl()!).getByText("Workflow settings")).toBeInTheDocument(),
    );
    fireEvent.click(settings);
    await waitFor(() => expect(drawerEl()).toBeNull());
  });

  it("shows each kind in the palette with its accent tile, label and description", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    try {
      renderAt("/workflows/new");
      await canvas();
      const palette = screen.getByTestId("workflow-palette");
      const fetch = await within(palette).findByRole("button", { name: "Add HTTP request" });
      const info = catalog.find((entry) => entry.kind === "fetch")!;
      expect(within(fetch).getByText(info.label)).toBeInTheDocument();
      // The row shows the short blurb; the catalogue's full description is the tooltip's.
      expect(within(fetch).getByText(kindBlurb(info.kind, info.description))).toBeInTheDocument();
      // The kind's tile carries its family and accent from `kindMeta`.
      const tile = fetch.querySelector<HTMLElement>("[data-kind-category]")!;
      const meta = kindMeta("fetch");
      expect(tile.dataset.kindCategory).toBe(meta.category);
      expect(tile.style.getPropertyValue("--wf-accent")).toBe(meta.accent);
      // Grouped under headings, in the palette's order.
      expect(within(palette).getByRole("region", { name: "Triggers" })).toBeInTheDocument();
      // A new workflow is an empty canvas that says to start with a trigger;
      // the trigger is a step like any other (no lock), added from the palette.
      expect(screen.getByTestId("workflow-canvas-empty")).toHaveTextContent("Start with a trigger");
      const trigger = within(palette).getByRole("button", { name: "Add Manual trigger" });
      expect(trigger).toHaveAttribute("draggable", "true");
      expect(trigger).not.toHaveAttribute("aria-disabled");
      fireEvent.click(trigger);
      expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
      expect(screen.queryByTestId("workflow-canvas-empty")).toBeNull();
      // The search narrows the list; a miss says so and offers to clear.
      fireEvent.change(within(palette).getByRole("searchbox", { name: "Search steps" }), {
        target: { value: "zzz-none" },
      });
      expect(within(palette).getByText(/No step matches/)).toBeInTheDocument();
      fireEvent.click(within(palette).getAllByRole("button", { name: "Clear the search" })[0]);
      expect(within(palette).getByRole("button", { name: "Add HTTP request" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("opens the steps from the canvas's Steps button, shut by default, and remembers it", async () => {
    window.localStorage.removeItem(PALETTE_OPEN_STORAGE_KEY);
    const first = renderAt("/workflows/new");
    await canvas();
    // Shut: no rail, no list; one button over the canvas (and one in the empty canvas's hint).
    expect(screen.queryByTestId("workflow-palette")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add HTTP request" })).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-palette-open"));
    const palette = await screen.findByTestId("workflow-palette");
    // Straight to the full list, grouped and searchable.
    expect(within(palette).getByRole("region", { name: "Triggers" })).toBeInTheDocument();
    expect(within(palette).getByRole("searchbox", { name: "Search steps" })).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-palette-open")).toBeNull();
    expect(window.localStorage.getItem(PALETTE_OPEN_STORAGE_KEY)).toBe("true");
    first.unmount();

    // A new visit keeps it open; its close button shuts it (and remembers that).
    renderAt("/workflows/new");
    await canvas();
    fireEvent.click(within(screen.getByTestId("workflow-palette")).getByRole("button", { name: "Close the steps" }));
    await waitFor(() => expect(screen.queryByTestId("workflow-palette")).toBeNull());
    expect(window.localStorage.getItem(PALETTE_OPEN_STORAGE_KEY)).toBe("false");
    // The empty canvas's hint opens it too.
    fireEvent.click(within(screen.getByTestId("workflow-canvas-empty")).getByRole("button", { name: "Open the steps" }));
    expect(await screen.findByTestId("workflow-palette")).toBeInTheDocument();
  });

  it("has no Tidy up button; a right-click on the canvas offers the graph's actions", async () => {
    renderAt("/workflows/new");
    await canvas();
    expect(screen.queryByRole("button", { name: "Tidy up" })).toBeNull();
    await addTrigger();

    // On a step: edit, duplicate, delete.
    fireEvent.contextMenu(node("trigger")!);
    let menu = await screen.findByTestId("workflow-canvas-menu");
    expect(within(menu).getByRole("menuitem", { name: /Edit step/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(node("trigger_2")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("workflow-canvas-menu")).toBeNull());

    // On the empty canvas: Tidy up (saying what it does), fit, select all, undo, clear.
    fireEvent.contextMenu(screen.getByTestId("react-flow"));
    menu = await screen.findByTestId("workflow-canvas-menu");
    expect(within(menu).getByRole("menuitem", { name: /Tidy up/ })).toHaveTextContent("Line the steps up, left to right");
    expect(within(menu).getByRole("menuitem", { name: /Fit to view/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Select all/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Clear canvas/ }));
    // Asked first.
    const dialog = await screen.findByRole("dialog");
    expect(node("trigger")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear canvas" }));
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0));

    // And Undo (from the menu) brings it back.
    fireEvent.contextMenu(screen.getByTestId("react-flow"));
    menu = await screen.findByTestId("workflow-canvas-menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Undo/ }));
    await waitFor(() => expect(node("trigger")).not.toBeNull());
    expect(node("trigger_2")).not.toBeNull();
  });

  it("on a phone, shows Settings once (under the canvas), not in the top bar too", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    try {
      renderAt("/workflows/new");
      await canvas();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Workflow settings" })).toBeNull());
      expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Add step" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("collapses the app sidebar while the builder is open and restores it on leave", async () => {
    const page = renderLeavable(true);
    await canvas();
    expect(screen.getByTestId("sidebar-state").textContent).toBe("collapsed");
    page.leave();
    await waitFor(() => expect(screen.getByTestId("sidebar-state").textContent).toBe("expanded"));
  });

  it("leaves a sidebar the user had collapsed collapsed", async () => {
    const page = renderLeavable(false);
    await canvas();
    expect(screen.getByTestId("sidebar-state").textContent).toBe("collapsed");
    page.leave();
    await waitFor(() => expect(screen.getByTestId("sidebar-state").textContent).toBe("collapsed"));
  });

  it("links: edit and view routes", () => {
    expect(workflowEditPath("wf-9")).toBe("/workflows/wf-9/edit");
    expect(workflowPath("wf-9")).toBe("/workflows/wf-9");
  });
});
