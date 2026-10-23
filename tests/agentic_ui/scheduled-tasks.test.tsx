// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ScheduledTasksPage from "@/features/tasks/components/ScheduledTasksPage";
import {
  describeSchedule,
  formatRelative,
  humanizeCron,
  nextCronRuns,
  taskStatusKind,
} from "@/features/tasks/lib/schedule";
import type { Agent, ScheduledTask } from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";

/**
 * The scheduled-tasks page ("Schedules").
 *
 * Pinned: schedules read in plain words (cron humanised where it can be, the
 * expression itself otherwise); the cron preview finds the right next runs in
 * the task's timezone; a live run wins the status chip; the empty state offers
 * the first task; the form refuses a too-short interval or a missing
 * instruction inline, and a valid form sends the same payload as before;
 * pause/resume and delete (behind a confirm) call the page's handlers.
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

function renderPage(props: Partial<React.ComponentProps<typeof ScheduledTasksPage>> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onCreate: vi.fn(async () => task({ id: "new" })),
    onUpdate: vi.fn(async () => task()),
    onDelete: vi.fn(async () => {}),
    onOpenResult: vi.fn(),
  };
  render(
    <SidebarProvider>
      <ScheduledTasksPage
        tasks={[]}
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

describe("ScheduledTasksPage", () => {
  it("shows the empty state with a way to the first task", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeInTheDocument();
    expect(screen.getByText("No scheduled tasks yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create your first task/ })).toBeInTheDocument();
  });

  it("renders a card per task with its schedule, status and last result", () => {
    const h = renderPage({
      tasks: [
        task(),
        task({
          id: "t2",
          title: "Invoices",
          liveStatus: "running",
          lastRunConversationId: "c2",
          targetMode: "fresh",
        }),
      ],
    });
    const cards = screen.getAllByTestId("scheduled-task-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Every weekday at 09:00")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Scheduled")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("One ongoing chat")).toBeInTheDocument();
    expect(cards[1]).toHaveAttribute("data-active", "true");
    expect(within(cards[1]!).getByText("Running")).toBeInTheDocument();
    fireEvent.click(within(cards[1]!).getByRole("button", { name: /Open latest result/ }));
    expect(h.onOpenResult).toHaveBeenCalledWith("c2", "a1");
  });

  it("pauses, resumes and deletes behind a confirm", async () => {
    const h = renderPage({ tasks: [task(), task({ id: "t2", status: "paused" })] });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(h.onUpdate).toHaveBeenCalledWith("t1", { status: "paused" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(h.onUpdate).toHaveBeenCalledWith("t2", { status: "active" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(h.onDelete).toHaveBeenCalledWith("t1"));
  });

  it("validates the form inline and creates a task with the same payload as before", async () => {
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Interval amount"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Minutes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(await within(dialog).findByText("Enter the instruction to run.")).toBeInTheDocument();
    expect(within(dialog).getByText("The minimum interval is 5 minutes.")).toBeInTheDocument();
    expect(h.onCreate).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Instruction"), {
      target: { value: "  Summarise the news  " },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Hours" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Go" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create task/ }));
    expect(await within(dialog).findByText("Invalid cron expression.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
