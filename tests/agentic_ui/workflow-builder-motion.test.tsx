// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workflow builder's motion: the inspector drawer is an overlay (opening
 * or closing it never re-frames or moves the graph; a step under it is brought
 * into view once, after the slide); typing in the drawer, a tooltip, or the
 * server's verdict arriving moves nothing (no view call, no drawer remount,
 * only the edited step's card changes); the palette is an overlay too (its
 * fold never resizes the canvas or moves the graph), its groups fold and are
 * remembered; and a real resize of the canvas (the app sidebar, the window)
 * keeps the graph still on screen while a mere observer call does nothing.
 * React Flow is a stand-in whose view calls are spies.
 */

const api = vi.hoisted(() => ({
  getWorkflowCatalog: vi.fn(),
  validateWorkflow: vi.fn(async () => ({ ok: true, errors: [] })),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(async () => undefined),
  getWorkflow: vi.fn(),
}));

const view = vi.hoisted(() => ({
  viewport: { x: 10, y: 20, zoom: 1 },
  fitView: vi.fn(async () => true),
  setViewport: vi.fn(async () => true),
  setCenter: vi.fn(async () => true),
  /** Every `nodes` array React Flow was handed, in order. */
  nodeProps: [] as Array<Array<{ id: string }>>,
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

vi.mock("@xyflow/react", () => {
  type MockNode = { id: string; type: string; data: unknown };
  const ReactFlow = ({
    nodes,
    nodeTypes,
    onSelectionChange,
  }: {
    nodes: MockNode[];
    nodeTypes: Record<string, (props: { id: string; data: unknown }) => JSX.Element>;
    onSelectionChange?: (selection: { nodes: MockNode[]; edges: unknown[] }) => void;
  }) => {
    if (view.nodeProps[view.nodeProps.length - 1] !== nodes) view.nodeProps.push(nodes);
    return (
    <div data-testid="react-flow">
      {nodes.map((node) => {
        const NodeView = nodeTypes[node.type];
        return (
          <div
            key={node.id}
            className={`react-flow__node react-flow__node-${node.type}`}
            data-id={node.id}
            onClick={() => onSelectionChange?.({ nodes: [node], edges: [] })}
          >
            <NodeView id={node.id} data={node.data} />
          </div>
        );
      })}
    </div>
    );
  };
  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: JSX.Element }) => children,
    useReactFlow: () => ({
      fitView: view.fitView,
      setViewport: view.setViewport,
      setCenter: view.setCenter,
      getViewport: () => view.viewport,
      screenToFlowPosition: (point: { x: number; y: number }) => point,
      deleteElements: vi.fn(),
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
import { VALIDATE_DEBOUNCE_MS } from "@/features/workflows/hooks/useWorkflowValidation";
import { PALETTE_GROUPS_STORAGE_KEY } from "@/features/workflows/lib/builder/consts";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

// A ResizeObserver the test drives, and the canvas's box on screen.
const observers = new Set<{ callback: ResizeObserverCallback }>();
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this);
  }
}
const canvasBox = { left: 280, top: 60, width: 900, height: 700 };
const resizeAll = () => {
  for (const observer of [...observers]) observer.callback([], observer as unknown as ResizeObserver);
};

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={["/workflows/new"]}>
      <TooltipProvider>
        <SidebarProvider defaultOpen={false}>
          <Routes>
            <Route
              path="/workflows/new"
              element={
                <WorkflowBuilderPage
                  workflowId={null}
                  onSaved={() => {}}
                  onCreated={() => {}}
                  onOpenView={() => {}}
                  onDeleted={() => {}}
                  onExit={() => {}}
                />
              }
            />
          </Routes>
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A new workflow is an empty canvas: the user starts it with the trigger from
 * the palette (it is picked once added; the drawer is shut again here, and
 * the first step's framing settles, before a test measures anything).
 */
async function addTrigger() {
  fireEvent.click(await screen.findByRole("button", { name: "Add Manual trigger" }));
  await waitFor(() => expect(node("trigger")).not.toBeNull());
  const drawer = await screen.findByTestId("workflow-inspector-drawer");
  fireEvent.click(within(drawer).getByRole("button", { name: "Close the inspector" }));
  await waitFor(() => expect(screen.queryByTestId("workflow-inspector-drawer")).toBeNull());
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  observers.clear();
  Object.assign(canvasBox, { left: 280, top: 60, width: 900, height: 700 });
  view.viewport = { x: 10, y: 20, zoom: 1 };
  view.nodeProps = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== "workflow-canvas") return original.call(this);
    const { left, top, width, height } = canvasBox;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  });
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
  api.getWorkflowCatalog.mockResolvedValue(catalog);
  document.cookie = "mx_csrf=tok";
  window.localStorage.clear();
  // The palette is shut by default; these tests work in it.
  window.localStorage.setItem("magenticx:workflow-builder:palette-open", "true");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workflow builder motion", () => {
  it("opens and closes the drawer without re-framing or moving the graph", async () => {
    renderBuilder();
    await screen.findByTestId("react-flow");
    await addTrigger();
    view.fitView.mockClear();
    view.setViewport.mockClear();
    view.setCenter.mockClear();

    fireEvent.click(node("trigger")!);
    await screen.findByTestId("workflow-inspector-drawer");
    await settle();
    // Another step's content swaps in the open drawer: still nothing moves.
    fireEvent.click(node("trigger")!);
    fireEvent.click(within(screen.getByTestId("workflow-inspector-drawer")).getByRole("button", { name: "Close the inspector" }));
    await waitFor(() => expect(screen.queryByTestId("workflow-inspector-drawer")).toBeNull());
    await settle();

    expect(view.fitView).not.toHaveBeenCalled();
    expect(view.setViewport).not.toHaveBeenCalled();
    // At most one move to bring the picked step out from under the drawer,
    // made after the slide, never frame by frame.
    expect(view.setCenter.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("types 20 characters in an inspector field without moving the view or remounting the drawer", async () => {
    renderBuilder();
    await screen.findByTestId("react-flow");
    await screen.findByRole("button", { name: "Add HTTP request" });
    await addTrigger();
    fireEvent.click(node("trigger")!);
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    const drawer = await screen.findByTestId("workflow-inspector-drawer");
    const url = await within(drawer).findByLabelText(/^URL/);
    const body = within(drawer).getByRole("region", { name: "Inspector" }).firstElementChild;
    await settle();
    view.fitView.mockClear();
    view.setViewport.mockClear();
    view.setCenter.mockClear();
    const before = view.nodeProps[view.nodeProps.length - 1];
    const trigger = before.find((entry) => entry.id === "trigger");

    // 20 keystrokes, a comma inside a placeholder among them; the canvas's
    // observer fires along (content changing size inside it) with no resize.
    const text = "https://x.io/{{a,b}}";
    expect(text).toHaveLength(20);
    for (let index = 1; index <= text.length; index += 1) {
      fireEvent.change(url, { target: { value: text.slice(0, index) } });
      resizeAll();
    }
    // The server's verdict lands after its debounce: still nothing moves.
    await settle(VALIDATE_DEBOUNCE_MS + 200);
    resizeAll();

    expect(view.setViewport).not.toHaveBeenCalled();
    expect(view.setCenter).not.toHaveBeenCalled();
    expect(view.fitView).not.toHaveBeenCalled();
    // The same drawer, the same content element, the same field: nothing remounted.
    expect(screen.getByTestId("workflow-inspector-drawer")).toBe(drawer);
    expect(within(drawer).getByRole("region", { name: "Inspector" }).firstElementChild).toBe(body);
    expect(within(drawer).getByLabelText(/^URL/)).toBe(url);
    // A config edit shows on no card: the steps React Flow holds are the same objects.
    const after = view.nodeProps[view.nodeProps.length - 1];
    expect(after.find((entry) => entry.id === "trigger")).toBe(trigger);
  });

  it("puts a bad reference's issue under the field being typed in, not above the form", async () => {
    renderBuilder();
    await screen.findByRole("button", { name: "Add HTTP request" });
    await addTrigger();
    fireEvent.click(node("trigger")!);
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    const drawer = await screen.findByTestId("workflow-inspector-drawer");
    const url = await within(drawer).findByLabelText(/^URL/);
    fireEvent.change(url, { target: { value: "https://x.io/{{input.a,b}}" } });
    const issues = await waitFor(() => {
      const list = document.getElementById(`${url.id}-issues`);
      expect(list).not.toBeNull();
      return list!;
    });
    expect(issues.textContent).toMatch(/undeclared input 'a,b'/);
  });

  it("opens a tooltip in the palette with the drawer open without moving the view", async () => {
    renderBuilder();
    await screen.findByRole("button", { name: "Add HTTP request" });
    await addTrigger();
    fireEvent.click(node("trigger")!);
    await screen.findByTestId("workflow-inspector-drawer");
    await settle();
    view.fitView.mockClear();
    view.setViewport.mockClear();
    view.setCenter.mockClear();

    const toggle = screen.getByRole("button", { name: "Add Manual trigger" });
    fireEvent.pointerMove(toggle);
    fireEvent.focus(toggle);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    resizeAll();
    fireEvent.blur(toggle);
    const item = screen.getByRole("button", { name: "Add HTTP request" });
    fireEvent.pointerMove(item);
    fireEvent.focus(item);
    resizeAll();
    await settle(300);

    expect(view.setViewport).not.toHaveBeenCalled();
    expect(view.setCenter).not.toHaveBeenCalled();
    expect(view.fitView).not.toHaveBeenCalled();
  });

  it("opens and shuts the palette over the canvas: the canvas keeps its size, the graph stays", async () => {
    renderBuilder();
    await screen.findByTestId("react-flow");
    const frame = screen.getByTestId("workflow-canvas-frame");
    const palette = screen.getByTestId("workflow-palette");
    expect(palette.style.width).toBe("17rem");
    // The canvas takes the whole width: the palette lies over its left edge.
    expect(frame.style.marginLeft).toBe("");
    await settle();
    view.fitView.mockClear();
    view.setViewport.mockClear();
    view.setCenter.mockClear();

    fireEvent.click(within(palette).getByRole("button", { name: "Close the steps" }));
    await waitFor(() => expect(screen.queryByTestId("workflow-palette")).toBeNull());
    fireEvent.click(screen.getByTestId("workflow-palette-open"));
    expect(await screen.findByTestId("workflow-palette")).toBeInTheDocument();
    expect(frame.style.marginLeft).toBe("");
    resizeAll();
    await settle(300);

    expect(view.setViewport).not.toHaveBeenCalled();
    expect(view.setCenter).not.toHaveBeenCalled();
    expect(view.fitView).not.toHaveBeenCalled();
  });

  it("folds a palette group, remembers it, and opens it for a search", async () => {
    const first = renderBuilder();
    await screen.findByRole("button", { name: "Add HTTP request" });
    const palette = screen.getByTestId("workflow-palette");
    const heading = within(palette).getByRole("button", { name: "Data, 1 step" });
    expect(heading).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(within(palette).queryByRole("button", { name: "Add HTTP request" })).toBeNull());
    expect(JSON.parse(window.localStorage.getItem(PALETTE_GROUPS_STORAGE_KEY) ?? "[]")).toEqual(["data"]);
    first.unmount();

    // A new visit keeps the fold.
    renderBuilder();
    await screen.findByRole("button", { name: "Add Tool" });
    const again = screen.getByTestId("workflow-palette");
    expect(within(again).queryByRole("button", { name: "Add HTTP request" })).toBeNull();
    // A search opens every group with a match.
    const search = within(again).getByRole("searchbox", { name: "Search steps" });
    fireEvent.change(search, { target: { value: "http" } });
    expect(await within(again).findByRole("button", { name: "Add HTTP request" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(within(again).queryByRole("button", { name: "Add HTTP request" })).toBeNull());
  });

  it("keeps the graph still on a real canvas resize and ignores an observer call without one", async () => {
    renderBuilder();
    await screen.findByTestId("react-flow");
    // Past the first load's settling.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    view.fitView.mockClear();
    view.setViewport.mockClear();

    // The observer fires with the same box (content inside changed): nothing.
    resizeAll();
    // A sub-pixel wobble: nothing.
    Object.assign(canvasBox, { left: 280.3, width: 899.7 });
    resizeAll();
    expect(view.setViewport).not.toHaveBeenCalled();

    // The app sidebar folds: the canvas's edge moves 200px left as it widens.
    Object.assign(canvasBox, { left: 80, width: 1100 });
    resizeAll();
    expect(view.setViewport).toHaveBeenCalledTimes(1);
    expect(view.setViewport).toHaveBeenLastCalledWith({ x: 210, y: 20, zoom: 1 }, { duration: 0 });
    await settle(300);
    expect(view.fitView).not.toHaveBeenCalled();
  });

});
