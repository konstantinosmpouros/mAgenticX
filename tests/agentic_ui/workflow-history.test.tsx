// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workflow builder's History panel: the `vN` badge opens it in the drawer
 * (nothing is loaded before); rows list the versions newest first with how
 * each came to be and its counts; opening one shows what it changed against
 * the version below (diffed client-side); Preview lays it read-only over the
 * canvas with a banner; Restore asks first — warning when the builder has
 * unsaved edits — and then loads the new latest version; a 422 lists its
 * issues in the panel. `?panel=history` (the view's link) opens it at once,
 * and the view header's History button and badge lead there.
 */

const api = vi.hoisted(() => ({
  getWorkflowCatalog: vi.fn(),
  validateWorkflow: vi.fn(async () => ({ ok: true, errors: [] })),
  getWorkflow: vi.fn(),
  listWorkflowVersions: vi.fn(),
  getWorkflowVersion: vi.fn(),
  restoreWorkflowVersion: vi.fn(),
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

vi.mock("@xyflow/react", async () => {
  type MockNode = { id: string; type: string; data: unknown; ariaLabel?: string };
  const ReactFlow = ({
    nodes,
    nodeTypes,
    className,
  }: {
    nodes: MockNode[];
    className?: string;
    nodeTypes: Record<string, (props: { id: string; data: unknown }) => JSX.Element>;
  }) => (
    <div data-testid="react-flow" data-flow-class={className}>
      {nodes.map((node) => {
        const NodeView = nodeTypes[node.type];
        return (
          <div key={node.id} className="react-flow__node" data-id={node.id} aria-label={node.ariaLabel}>
            <NodeView id={node.id} data={node.data} />
          </div>
        );
      })}
    </div>
  );
  return {
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
import { WorkflowHeader } from "@/features/workflows/components/workflow_view_parts/WorkflowHeader";
import { workflowEditPath, workflowHistoryPath } from "@/features/workflows/lib/routes";
import { ApiError } from "@/shared/lib/http";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Workflow, WorkflowSpec, WorkflowVersionSummary } from "@/shared/lib/types";

const spec = (name: string, extra = false): WorkflowSpec => ({
  version: 1,
  name,
  description: "",
  inputs: [],
  nodes: [
    { id: "start", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } },
    ...(extra
      ? [{ id: "done", kind: "end", label: "Finish", config: {}, position: { x: 240, y: 0 } }]
      : []),
  ],
  edges: extra ? [{ id: "e1", source: "start", target: "done", branch: null }] : [],
});

const V1 = spec("Nightly");
const V2 = spec("Nightly", true);
const V3 = spec("Nightly report", true);

const workflow = (s: WorkflowSpec, version: number): Workflow => ({
  id: "wf-9",
  name: s.name,
  description: null,
  spec: s,
  latestVersionNo: version,
  createdAt: null,
  updatedAt: null,
});

const row = (versionNo: number, s: WorkflowSpec, over: Partial<WorkflowVersionSummary> = {}): WorkflowVersionSummary => ({
  versionNo,
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "u1",
  restoredFrom: null,
  name: s.name,
  description: "",
  nodeCount: s.nodes.length,
  edgeCount: s.edges.length,
  ...over,
});

const SPECS: Record<number, WorkflowSpec> = { 1: V1, 2: V2, 3: V3 };

function Route_() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const panel = new URLSearchParams(window.location.search).get("panel");
  return (
    <WorkflowBuilderPage
      workflowId={workflowId ?? null}
      onSaved={vi.fn()}
      onCreated={(id) => navigate(workflowEditPath(id), { replace: true })}
      onOpenView={vi.fn()}
      onDeleted={vi.fn()}
      onExit={vi.fn()}
      initialPanel={panel === "history" ? "history" : null}
    />
  );
}

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <Routes>
            <Route path="/workflows/:workflowId/edit" element={<Route_ />} />
          </Routes>
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const drawer = () => screen.getByTestId("workflow-inspector-drawer");
const versionRow = (n: number) =>
  within(drawer()).getByRole("button", { name: new RegExp(`^Version ${n}\\b`) });

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
  api.getWorkflowCatalog.mockResolvedValue(catalog);
  api.validateWorkflow.mockResolvedValue({ ok: true, errors: [] });
  api.getWorkflow.mockResolvedValue(workflow(V3, 3));
  api.listWorkflowVersions.mockResolvedValue({
    items: [row(3, V3), row(2, V2), row(1, V1)],
    nextBefore: null,
  });
  api.getWorkflowVersion.mockImplementation(async (_u: string, _w: string, n: number) => ({
    versionNo: n,
    createdAt: "2026-11-01T10:00:00Z",
    createdBy: "u1",
    restoredFrom: null,
    spec: SPECS[n],
  }));
  document.cookie = "mx_csrf=tok";
  window.localStorage.clear();
});

describe("workflow builder History panel", () => {
  it("opens from the ⋯ menu only (no version badge) and lists the versions newest first, loading nothing before", async () => {
    renderAt("/workflows/wf-9/edit");
    await screen.findByLabelText("Workflow name");
    expect(screen.queryByTestId("workflow-version-badge")).toBeNull();
    expect(api.listWorkflowVersions).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Version history/ }));
    await waitFor(() => expect(api.listWorkflowVersions).toHaveBeenCalledWith("u1", "wf-9"));
    expect(within(drawer()).getByText("History")).toBeInTheDocument();
    const list = await within(drawer()).findByRole("list", { name: "Versions" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Version 3");
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[0]).toHaveTextContent("renamed “Nightly report”");
    expect(rows[1]).toHaveTextContent("2 steps, 1 connection (+1 step, +1 connection)");
    expect(rows[2]).toHaveTextContent("Created");
  });

  it("shows what an opened version changed, diffed against the one below", async () => {
    renderAt(workflowHistoryPath("wf-9"));
    await within(await screen.findByTestId("workflow-inspector-drawer")).findByRole("list", { name: "Versions" });
    fireEvent.click(versionRow(2));
    await waitFor(() => expect(api.getWorkflowVersion).toHaveBeenCalledWith("u1", "wf-9", 2));
    expect(api.getWorkflowVersion).toHaveBeenCalledWith("u1", "wf-9", 1);
    const steps = await within(drawer()).findByRole("region", { name: "Steps changed" });
    expect(steps).toHaveTextContent("Finish");
    expect(within(drawer()).getByRole("region", { name: "Connections changed" })).toHaveTextContent(
      "start → Finish",
    );
    expect(within(drawer()).getByText("Changes since version 1.")).toBeInTheDocument();

    fireEvent.click(versionRow(3));
    const details = await within(drawer()).findByRole("region", { name: "Details changed" });
    expect(details).toHaveTextContent("Nightly");
    expect(details).toHaveTextContent("Nightly report");
    // The current version offers no restore of itself (version 2's body animates out).
    await waitFor(() =>
      expect(within(drawer()).queryByRole("button", { name: "Restore this version" })).toBeNull(),
    );
  });

  it("previews a version read-only over the canvas, and goes back to editing", async () => {
    renderAt(workflowHistoryPath("wf-9"));
    await within(await screen.findByTestId("workflow-inspector-drawer")).findByRole("list", { name: "Versions" });
    fireEvent.click(versionRow(1));
    fireEvent.click(await within(drawer()).findByRole("button", { name: "Preview" }));

    const banner = await screen.findByTestId("workflow-preview-banner");
    expect(banner).toHaveTextContent("Previewing version 1");
    const overlay = await screen.findByTestId("workflow-preview-canvas");
    await waitFor(() => expect(within(overlay).getByTestId("react-flow")).toBeInTheDocument());
    // The editable draft stays mounted underneath, untouched.
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Nightly report");
    expect(within(drawer()).getByText("Previewing")).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Back to editing" }));
    await waitFor(() => expect(screen.queryByTestId("workflow-preview-canvas")).toBeNull());
  });

  it("restores after a confirmation that warns about unsaved edits, then loads the new version", async () => {
    api.restoreWorkflowVersion.mockResolvedValue(workflow(V1, 4));
    renderAt(workflowHistoryPath("wf-9"));
    await within(await screen.findByTestId("workflow-inspector-drawer")).findByRole("list", { name: "Versions" });
    // An unsaved edit.
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Edited" } });

    fireEvent.click(versionRow(1));
    fireEvent.click(await within(drawer()).findByRole("button", { name: "Restore this version" }));
    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    expect(dialog).toHaveTextContent("Restore version 1?");
    expect(dialog).toHaveTextContent("saved again as a new version (version 4)");
    expect(dialog).toHaveTextContent("Your unsaved changes in the builder will be discarded.");
    expect(api.restoreWorkflowVersion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and restore" }));
    await waitFor(() => expect(api.restoreWorkflowVersion).toHaveBeenCalledWith("u1", "wf-9", 1));
    await waitFor(() => expect(screen.getByLabelText("Workflow name")).toHaveValue("Nightly"));
    // The list is read again from the top.
    await waitFor(() => expect(api.listWorkflowVersions).toHaveBeenCalledTimes(2));
  });

  it("lists a refused restore's issues in the panel", async () => {
    api.restoreWorkflowVersion.mockRejectedValue(
      new ApiError("This version no longer passes today's checks, so it can't be restored.", {
        status: 422,
        detailObject: {
          message: "This version no longer passes today's checks, so it can't be restored.",
          errors: [{ nodeId: "poll", path: "nodes[1].config.url", message: "Unknown input nope." }],
        },
      }),
    );
    renderAt(workflowHistoryPath("wf-9"));
    await within(await screen.findByTestId("workflow-inspector-drawer")).findByRole("list", { name: "Versions" });
    fireEvent.click(versionRow(2));
    fireEvent.click(await within(drawer()).findByRole("button", { name: "Restore this version" }));
    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    const alert = await within(drawer()).findByRole("alert");
    expect(alert).toHaveTextContent("Version 2 could not be restored");
    expect(alert).toHaveTextContent("poll: Unknown input nope.");
  });
});

describe("the workflow view header", () => {
  it("opens the history from its ⋯ menu, with no version badge", async () => {
    const onHistory = vi.fn();
    render(
      <SidebarProvider defaultOpen>
        <WorkflowHeader name="Nightly" description={null} onRun={vi.fn()} onHistory={onHistory} />
      </SidebarProvider>,
    );
    expect(screen.queryByText("v3")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Version history/ }));
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it("offers Version history in the builder's ⋯ menu", async () => {
    renderAt("/workflows/wf-9/edit");
    await screen.findByLabelText("Workflow name");
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Version history/ }));
    await within(drawer()).findByRole("list", { name: "Versions" });
  });

  it("links to the builder with its History panel open", () => {
    expect(workflowHistoryPath("wf 1")).toBe("/workflows/wf%201/edit?panel=history");
  });
});
