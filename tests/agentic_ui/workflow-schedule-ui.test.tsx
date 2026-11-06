// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { typeTemplate } from "./templateField";

/**
 * The schedule trigger in the UI (plan 38, step 4): the inspector's schedule
 * editor round-trips each kind to the node's config (engine field names) and
 * back; the "Starts" switch turns the start node into the other trigger kind
 * in place (id and connections kept) and the card's subtitle follows; issues
 * show on the field, the card and in the Issues menu; Create sends the
 * schedule node; and the workflow card / view header pause and resume.
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

vi.mock("@xyflow/react", () => {
  type MockNode = { id: string; type: string; data: unknown; ariaLabel?: string };
  const ReactFlow = ({
    nodes,
    nodeTypes,
    onSelectionChange,
  }: {
    nodes: MockNode[];
    nodeTypes: Record<
      string,
      (props: { id: string; data: unknown; selected?: boolean }) => JSX.Element
    >;
    onSelectionChange?: (selection: { nodes: MockNode[]; edges: unknown[] }) => void;
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
            onClick={() => onSelectionChange?.({ nodes: [node], edges: [] })}
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
    useReactFlow: () => ({
      fitView: async () => true,
      deleteElements: vi.fn(),
      screenToFlowPosition: (point: { x: number; y: number }) => point,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setCenter: vi.fn(),
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

import catalogJson from "./fixtures/workflow-catalog.json";
import scheduleKindJson from "./fixtures/workflow-catalog-schedule.json";
import WorkflowBuilderPage from "@/features/workflows/components/builder/WorkflowBuilderPage";
import { ScheduleTriggerEditor } from "@/features/workflows/components/builder/builder_parts/ScheduleTriggerEditor";
import { WorkflowHeader } from "@/features/workflows/components/workflow_view_parts/WorkflowHeader";
import { WorkflowCard } from "@/features/automations/components/automations_parts/WorkflowCard";
import { workflowEditPath } from "@/features/workflows/lib/routes";
import { defaultScheduleConfig } from "@/features/workflows/lib/builder/schedule";
import { browserTimezone, toLocalInput } from "@/shared/lib/schedule";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type {
  Workflow,
  WorkflowNodeKindInfo,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";

const catalog = [
  ...(catalogJson as unknown as WorkflowNodeKindInfo[]),
  scheduleKindJson as unknown as WorkflowNodeKindInfo,
];

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ userId: "u1", pendingDeletion: null });
  api.getWorkflowCatalog.mockResolvedValue(catalog);
  api.validateWorkflow.mockResolvedValue({ ok: true, errors: [] });
  document.cookie = "mx_csrf=tok";
  window.localStorage.clear();
  // The palette is shut by default; these tests work in it.
  window.localStorage.setItem("magenticx:workflow-builder:palette-open", "true");
});

// ---------------------------------------------------------------- the editor

/**
 * The editor over a config it owns, as the inspector holds it: every write is
 * recorded and rendered back in, so the next interaction sees it.
 */
function renderEditor(initial: Record<string, unknown>) {
  const writes: Record<string, unknown>[] = [];
  let view: ReturnType<typeof render> | null = null;
  const ui = (config: Record<string, unknown>) => (
    <ScheduleTriggerEditor
      nodeId="trigger"
      config={config}
      issues={[]}
      onChange={(next) => {
        writes.push(next);
        view?.rerender(ui(next));
      }}
    />
  );
  view = render(ui(initial));
  return writes;
}

const last = (writes: Record<string, unknown>[]) => writes[writes.length - 1];
const radio = (name: string) => screen.getByRole("radio", { name });

describe("schedule editor ↔ node config", () => {
  it("round-trips a one-off moment through the date-time picker", () => {
    const runAt = "2026-12-01T09:30:00Z";
    const writes = renderEditor({
      ...defaultScheduleConfig(),
      schedule_kind: "one_off",
      schedule_spec: { run_at: runAt },
    });
    expect(radio("Once")).toHaveAttribute("aria-checked", "true");
    const picker = screen.getByLabelText("Run at") as HTMLInputElement;
    expect(picker.value).toBe(toLocalInput(new Date(runAt)));
    fireEvent.change(picker, { target: { value: "2026-12-02T07:15" } });
    expect(last(writes)).toMatchObject({
      schedule_kind: "one_off",
      schedule_spec: { run_at: new Date("2026-12-02T07:15").toISOString() },
    });
    expect(screen.getByTestId("schedule-preview")).toHaveTextContent(/^Once on /);
  });

  it("round-trips an interval through amount + unit", () => {
    const writes = renderEditor(defaultScheduleConfig());
    expect(radio("Every…")).toHaveAttribute("aria-checked", "true");
    const amount = screen.getByLabelText("Interval amount") as HTMLInputElement;
    expect(amount.value).toBe("1");
    expect(radio("Days")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("schedule-preview")).toHaveTextContent("Every day");
    fireEvent.change(amount, { target: { value: "6" } });
    fireEvent.click(radio("Hours"));
    expect(last(writes)).toMatchObject({
      schedule_kind: "interval",
      schedule_spec: { interval_seconds: 21600 },
    });
    expect(screen.getByTestId("schedule-preview")).toHaveTextContent("Every 6 hours");
    // Typed as-is: 90 minutes stays 90 minutes, not "1.5 hours".
    fireEvent.click(radio("Minutes"));
    fireEvent.change(amount, { target: { value: "90" } });
    expect(last(writes)).toMatchObject({ schedule_spec: { interval_seconds: 5400 } });
    expect(amount.value).toBe("90");
    expect(radio("Minutes")).toHaveAttribute("aria-checked", "true");
  });

  it("round-trips a cron expression, its presets and its timezone", () => {
    const initial = {
      ...defaultScheduleConfig(),
      schedule_kind: "cron",
      schedule_spec: { cron_expr: "0 9 * * 1-5" },
      timezone: "Europe/Athens",
    };
    const writes = renderEditor(initial);
    expect(radio("Cron")).toHaveAttribute("aria-checked", "true");
    const expr = screen.getByLabelText(/Cron expression/) as HTMLInputElement;
    expect(expr.value).toBe("0 9 * * 1-5");
    expect(screen.getByRole("button", { name: "Weekdays at 09:00" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Timezone" })).toHaveTextContent("Europe/Athens");
    expect(screen.getByTestId("schedule-preview")).toHaveTextContent(/Every weekday at 09:00/);
    expect(within(screen.getByTestId("schedule-preview")).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Daily at 08:00" }));
    expect(last(writes)).toMatchObject({
      schedule_spec: { cron_expr: "0 8 * * *" },
      timezone: "Europe/Athens",
    });
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    expect(last(writes)).toMatchObject({ schedule_spec: { cron_expr: "0 * * * *" } });
    fireEvent.change(expr, { target: { value: "*/30 * * * *" } });
    expect(last(writes)).toEqual({ ...initial, schedule_spec: { cron_expr: "*/30 * * * *" } });
  });

  it("switches kind keeping exactly one spec field, and restores what each kind was", () => {
    const writes = renderEditor({
      ...defaultScheduleConfig(),
      schedule_spec: { interval_seconds: 3600 },
    });
    fireEvent.click(radio("Once"));
    expect(last(writes)).toMatchObject({ schedule_kind: "one_off", timezone: null });
    expect(Object.keys(last(writes).schedule_spec as object)).toEqual(["run_at"]);
    fireEvent.click(radio("Cron"));
    expect(last(writes)).toMatchObject({
      schedule_kind: "cron",
      schedule_spec: { cron_expr: "0 8 * * *" },
      timezone: browserTimezone(),
    });
    fireEvent.click(radio("Every…"));
    expect(last(writes)).toMatchObject({
      schedule_kind: "interval",
      schedule_spec: { interval_seconds: 3600 },
      timezone: null,
    });
  });

  it("has no inputs of its own, drops an older spec's on the first change, and turns off", () => {
    const writes = renderEditor({ ...defaultScheduleConfig(), inputs: { topic: "news" } });
    expect(screen.queryByText("Inputs for scheduled runs")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(last(writes)).toMatchObject({ enabled: false });
    expect("inputs" in last(writes)).toBe(false);
    expect(screen.getByTestId("schedule-preview")).toHaveTextContent(/won.t fire/);
  });
});

// ---------------------------------------------------------------- the builder

const saved = (
  spec: WorkflowSpec,
  version: number,
  schedule: WorkflowSchedule | null = null,
): Workflow => ({
  id: "wf-9",
  name: spec.name,
  description: null,
  spec,
  latestVersionNo: version,
  createdAt: null,
  updatedAt: null,
  schedule,
});

function Route_() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  return (
    <WorkflowBuilderPage
      workflowId={workflowId ?? null}
      onSaved={vi.fn()}
      onCreated={(id) => navigate(workflowEditPath(id), { replace: true })}
      onOpenView={vi.fn()}
      onDeleted={vi.fn()}
      onExit={vi.fn()}
    />
  );
}

const renderBuilder = () =>
  render(
    <MemoryRouter initialEntries={["/workflows/new"]}>
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <Routes>
            <Route path="/workflows/new" element={<Route_ />} />
            <Route path="/workflows/:workflowId/edit" element={<Route_ />} />
          </Routes>
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );

const node = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);

describe("the builder's schedule trigger", () => {
  it("starts from the Schedule step, shows issues, creates with it, and flags a second trigger", async () => {
    let created: WorkflowSpec | null = null;
    api.createWorkflow.mockImplementation(async (_user: string, spec: WorkflowSpec) => {
      created = spec;
      return saved(spec, 1, {
        status: "active",
        kind: "interval",
        spec: { interval_seconds: 600 },
        timezone: null,
        nextRunAt: "2030-01-01T08:00:00Z",
        lastRunAt: null,
        lastRunStatus: null,
      });
    });
    renderBuilder();
    await screen.findByTestId("react-flow");
    await screen.findByRole("button", { name: "Add HTTP request" });
    // A new workflow is empty: the user picks how it starts from the palette.
    fireEvent.click(screen.getByRole("button", { name: "Add Schedule" }));
    await waitFor(() => expect(node("trigger")).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Nightly" } });
    fireEvent.click(screen.getByRole("button", { name: "Add HTTP request" }));
    await waitFor(() => expect(node("fetch")).not.toBeNull());
    typeTemplate(await screen.findByLabelText(/^URL/), "https://example.com/a");

    // Back on the trigger: its schedule editor (no manual/schedule switch: another start is another step).
    fireEvent.click(node("trigger")!);
    expect(await screen.findByTestId("schedule-trigger-editor")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "How the workflow starts" })).toBeNull();
    expect(
      within(node("trigger")!).getByTestId("workflow-node-subtitle-trigger"),
    ).toHaveTextContent("Every day");

    // Too short: the field, the card's badge and the Issues menu say so.
    fireEvent.click(screen.getByRole("radio", { name: "Minutes" }));
    fireEvent.change(screen.getByLabelText("Interval amount"), { target: { value: "2" } });
    expect(await screen.findAllByText("The shortest interval is 5 minutes.")).not.toHaveLength(0);
    expect(within(node("trigger")!).getByTestId("workflow-node-issues-trigger")).toHaveTextContent(
      "1",
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /issue/ }), { key: "Enter" });
    expect(
      (await screen.findAllByText("The shortest interval is 5 minutes.")).length,
    ).toBeGreaterThan(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.change(screen.getByLabelText("Interval amount"), { target: { value: "10" } });
    await waitFor(() =>
      expect(screen.queryByText("The shortest interval is 5 minutes.")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledTimes(1));
    const sent = created as unknown as WorkflowSpec;
    expect(sent.nodes[0]).toMatchObject({
      id: "trigger",
      kind: "trigger.schedule",
      config: {
        schedule_kind: "interval",
        schedule_spec: { interval_seconds: 600 },
        timezone: null,
        enabled: true,
      },
    });
    expect(sent.edges).toEqual([{ id: "e1", source: "trigger", target: "fetch", branch: null }]);
    // The save's answer carries the synced schedule: the card shows its next run.
    await waitFor(() =>
      expect(
        within(node("trigger")!).getByTestId("workflow-node-subtitle-trigger"),
      ).toHaveTextContent(/^Every 10 minutes · next /),
    );

    // A second trigger is no longer refused by the palette: it is added, and
    // the checks flag it (a workflow has exactly one).
    fireEvent.click(screen.getByRole("button", { name: "Add Manual trigger" }));
    await waitFor(() => expect(node("trigger_2")).not.toBeNull());
    fireEvent.keyDown(screen.getByRole("button", { name: /issue/ }), { key: "Enter" });
    expect(await screen.findAllByText("A workflow has exactly one trigger.")).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------- pause / resume

const schedule = (patch: Partial<WorkflowSchedule> = {}): WorkflowSchedule => ({
  status: "active",
  kind: "cron",
  spec: { cron_expr: "0 9 * * 1-5" },
  timezone: "UTC",
  nextRunAt: "2026-11-04T10:30:00Z",
  lastRunAt: "2026-11-04T09:00:00Z",
  lastRunStatus: "succeeded",
  ...patch,
});

const workflow = (patch: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Digest",
  description: null,
  spec: null,
  latestVersionNo: 2,
  createdAt: null,
  updatedAt: null,
  schedule: schedule(),
  ...patch,
});

describe("pause / resume on the workflow card and the view header", () => {
  const now = new Date("2026-11-04T10:00:00Z");

  it("the card shows the schedule's state, next run and last run, and pauses / resumes", async () => {
    const onSetSchedulePaused = vi.fn(async () => undefined);
    const card = (wf: Workflow) => (
      <TooltipProvider>
        <WorkflowCard
          item={{ kind: "workflow", workflow: wf }}
          now={now}
          index={0}
          reduceMotion
          onOpen={vi.fn()}
          onEdit={vi.fn()}
          onRunNow={vi.fn(async () => undefined)}
          onDelete={vi.fn()}
          onSetSchedulePaused={onSetSchedulePaused}
        />
      </TooltipProvider>
    );
    const view = render(card(workflow()));
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-schedule-line")).toHaveTextContent(/^Next in 30 min · /);
    expect(screen.getByText("Last scheduled run 1 h ago · succeeded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause schedule" }));
    await waitFor(() => expect(onSetSchedulePaused).toHaveBeenCalledWith("wf-1", true));

    view.rerender(card(workflow({ schedule: schedule({ status: "paused" }) })));
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume schedule" }));
    await waitFor(() => expect(onSetSchedulePaused).toHaveBeenCalledWith("wf-1", false));

    // Finished, or run by hand: nothing to pause.
    view.rerender(card(workflow({ schedule: schedule({ status: "finished" }) })));
    expect(screen.queryByRole("button", { name: /schedule$/ })).toBeNull();
    view.rerender(card(workflow({ schedule: null })));
    expect(screen.queryByRole("button", { name: /schedule$/ })).toBeNull();
  });

  it("the view header shows the schedule line and pauses / resumes", () => {
    const onSetSchedulePaused = vi.fn();
    const header = (value: WorkflowSchedule | null) => (
      <TooltipProvider>
        <SidebarProvider>
          <WorkflowHeader
            name="Digest"
            description={null}
            versionNo={2}
            onRun={vi.fn()}
            schedule={value}
            now={now.getTime()}
            onSetSchedulePaused={onSetSchedulePaused}
          />
        </SidebarProvider>
      </TooltipProvider>
    );
    const view = render(header(schedule({ lastRunStatus: "failed" })));
    const line = screen.getByTestId("workflow-header-schedule");
    expect(line).toHaveTextContent("Every weekday at 09:00");
    expect(line).toHaveTextContent(/Next in 30 min/);
    expect(line).toHaveTextContent("Last scheduled run 1 h ago · failed");
    fireEvent.click(within(line).getByRole("button", { name: "Pause schedule" }));
    expect(onSetSchedulePaused).toHaveBeenCalledWith(true);
    view.rerender(header(schedule({ status: "paused" })));
    expect(screen.getByTestId("workflow-header-schedule")).toHaveTextContent(
      "Paused — no upcoming runs",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume schedule" }));
    expect(onSetSchedulePaused).toHaveBeenCalledWith(false);
    view.rerender(header(null));
    expect(screen.queryByTestId("workflow-header-schedule")).toBeNull();
  });
});
