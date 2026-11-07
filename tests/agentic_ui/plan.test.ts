import { describe, expect, it } from "vitest";

import {
  buildConversationPlans,
  collectPlanAnswers,
  foldAnswerPlan,
  formatStepDuration,
  planProgressLabel,
  planStepLabel,
} from "@/features/chat/lib/conversationPlans";
import {
  advancePlanTimings,
  foldPlanEvents,
  planStepDurationMs,
} from "@/features/inference/planTiming";
import {
  createTimeline,
  finalizeTimeline,
  reduceTimelineEvents,
} from "@/features/inference/timeline";
import type { PlanSnapshot } from "@/features/inference/agui";
import type { MessageOut, RunTimeline } from "@/shared/lib/types";

/**
 * The agent's plan (composer button → panel): the `write_todos` checklist per
 * answer on the branch, and when each step started and finished — read off
 * successive PLAN_SNAPSHOT events, as the agents service emits them: the whole
 * list on every change, stamped with its clock in `updated_at`.
 */

type Event = Record<string, unknown>;
type Status = "pending" | "in_progress" | "completed";

const snapshot = (at: number | null, items: Array<[string, Status]>): Event => ({
  type: "CUSTOM",
  name: "PLAN_SNAPSHOT",
  value: {
    items: items.map(([content, status]) => ({ content, status })),
    updated_at: at,
  },
});

const plan = (items: Array<[string, Status]>, at?: number): PlanSnapshot => ({
  items: items.map(([content, status]) => ({ content, status })),
  updated_at: at,
});

/** Collect → normalise (12 s) → draft, then the draft left mid-way. */
const threeStepRun = (): Event[] => [
  snapshot(1_000, [
    ["Collect the prices", "in_progress"],
    ["Normalise the currencies", "pending"],
    ["Draft the comparison", "pending"],
  ]),
  snapshot(31_000, [
    ["Collect the prices", "completed"],
    ["Normalise the currencies", "in_progress"],
    ["Draft the comparison", "pending"],
  ]),
  snapshot(43_000, [
    ["Collect the prices", "completed"],
    ["Normalise the currencies", "completed"],
    ["Draft the comparison", "in_progress"],
  ]),
];

const fold = (events: Event[], status?: "completed" | "failed" | "cancelled"): RunTimeline => {
  const state = reduceTimelineEvents(createTimeline(), events);
  return status ? finalizeTimeline(state, status) : state;
};

const message = (id: string, sender: string, extra: Partial<MessageOut> = {}): MessageOut => ({
  id,
  sender,
  content: "",
  created_at: new Date(0),
  updated_at: new Date(0),
  attachments: [],
  ...extra,
});

describe("plan step timing", () => {
  it("starts a step when first seen in progress and ends it when first seen done", () => {
    const timeline = fold(threeStepRun());

    expect(timeline.planTimings).toEqual([
      { startedAt: 1_000, endedAt: 31_000 },
      { startedAt: 31_000, endedAt: 43_000 },
      { startedAt: 43_000, endedAt: undefined },
    ]);
    expect(timeline.planTimings?.map(planStepDurationMs)).toEqual([30_000, 12_000, null]);
  });

  it("reads the same times off a settled answer's log as the live fold", () => {
    const folded = foldPlanEvents(threeStepRun());

    expect(folded?.timings).toEqual(fold(threeStepRun()).planTimings);
    expect(folded?.plan.items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "in_progress",
    ]);
  });

  it("knows no duration for a step marked done without being seen at work", () => {
    const timings = foldPlanEvents([
      snapshot(1_000, [
        ["A", "in_progress"],
        ["B", "pending"],
      ]),
      snapshot(9_000, [
        ["A", "completed"],
        ["B", "completed"],
      ]),
    ])?.timings;

    expect(timings?.[1]).toEqual({ startedAt: null, endedAt: 9_000 });
    expect(planStepDurationMs(timings?.[1])).toBeNull();
    expect(planStepDurationMs(timings?.[0])).toBe(8_000);
  });

  it("never stamps a step done in the answer's first snapshot (it finished before)", () => {
    const timings = foldPlanEvents([snapshot(5_000, [["Carried over", "completed"]])])?.timings;

    expect(timings).toEqual([{ startedAt: null, endedAt: null }]);
  });

  it("leaves a transition with no time unknown, and never stamps it later", () => {
    const timings = foldPlanEvents([
      snapshot(null, [["A", "in_progress"]]),
      snapshot(20_000, [["A", "in_progress"]]),
      snapshot(30_000, [["A", "completed"]]),
    ])?.timings;

    expect(timings).toEqual([{ startedAt: null, endedAt: 30_000 }]);
    expect(planStepDurationMs(timings?.[0])).toBeNull();
  });

  it("falls back to the event's timestamp when the snapshot has none", () => {
    const events = threeStepRun().map((event, index) => ({
      ...event,
      value: { ...(event.value as object), updated_at: undefined },
      timestamp: [100, 400, 900][index],
    }));

    expect(foldPlanEvents(events)?.timings.map(planStepDurationMs)).toEqual([300, 500, null]);
  });

  it("matches steps by text across a rewrite that inserts a step", () => {
    const before = plan([
      ["Collect", "completed"],
      ["Draft", "in_progress"],
    ]);
    const first = advancePlanTimings(null, undefined, before, 1_000);
    const after = plan([
      ["Collect", "completed"],
      ["Check the sources", "pending"],
      ["Draft", "completed"],
    ]);
    const timings = advancePlanTimings(before, first, after, 4_000);

    expect(timings[1]).toEqual({});
    expect(timings[2]).toEqual({ startedAt: 1_000, endedAt: 4_000 });
  });

  it("keeps a step's timing when it is reworded in place", () => {
    const before = plan([["Draft the summry", "in_progress"]]);
    const first = advancePlanTimings(null, undefined, before, 1_000);
    const after = plan([["Draft the summary", "completed"]]);

    expect(advancePlanTimings(before, first, after, 6_000)).toEqual([
      { startedAt: 1_000, endedAt: 6_000 },
    ]);
  });

  it("clears the finish of a step that is reopened", () => {
    const timings = foldPlanEvents([
      snapshot(1_000, [["A", "in_progress"]]),
      snapshot(2_000, [["A", "completed"]]),
      snapshot(3_000, [["A", "in_progress"]]),
    ])?.timings;

    expect(timings).toEqual([{ startedAt: 1_000, endedAt: undefined }]);
  });

  it("ignores a sub-agent's own plan inside its envelope", () => {
    const wrapped: Event = {
      type: "CUSTOM",
      name: "SUBAGENT_EVENT",
      value: {
        task_id: "t",
        namespace: ["tools:t"],
        event: snapshot(1, [["Sub step", "pending"]]),
      },
    };

    expect(foldPlanEvents([wrapped])).toBeNull();
    expect(fold([wrapped]).plan).toBeNull();
  });

  it("formats durations as a clock", () => {
    expect(formatStepDuration(12_000)).toBe("0:12");
    expect(formatStepDuration(185_400)).toBe("3:05");
    expect(formatStepDuration(3_725_000)).toBe("1:02:05");
    expect(formatStepDuration(null)).toBeNull();
    expect(formatStepDuration(-1)).toBeNull();
  });
});

describe("plans across the conversation", () => {
  const conversation = (): MessageOut[] => [
    message("u1", "user", { content: "Compare the three vendors\n on price" }),
    message("a1", "ai", { rawEvents: threeStepRun(), streamingStatus: "completed" }),
    message("u2", "user", { content: "Thanks!" }),
    message("a2", "ai", { rawEvents: [{ type: "TEXT_MESSAGE_CONTENT", delta: "You're welcome" }] }),
    message("u3", "user", { content: "Now draft the summary" }),
    message("a3", "ai", { rawEvents: [] }),
  ];

  it("keeps one entry per answer with a plan, numbered by question; the latest is current", () => {
    const plans = buildConversationPlans(
      collectPlanAnswers(conversation(), { messageId: null, timeline: null }),
    );

    expect(plans.answers.map((answer) => [answer.number, answer.question])).toEqual([
      [1, "Compare the three vendors on price"],
    ]);
    const [q1] = plans.answers;
    expect(plans.current).toBe(q1);
    expect(q1).toMatchObject({ live: false, completed: 2, total: 3, activeIndex: -1 });
    // Settled: the step left in progress is not "now".
    expect(q1.steps.map((step) => step.state)).toEqual(["done", "done", "stopped"]);
    expect(q1.steps.map((step) => step.durationMs)).toEqual([30_000, 12_000, null]);
  });

  it("is empty without plans, and leaves out an answer whose plan has no steps", () => {
    expect(
      buildConversationPlans(collectPlanAnswers([], { messageId: null, timeline: null })),
    ).toEqual({ answers: [], current: null });
    const cleared = [
      message("u", "user", { content: "Go" }),
      message("a", "ai", { rawEvents: [snapshot(1, [])] }),
    ];
    expect(
      buildConversationPlans(collectPlanAnswers(cleared, { messageId: null, timeline: null }))
        .current,
    ).toBeNull();
  });

  it("takes the live run's timeline for the streaming answer and updates with it", () => {
    const messages = conversation();
    const firstFrame = fold([
      snapshot(100, [
        ["Outline", "in_progress"],
        ["Write", "pending"],
      ]),
    ]);
    const live = buildConversationPlans(
      collectPlanAnswers(messages, { messageId: "a3", timeline: firstFrame }),
    );

    expect(live.answers.map((answer) => answer.number)).toEqual([1, 3]);
    expect(live.current).toMatchObject({ number: 3, live: true, activeIndex: 0, completed: 0 });
    expect(live.current?.steps[0].state).toBe("active");

    const nextFrame = reduceTimelineEvents(firstFrame, [
      snapshot(9_100, [
        ["Outline", "completed"],
        ["Write", "in_progress"],
        ["Proofread", "pending"],
      ]),
    ]);
    const updated = buildConversationPlans(
      collectPlanAnswers(messages, { messageId: "a3", timeline: nextFrame }),
    );

    expect(updated.current?.steps.map((step) => [step.content, step.state])).toEqual([
      ["Outline", "done"],
      ["Write", "active"],
      ["Proofread", "pending"],
    ]);
    expect(updated.current?.steps[0].durationMs).toBe(9_000);
    // The settled answer was not rebuilt: same object across frames.
    expect(updated.answers[0]).toBe(live.answers[0]);
  });

  describe("background tasks: one plan, updated in place", () => {
    const steps = (s1: Status, s2: Status, s3: Status): Array<[string, Status]> => [
      ["Wave 1: receive both source lists", s1],
      ["Wave 2: run the analyst", s2],
      ["Wave 3: write the brief", s3],
    ];
    const notice = (id: string) =>
      message(id, "user", { content: "An async subagent task you started has an update.", kind: "task_notification" });

    it("a wake-up's answer updates the plan its question started, not a new question's", () => {
      const messages = [
        message("u1", "user", { content: "PIPELINE TEST" }),
        message("a1", "ai", { rawEvents: [snapshot(1_000, steps("in_progress", "pending", "pending"))] }),
        notice("n1"),
        message("a2", "ai", { rawEvents: [snapshot(9_000, steps("completed", "in_progress", "pending"))] }),
      ];
      const plans = buildConversationPlans(collectPlanAnswers(messages, { messageId: null, timeline: null }));

      expect(plans.answers).toHaveLength(1);
      expect(plans.current).toBe(plans.answers[0]);
      expect(plans.current).toMatchObject({ number: 1, question: "PIPELINE TEST", completed: 1, total: 3 });
    });

    it("updates in place across questions asked meanwhile, and the updated plan is current", () => {
      const messages = [
        message("u1", "user", { content: "PIPELINE TEST" }),
        message("a1", "ai", { rawEvents: [snapshot(1_000, steps("in_progress", "pending", "pending"))] }),
        message("u2", "user", { content: "How is it going?" }),
        message("a2", "ai", { rawEvents: [snapshot(2_000, [["Answer the user", "completed"]])] }),
        notice("n1"),
        message("a3", "ai", { rawEvents: [snapshot(9_000, steps("completed", "completed", "in_progress"))] }),
      ];
      const plans = buildConversationPlans(collectPlanAnswers(messages, { messageId: null, timeline: null }));

      expect(plans.answers.map((answer) => [answer.number, answer.question])).toEqual([
        [1, "PIPELINE TEST"],
        [2, "How is it going?"],
      ]);
      expect(plans.current).toBe(plans.answers[0]);
      expect(plans.current?.completed).toBe(2);
    });

    it("keeps a step's time from the run that finished it", () => {
      const messages = [
        message("u1", "user", { content: "PIPELINE TEST" }),
        message("a1", "ai", {
          rawEvents: [
            snapshot(1_000, steps("in_progress", "pending", "pending")),
            snapshot(5_000, steps("completed", "pending", "pending")),
          ],
        }),
        notice("n1"),
        message("a2", "ai", { rawEvents: [snapshot(9_000, steps("completed", "completed", "pending"))] }),
      ];
      const [only] = buildConversationPlans(collectPlanAnswers(messages, { messageId: null, timeline: null })).answers;

      expect(only.steps[0].durationMs).toBe(4_000);
    });

    it("a plan with any other step — even one more — is a new plan, below", () => {
      const messages = [
        message("u1", "user", { content: "PIPELINE TEST" }),
        message("a1", "ai", { rawEvents: [snapshot(1_000, steps("completed", "in_progress", "pending"))] }),
        notice("n1"),
        message("a2", "ai", {
          rawEvents: [snapshot(9_000, [...steps("completed", "completed", "pending"), ["Wave 4: review", "pending"]])],
        }),
      ];
      const plans = buildConversationPlans(collectPlanAnswers(messages, { messageId: null, timeline: null }));

      expect(plans.answers.map((answer) => answer.total)).toEqual([3, 4]);
      expect(plans.current).toBe(plans.answers[1]);
      // Both belong to the user's question; the notice is not one.
      expect(plans.answers.map((answer) => answer.number)).toEqual([1, 1]);
    });
  });

  it("reads a settled answer's plan once per event log", () => {
    const [, answer] = conversation();
    const first = foldAnswerPlan(answer);

    expect(first).not.toBeNull();
    expect(foldAnswerPlan(answer)).toBe(first);
  });

  it("labels progress and steps", () => {
    expect(planProgressLabel({ completed: 2, total: 5 })).toBe("2 of 5 done");
    expect(planProgressLabel({ completed: 5, total: 5 })).toBe("Done · 5 steps");
    expect(planProgressLabel({ completed: 1, total: 1 })).toBe("Done · 1 step");

    const [q1] = buildConversationPlans(
      collectPlanAnswers(conversation(), { messageId: null, timeline: null }),
    ).answers;
    expect(planStepLabel(q1.steps[1], 1, 3)).toBe(
      "Step 2 of 3, done in 0:12: Normalise the currencies",
    );
    expect(planStepLabel(q1.steps[2], 2, 3)).toBe(
      "Step 3 of 3, not finished: Draft the comparison",
    );
  });
});
