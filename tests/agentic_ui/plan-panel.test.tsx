// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlanButton } from "@/features/chat/components/plan/PlanButton";
import {
  EMPTY_PLANS,
  buildConversationPlans,
  collectPlanAnswers,
  type ConversationPlans,
} from "@/features/chat/lib/conversationPlans";
import { createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import type { MessageOut } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The plan in the composer: a button right of the agent map's that shows the
 * latest plan's progress, and the panel it opens — the latest plan as a
 * checklist (statuses in each step's name), earlier answers' plans folded
 * below. It replaced the plan tab that sat on top of the composer.
 */

type Event = Record<string, unknown>;
type Status = "pending" | "in_progress" | "completed";

const snapshot = (at: number, items: Array<[string, Status]>): Event => ({
  type: "CUSTOM",
  name: "PLAN_SNAPSHOT",
  value: { items: items.map(([content, status]) => ({ content, status })), updated_at: at },
});

const message = (id: string, sender: string, extra: Partial<MessageOut> = {}): MessageOut => ({
  id,
  sender,
  content: "",
  created_at: new Date(0),
  updated_at: new Date(0),
  attachments: [],
  ...extra,
});

/** Q1 settled with a finished plan; Q2 live, its second step under way. */
const twoPlans = (): ConversationPlans => {
  const messages = [
    message("u1", "user", { content: "Summarise the report" }),
    message("a1", "ai", {
      streamingStatus: "completed",
      rawEvents: [
        snapshot(1_000, [
          ["Read the report", "in_progress"],
          ["Write the summary", "pending"],
        ]),
        snapshot(13_000, [
          ["Read the report", "completed"],
          ["Write the summary", "in_progress"],
        ]),
        snapshot(20_000, [
          ["Read the report", "completed"],
          ["Write the summary", "completed"],
        ]),
      ],
    }),
    message("u2", "user", { content: "Compare the three vendors" }),
    message("a2", "ai"),
  ];
  const live = reduceTimelineEvents(createTimeline(), [
    snapshot(100_000, [
      ["Collect the prices", "in_progress"],
      ["Normalise the currencies", "pending"],
      ["Draft the comparison", "pending"],
    ]),
    snapshot(142_000, [
      ["Collect the prices", "completed"],
      ["Normalise the currencies", "in_progress"],
      ["Draft the comparison", "pending"],
    ]),
  ]);
  return buildConversationPlans(collectPlanAnswers(messages, { messageId: "a2", timeline: live }));
};

const renderButton = (plans: ConversationPlans, visible = true) =>
  render(
    <TooltipProvider>
      <PlanButton plans={plans} agentName="Atlas" visible={visible} />
    </TooltipProvider>,
  );

describe("plan button", () => {
  it("is not there without a plan, nor on an empty conversation", () => {
    renderButton(EMPTY_PLANS);
    expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();

    renderButton(twoPlans(), false);
    expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();
  });

  it("says the latest plan's progress and glows while a step is under way", () => {
    renderButton(twoPlans());
    const button = screen.getByRole("button", { name: "Plan · 1 of 3 done" });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("data-active", "true");
  });

  it("says Done once every step is, and rests", () => {
    const plans = twoPlans();
    const settled: ConversationPlans = { answers: [plans.answers[0]], current: plans.answers[0] };
    renderButton(settled);
    const button = screen.getByRole("button", { name: "Plan · Done · 2 steps" });

    expect(button).toHaveAttribute("data-active", "false");
  });
});

describe("plan panel", () => {
  it("opens the latest plan as an ordered checklist, statuses and times in each step's name", async () => {
    const user = userEvent.setup();
    renderButton(twoPlans());
    const button = screen.getByRole("button", { name: /^Plan · / });
    await user.click(button);

    const dialog = await screen.findByRole("dialog", { name: "Plan" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button.getAttribute("aria-controls")).toBe(dialog.id);
    expect(dialog).toHaveTextContent("Atlas · 1 of 3 done");

    const list = within(dialog).getByRole("list", { name: "Plan for question 2" });
    expect(list.tagName).toBe("OL");
    const steps = within(list).getAllByRole("listitem");
    expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual([
      "Step 1 of 3, done in 0:42: Collect the prices",
      "Step 2 of 3, in progress: Normalise the currencies",
      "Step 3 of 3, not started: Draft the comparison",
    ]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(within(steps[1]).getByText("now")).toBeInTheDocument();
    expect(within(steps[0]).getByText("0:42")).toBeInTheDocument();
  });

  it("folds earlier answers' plans below, each opening to its own checklist", async () => {
    const user = userEvent.setup();
    renderButton(twoPlans());
    await user.click(screen.getByRole("button", { name: /^Plan · / }));
    const dialog = await screen.findByRole("dialog", { name: "Plan" });

    const current = within(dialog).getByRole("button", { name: /Q2.*Compare the three vendors/ });
    expect(current).toHaveAttribute("aria-expanded", "true");
    const earlier = within(dialog).getByRole("button", { name: /Q1.*Summarise the report/ });
    expect(earlier).toHaveAttribute("aria-expanded", "false");
    expect(earlier).toHaveTextContent("2/2");
    expect(within(dialog).queryByRole("list", { name: "Plan for question 1" })).toBeNull();

    await user.click(earlier);
    const list = within(dialog).getByRole("list", { name: "Plan for question 1" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((step) => step.getAttribute("aria-label")),
    ).toEqual([
      "Step 1 of 2, done in 0:12: Read the report",
      "Step 2 of 2, done in 0:07: Write the summary",
    ]);
  });

  it("closes on Escape and on its close button", async () => {
    const user = userEvent.setup();
    renderButton(twoPlans());
    const button = screen.getByRole("button", { name: /^Plan · / });

    await user.click(button);
    await screen.findByRole("dialog", { name: "Plan" });
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    await user.click(await screen.findByRole("button", { name: "Close plan" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the old composer plan tab", () => {
  const UI = path.resolve(__dirname, "../../magenticx/agentic_ui/src");
  const read = (file: string) => readFileSync(path.join(UI, file), "utf8");

  it("is gone: no tab on top of the composer, no PlanCard", () => {
    expect(
      existsSync(path.join(UI, "features/chat/components/message_parts/PlanningContainer.tsx")),
    ).toBe(false);
    expect(read("features/chat/components/ChatInputBar.tsx")).not.toMatch(/topAccessory/);
    const chatView = read("pages/ChatView.tsx");
    expect(chatView).not.toMatch(/PlanCard|showPlanningCard|isPlanExpanded/);
    expect(chatView).toMatch(/planControl=\{\s*<PlanButton/);
  });
});
