// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import AutomationsPage from "@/features/automations/components/AutomationsPage";
import {
  filterAutomations,
  matchesStatusFilter,
  statusFilterCounts,
} from "@/features/automations/lib/filters";
import { AUTOMATION_KINDS, automationKind } from "@/features/automations/lib/kinds";
import { automationsForAgentPath, isAutomationsPath } from "@/features/automations/lib/routes";
import {
  describeSchedule,
  formatRelative,
  humanizeCron,
  isRunningTask,
  nextCronRuns,
  taskStatusKind,
} from "@/features/automations/lib/schedule";
import { AUTOMATION_TEMPLATES, findTemplate } from "@/features/automations/lib/templates";
import LegacyTasksRedirect from "@/pages/LegacyTasksRedirect";
import type { Agent, AutomationItem, ScheduledTask } from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";

/**
 * The Automations page (plan 38, Phase 1; it replaced Schedules).
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

const item = (over: Partial<ScheduledTask> = {}): AutomationItem => ({
  kind: "schedule",
  task: task(over),
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
  it("registers only the kinds that work today", () => {
    expect(Object.keys(AUTOMATION_KINDS)).toEqual(["schedule"]);
    expect(automationKind("schedule")).toMatchObject({ id: "schedule", label: "Schedule" });
  });

  it("keeps one copy of the running statuses", () => {
    expect(isRunningTask({ liveStatus: "queued" })).toBe(true);
    expect(isRunningTask({ liveStatus: "cancelling" })).toBe(true);
    expect(isRunningTask({ liveStatus: "completed" })).toBe(false);
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
    expect(screen.getByText("No automations yet")).toBeInTheDocument();
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

  it("filters the list with the status chips", async () => {
    renderPage({ items: [item(), item({ id: "t2", title: "Invoices", status: "paused" })] });
    expect(screen.getAllByTestId("automation-card")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    // The hidden card plays its exit before it leaves the DOM.
    await waitFor(() => expect(screen.getAllByTestId("automation-card")).toHaveLength(1));
    const cards = screen.getAllByTestId("automation-card");
    expect(within(cards[0]!).getByText("Invoices")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /New automation/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /New automation/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Go" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create automation/ }));
    expect(await within(dialog).findByText("Invalid cron expression.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
