// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import AutomationsPage from "@/features/automations/components/AutomationsPage";
import {
  filterAutomations,
  filterWorkflowItems,
  sortAutomations,
  sortWorkflowItems,
  matchesStatusFilter,
  statusFilterCounts,
} from "@/features/automations/lib/filters";
import {
  AUTOMATION_AREAS,
  AUTOMATION_KINDS,
  areaKind,
  automationItemId,
  automationKind,
} from "@/features/automations/lib/kinds";
import {
  automationsAreaFromParam,
  automationsAreaPath,
  automationsForAgentPath,
  isAutomationsPath,
} from "@/features/automations/lib/routes";
import { describeSchedule, formatRelative, humanizeCron, nextCronRuns } from "@/shared/lib/schedule";
import { isRunningTask, taskStatusKind } from "@/features/automations/lib/schedule";
import { AUTOMATION_TEMPLATES, findTemplate } from "@/features/automations/lib/templates";
import { workflowLastRun, workflowScheduleLine } from "@/shared/lib/workflowSchedule";
import { needsRunInputs } from "@/features/workflows/lib/inputs";
import LegacyTasksRedirect from "@/pages/LegacyTasksRedirect";
import type {
  Agent,
  ScheduleAutomationItem,
  ScheduledTask,
  Workflow,
  WorkflowAutomationItem,
} from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";

/**
 * The Automations page (plan 38, Phase 1; it replaced Schedules) — the home of
 * both schedules and workflows, one area each behind a header switch.
 *
 * Pinned: schedules read in plain words (cron humanised where it can be, the
 * expression itself otherwise); the cron preview finds the right next runs in
 * the task's timezone; a live run wins the status chip; the kind registry
 * holds only what works today and each card wears its kind's badge; the status
 * chips filter and count; one page, no tabs — templates are the empty state's
 * content and sit under the list otherwise, and a template opens the create
 * dialog filled in, in one click (also from `?template=`); the form refuses a
 * too-short interval or a missing instruction inline, and a valid form sends
 * the same payload as before; pause/resume and delete (behind a confirm) call
 * the page's handlers; "/tasks" redirects to "/automations" with its query.
 *
 * The Workflows area (`?view=workflows`): the switch and the header's create
 * action follow the area; workflows are cards in the schedule cards' chrome
 * with the registry's "Workflow" badge, a version, and their schedule (set by
 * the start node) when they have one; Open / Edit / Run now / Delete (behind a
 * confirm) call the page's handlers; empty, its hero opens the builder; the
 * search box appears at 8 workflows.
 */

// Any component stands in for the agent's lucide icon.
const Bot = () => <svg aria-hidden />;
const agents = [
  { id: "a1", name: "Research Analyst", icon: Bot, isActive: true },
] as unknown as Agent[];

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1",
  agentId: "a1",
  agentName: "Research Analyst",
  title: "Morning briefing",
  prompt: "Brief me",
  isPrivate: false,
  targetMode: "bound",
  scheduleKind: "cron",
  scheduleSpec: { cron_expr: "0 9 * * 1-5" },
  timezone: "UTC",
  status: "active",
  nextRunAt: new Date(Date.now() + 3600e3),
  lastRunAt: null,
  runCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const item = (over: Partial<ScheduledTask> = {}): ScheduleAutomationItem => ({
  kind: "schedule",
  task: task(over),
});

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: "wf-1",
  name: "Deploy",
  description: "Ships the build",
  spec: null,
  latestVersionNo: 3,
  createdAt: null,
  updatedAt: null,
  ...over,
});

const workflowItem = (over: Partial<Workflow> = {}): WorkflowAutomationItem => ({
  kind: "workflow",
  workflow: workflow(over),
});

function renderPage(props: Partial<React.ComponentProps<typeof AutomationsPage>> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onCreate: vi.fn(async () => task({ id: "new" })),
    onUpdate: vi.fn(async () => task()),
    onDelete: vi.fn(async () => {}),
    onOpenResult: vi.fn(),
  };
  render(
    <SidebarProvider>
      <AutomationsPage
        items={[]}
        loading={false}
        error={null}
        agents={agents}
        {...handlers}
        {...props}
      />
    </SidebarProvider>,
  );
  return handlers;
}

describe("schedule wording", () => {
  it("humanises common cron expressions and gives up on the rest", () => {
    expect(humanizeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(humanizeCron("30 7 * * 1")).toBe("Every Monday at 07:30");
    expect(humanizeCron("0 8 * * *")).toBe("Every day at 08:00");
    expect(humanizeCron("0 8,17 * * 0,6")).toBe("Every weekend at 08:00 and 17:00");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(humanizeCron("0 9 1 * *")).toBe("Monthly on the 1st at 09:00");
    expect(humanizeCron("0 9-17 * * *")).toBeNull();
    expect(humanizeCron("not a cron")).toBeNull();
  });

  it("describes each schedule kind", () => {
    expect(
      describeSchedule({ scheduleKind: "interval", scheduleSpec: { interval_seconds: 21600 } }),
    ).toBe("Every 6 hours");
    expect(
      describeSchedule({ scheduleKind: "cron", scheduleSpec: { cron_expr: "0 9-17 * * *" } }),
    ).toBe("Cron 0 9-17 * * *");
    expect(describeSchedule({ scheduleKind: "one_off", scheduleSpec: {} })).toBe("Once");
  });

  it("finds the next cron runs in the task's timezone", () => {
    const from = new Date("2026-10-23T12:00:00Z"); // a Friday
    const runs = nextCronRuns("0 9 * * 1-5", "Europe/Athens", 3, from);
    // 09:00 in Athens is 06:00Z (EEST, UTC+3) before the clocks go back on Oct 25, 07:00Z after.
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-26T07:00:00.000Z",
      "2026-10-27T07:00:00.000Z",
      "2026-10-28T07:00:00.000Z",
    ]);
  });

  it("reads relative times", () => {
    const now = new Date("2026-10-24T10:00:00Z");
    expect(formatRelative(new Date("2026-10-24T12:15:00Z"), now)).toBe("in 2 h 15 min");
    expect(formatRelative(new Date("2026-10-24T09:55:00Z"), now)).toBe("5 min ago");
    expect(formatRelative(new Date("2026-10-27T10:00:00Z"), now)).toBe("in 3 days");
  });

  it("lets a live run win the status", () => {
    expect(taskStatusKind({ status: "paused", liveStatus: "running" })).toBe("running");
    expect(taskStatusKind({ status: "active", liveStatus: "failed" })).toBe("lastFailed");
    expect(taskStatusKind({ status: "completed", liveStatus: "completed" })).toBe("completed");
    expect(taskStatusKind({ status: "active", liveStatus: null })).toBe("scheduled");
  });
});

describe("automation kinds and filters", () => {
  it("registers only the kinds that work today, one area each", () => {
    expect(Object.keys(AUTOMATION_KINDS)).toEqual(["schedule", "workflow"]);
    expect(automationKind("schedule")).toMatchObject({
      id: "schedule",
      label: "Schedule",
      createLabel: "New schedule",
    });
    expect(automationKind("workflow")).toMatchObject({
      id: "workflow",
      label: "Workflow",
      createLabel: "New workflow",
    });
    expect(AUTOMATION_AREAS.map((area) => area.id)).toEqual(["schedules", "workflows"]);
    expect(areaKind("workflows")).toBe("workflow");
    expect(automationItemId(item())).toBe("schedule:t1");
    expect(automationItemId(workflowItem())).toBe("workflow:wf-1");
  });

  it("searches workflows by name and description", () => {
    const items = [
      workflowItem(),
      workflowItem({ id: "wf-2", name: "Nightly", description: "Report on invoices" }),
    ];
    expect(filterWorkflowItems(items, "invoice").map((i) => i.workflow.id)).toEqual(["wf-2"]);
    expect(filterWorkflowItems(items, "  ")).toHaveLength(2);
  });

  it("words a workflow's schedule, and asks for inputs only when one is required", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    const schedule = {
      status: "active" as const,
      kind: "cron",
      spec: { cron_expr: "0 9 * * 1-5" },
      timezone: "UTC",
      nextRunAt: "2026-11-04T10:30:00Z",
      lastRunAt: "2026-11-04T09:00:00Z",
      lastRunStatus: "failed",
    };
    expect(workflowScheduleLine(workflow({ schedule }), now)).toMatch(/^Next in 30 min · /);
    expect(
      workflowScheduleLine(workflow({ schedule: { ...schedule, status: "paused" } }), now),
    ).toBe("Paused — no upcoming runs");
    expect(workflowScheduleLine(workflow(), now)).toBe("Start it here or from its page");
    expect(workflowLastRun(workflow({ schedule }), now)).toEqual({
      label: "Last scheduled run 1 h ago · failed",
      failed: true,
    });
    expect(workflowLastRun(workflow(), now)).toBeNull();
    expect(needsRunInputs([{ name: "a", type: "string" }])).toBe(false);
    expect(needsRunInputs([{ name: "a", type: "string", required: true }])).toBe(true);
  });

  it("keeps one copy of the running statuses", () => {
    expect(isRunningTask({ liveStatus: "queued" })).toBe(true);
    expect(isRunningTask({ liveStatus: "cancelling" })).toBe(true);
    expect(isRunningTask({ liveStatus: "completed" })).toBe(false);
  });

  it("sorts by next run (nothing coming last), newest and name", () => {
    const at = (iso: string | null) => (iso ? new Date(iso) : null);
    const items = [
      item({ id: "a", title: "beta", nextRunAt: at("2030-01-02T00:00:00Z"), createdAt: new Date("2026-01-01") }),
      item({ id: "b", title: "Alpha", nextRunAt: null, createdAt: new Date("2026-03-01") }),
      item({ id: "c", title: "gamma", nextRunAt: at("2030-01-01T00:00:00Z"), createdAt: new Date("2026-02-01") }),
    ];
    const ids = (list: typeof items) => list.map((i) => i.task.id);
    expect(ids(sortAutomations(items, "next_run"))).toEqual(["c", "a", "b"]);
    expect(ids(sortAutomations(items, "newest"))).toEqual(["b", "c", "a"]);
    expect(ids(sortAutomations(items, "name"))).toEqual(["b", "a", "c"]);
    // The list it was given is left as it was.
    expect(ids(items)).toEqual(["a", "b", "c"]);
    const flows = [workflow({ id: "w1", name: "Zed" }), workflow({ id: "w2", name: "abc" })].map((w) => ({
      kind: "workflow" as const,
      workflow: w,
    }));
    expect(sortWorkflowItems(flows, "name").map((f) => f.workflow.id)).toEqual(["w2", "w1"]);
  });

  it("filters and counts by status, and searches what a card shows", () => {
    const items = [
      item({ id: "a" }),
      item({ id: "b", status: "paused" }),
      item({ id: "c", liveStatus: "running" }),
      item({ id: "d", status: "completed" }),
      item({ id: "e", status: "failed" }),
    ];
    expect(statusFilterCounts(items)).toEqual({
      all: 5,
      running: 1,
      active: 2,
      paused: 1,
      finished: 2,
    });
    expect(matchesStatusFilter(items[2]!, "running")).toBe(true);
    expect(filterAutomations(items, "finished", "").map((i) => i.task.id)).toEqual(["d", "e"]);
    expect(
      filterAutomations([item({ id: "x", title: "Invoices" }), item()], "all", "invoice").map(
        (i) => i.task.id,
      ),
    ).toEqual(["x"]);
  });

  it("gives every template the schedule kind, findable by id", () => {
    expect(AUTOMATION_TEMPLATES.every((t) => t.kind === "schedule")).toBe(true);
    expect(findTemplate("daily-briefing")?.label).toBe("Daily briefing");
    expect(findTemplate("nope")).toBeNull();
  });
});

describe("automations routes", () => {
  it("matches the page and its sub-routes only", () => {
    expect(isAutomationsPath("/automations")).toBe(true);
    expect(isAutomationsPath("/automations/t1")).toBe(true);
    expect(isAutomationsPath("/automationsfoo")).toBe(false);
    expect(isAutomationsPath("/tasks")).toBe(false);
    expect(automationsForAgentPath("a 1")).toBe("/automations?agent=a%201");
  });

  it("reads and writes the area in ?view=", () => {
    expect(automationsAreaFromParam(null)).toBe("schedules");
    expect(automationsAreaFromParam("workflows")).toBe("workflows");
    expect(automationsAreaFromParam("bogus")).toBe("schedules");
    expect(automationsAreaPath("schedules")).toBe("/automations");
    expect(automationsAreaPath("workflows")).toBe("/automations?view=workflows");
  });

  it("redirects /tasks to /automations and keeps the query", async () => {
    const Where = () => {
      const { pathname, search } = useLocation();
      return <p data-testid="where">{pathname + search}</p>;
    };
    render(
      <MemoryRouter initialEntries={["/tasks?agent=a2"]}>
        <Routes>
          <Route path="/tasks" element={<LegacyTasksRedirect />} />
          <Route path="/automations" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("where")).toHaveTextContent("/automations?agent=a2");
  });
});

describe("AutomationsPage", () => {
  it("shows the empty state with the templates as its content, and no tabs", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Automations" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create from scratch/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start from a template" })).toBeInTheDocument();
    expect(screen.getAllByTestId("template-card")).toHaveLength(AUTOMATION_TEMPLATES.length);
  });

  it("puts the list on top and a compact template section below", () => {
    renderPage({ items: [item()] });
    const card = screen.getByTestId("automation-card");
    const templates = screen.getByRole("heading", { name: "Start from a template" });
    // The list comes first in the document.
    expect(card.compareDocumentPosition(templates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("template-card")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getAllByTestId("template-card")).toHaveLength(AUTOMATION_TEMPLATES.length);
  });

  it("opens the filled-in dialog from a template in one click", async () => {
    renderPage();
    fireEvent.click(screen.getAllByTestId("template-card")[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/From template:/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Instruction")).toHaveValue(
      AUTOMATION_TEMPLATES[0]!.instructions,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss template banner" }));
    expect(within(dialog).queryByText(/From template:/)).not.toBeInTheDocument();
  });

  it("opens a template from ?template= once", async () => {
    const handled = vi.fn();
    renderPage({ createFromTemplateId: "weekly-report", onCreateFromTemplateHandled: handled });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Instruction")).toHaveValue(
      findTemplate("weekly-report")!.instructions,
    );
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for an unknown template id, and still drops it", () => {
    const handled = vi.fn();
    renderPage({ createFromTemplateId: "nope", onCreateFromTemplateHandled: handled });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("filters the list from the toolbar's status menu, and sorts it", async () => {
    renderPage({
      items: [
        item({ id: "t1", title: "Zeta" }),
        item({ id: "t2", title: "Invoices", status: "paused" }),
        item({ id: "t3", title: "Alpha" }),
      ],
    });
    expect(screen.getAllByTestId("automation-card")).toHaveLength(3);
    // No chips: a filter icon opens the statuses, with their counts.
    expect(screen.queryByRole("group", { name: "Filter automations by status" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Filter by status" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Paused/ }));
    // The hidden cards play their exit before they leave the DOM.
    await waitFor(() => expect(screen.getAllByTestId("automation-card")).toHaveLength(1));
    expect(within(screen.getAllByTestId("automation-card")[0]!).getByText("Invoices")).toBeInTheDocument();
    // The icon says a filter is on.
    expect(screen.getByRole("button", { name: "Filter: Paused" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Filter: Paused" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /All/ }));
    await waitFor(() => expect(screen.getAllByTestId("automation-card")).toHaveLength(3));
    fireEvent.keyDown(screen.getByRole("button", { name: /^Sort:/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Name/ }));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("automation-card").map((card) => within(card).getByText(/Alpha|Invoices|Zeta/).textContent),
      ).toEqual(["Alpha", "Invoices", "Zeta"]),
    );
  });

  it("renders a card per automation with its kind, schedule, status and last result", () => {
    const h = renderPage({
      items: [
        item(),
        item({
          id: "t2",
          title: "Invoices",
          liveStatus: "running",
          lastRunConversationId: "c2",
          targetMode: "fresh",
        }),
      ],
    });
    const cards = screen.getAllByTestId("automation-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("data-automation-kind", "schedule");
    expect(within(cards[0]!).getByText("Schedule")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Every weekday at 09:00")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Scheduled")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("One ongoing chat")).toBeInTheDocument();
    expect(cards[1]).toHaveAttribute("data-active", "true");
    expect(within(cards[1]!).getByText("Running")).toBeInTheDocument();
    fireEvent.click(within(cards[1]!).getByRole("button", { name: /Open latest result/ }));
    expect(h.onOpenResult).toHaveBeenCalledWith("c2", "a1");
  });

  it("pauses, resumes and deletes behind a confirm", async () => {
    const h = renderPage({ items: [item(), item({ id: "t2", status: "paused" })] });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(h.onUpdate).toHaveBeenCalledWith("t1", { status: "paused" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(h.onUpdate).toHaveBeenCalledWith("t2", { status: "active" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(h.onDelete).toHaveBeenCalledWith("t1"));
  });

  it("validates the form inline and creates an automation with the same payload as before", async () => {
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Interval amount"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Minutes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Create automation/ }));
    expect(await within(dialog).findByText("Enter the instruction to run.")).toBeInTheDocument();
    expect(within(dialog).getByText("The minimum interval is 5 minutes.")).toBeInTheDocument();
    expect(h.onCreate).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Instruction"), {
      target: { value: "  Summarise the news  " },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Hours" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Create automation/ }));
    await waitFor(() =>
      expect(h.onCreate).toHaveBeenCalledWith({
        agentId: "a1",
        prompt: "Summarise the news",
        title: undefined,
        targetMode: "fresh",
        scheduleKind: "interval",
        intervalSeconds: 7200,
        isPrivate: false,
      }),
    );
  });

  it("keeps the form open and shows the server's error when saving fails", async () => {
    renderPage({
      onCreate: vi.fn(async () => Promise.reject(new Error("Invalid cron expression."))),
    });
    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Go" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create automation/ }));
    expect(await within(dialog).findByText("Invalid cron expression.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("AutomationsPage — areas", () => {
  it("defaults to Schedules and switches areas through the handler", () => {
    const onAreaChange = vi.fn();
    renderPage({ items: [item()], onAreaChange });
    const switcher = screen.getByRole("radiogroup", { name: "Automation type" });
    expect(within(switcher).getByRole("radio", { name: /Schedules/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: /New schedule/ })).toBeInTheDocument();
    fireEvent.click(within(switcher).getByRole("radio", { name: /Workflows/ }));
    expect(onAreaChange).toHaveBeenCalledWith("workflows");
  });

  it("shows the Workflows area's hero with nothing yet, opening the builder", () => {
    const onNewWorkflow = vi.fn();
    renderPage({ area: "workflows", workflows: [], onNewWorkflow, items: [item()] });
    // The schedules stay in their own area.
    expect(screen.queryByText("Morning briefing")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Start from a template" })).toBeNull();
    expect(screen.getByText("No workflows yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create your first workflow/ }));
    fireEvent.click(screen.getByRole("button", { name: /New workflow/ }));
    expect(onNewWorkflow).toHaveBeenCalledTimes(2);
  });

  it("renders a card per workflow with its badge, version and schedule", () => {
    renderPage({
      area: "workflows",
      workflows: [
        workflow(),
        workflow({
          id: "wf-2",
          name: "Nightly",
          description: null,
          schedule: {
            status: "paused",
            kind: "cron",
            spec: { cron_expr: "0 8 * * *" },
            timezone: "UTC",
            nextRunAt: null,
            lastRunAt: null,
            lastRunStatus: null,
          },
        }),
      ],
    });
    const cards = screen.getAllByTestId("automation-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("data-automation-kind", "workflow");
    expect(within(cards[0]!).getByText("Deploy")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Ships the build")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Workflow")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("v3")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Runs when you start it")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("Every day at 08:00")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("Paused — no upcoming runs")).toBeInTheDocument();
  });

  it("opens, edits, runs and deletes a workflow behind a confirm", async () => {
    const onOpenWorkflow = vi.fn();
    const onEditWorkflow = vi.fn();
    const onRunWorkflow = vi.fn(async () => {});
    const onDeleteWorkflow = vi.fn(async () => {});
    renderPage({
      area: "workflows",
      workflows: [workflow()],
      onOpenWorkflow,
      onEditWorkflow,
      onRunWorkflow,
      onDeleteWorkflow,
    });
    const card = screen.getByTestId("automation-card");
    fireEvent.click(within(card).getByRole("button", { name: /^Open/ }));
    expect(onOpenWorkflow).toHaveBeenCalledWith("wf-1");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(onEditWorkflow).toHaveBeenCalledWith("wf-1");
    fireEvent.click(within(card).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(onRunWorkflow).toHaveBeenCalledWith("wf-1"));

    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    expect(onDeleteWorkflow).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete workflow" }));
    await waitFor(() => expect(onDeleteWorkflow).toHaveBeenCalledWith("wf-1"));
  });

  it("searches from the toolbar's search icon, which opens into a field", async () => {
    const many = Array.from({ length: 3 }, (_, i) => workflow({ id: `wf-${i}`, name: `Flow ${i}` }));
    renderPage({ area: "workflows", workflows: many });
    expect(screen.queryByRole("searchbox", { name: "Search workflows" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search workflows" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search workflows" }), {
      target: { value: "Flow 2" },
    });
    await waitFor(() => expect(screen.getAllByTestId("automation-card")).toHaveLength(1));
    // No status filter for workflows; × closes the search and clears it.
    expect(screen.queryByRole("button", { name: "Filter by status" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close the search" }));
    await waitFor(() => expect(screen.getAllByTestId("automation-card")).toHaveLength(3));
  });
});
