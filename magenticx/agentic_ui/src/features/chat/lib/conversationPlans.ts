import {
  foldPlanEvents,
  planStepDurationMs,
  planStepKeys,
  type FoldedPlan,
} from "@/features/inference/planTiming";
import type { PlanItemStatus, PlanSnapshot } from "@/features/inference/agui";
import type { MessageOut, PlanStepTiming, RunTimeline } from "@/shared/lib/types";

// The plan panel (composer button → panel): the checklist the deep agent keeps
// with `write_todos`, per answer on the branch the user sees.
//
//   Q5 · "Compare the three vendors…"   ← the latest plan, open on top
//     ✓ Collect the price lists      0:42
//     ● Normalise the currencies     now
//     ○ Draft the comparison
//   Earlier plans
//   Q2 · "Summarise the report"  5/5    ← answers without a plan are left out
//
// Pure, like the agent map (lib/agentMap): the answers' plans come in, the
// panel's model comes out. The live answer reads the active run's timeline;
// a settled answer's plan is read off its persisted events, once per log.

/**
 * How a step shows: done, being worked on now, left in progress by an answer
 * that has ended, or not started.
 */
export type PlanStepState = "done" | "active" | "stopped" | "pending";

export type PlanStep = {
  /** Stable across rewrites of the plan (its text), for list keys. */
  key: string;
  content: string;
  status: PlanItemStatus;
  state: PlanStepState;
  /** How long it took, once done and both ends are known; else null. */
  durationMs: number | null;
};

export type PlanAnswer = {
  /** The answer's message id. */
  id: string;
  /** 1-based number of the question on the branch ("Q3"). */
  number: number;
  question: string;
  live: boolean;
  steps: PlanStep[];
  completed: number;
  total: number;
  /** The step being worked on now (live answers only), or -1. */
  activeIndex: number;
};

export type ConversationPlans = {
  /** Every answer that kept a plan, in conversation order. */
  answers: PlanAnswer[];
  /** The latest of them: the plan the button and the panel lead with. */
  current: PlanAnswer | null;
};

export type PlanAnswerInput = {
  messageId: string;
  number: number;
  question: string;
  plan: FoldedPlan | null;
  /** Whether the run still streams into this answer. */
  live: boolean;
};

export const EMPTY_PLANS: ConversationPlans = { answers: [], current: null };

const oneLine = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** One answer's plan as the panel shows it; null when it has no steps. */
export function buildPlanAnswer(input: PlanAnswerInput): PlanAnswer | null {
  const plan = input.plan?.plan;
  if (!plan?.items.length) return null;
  const keys = planStepKeys(plan);
  const timings: PlanStepTiming[] = input.plan?.timings ?? [];
  const steps = plan.items.map((item, index): PlanStep => {
    const state: PlanStepState =
      item.status === "completed"
        ? "done"
        : item.status === "in_progress"
          ? input.live
            ? "active"
            : "stopped"
          : "pending";
    return {
      key: keys[index],
      content: item.content,
      status: item.status,
      state,
      durationMs: state === "done" ? planStepDurationMs(timings[index]) : null,
    };
  });
  return {
    id: input.messageId,
    number: input.number,
    question: oneLine(input.question),
    live: input.live,
    steps,
    completed: steps.filter((step) => step.state === "done").length,
    total: steps.length,
    activeIndex: steps.findIndex((step) => step.state === "active"),
  };
}

// An answer is rebuilt only when its plan (or its live flag, number or
// question) changes: a settled answer's plan is read once and keeps its
// identity, so a long conversation rebuilds just the answer that streams.
const answerCache = new WeakMap<FoldedPlan, { key: string; answer: PlanAnswer | null }>();

/** The conversation's plans: one entry per answer that kept one. */
export function buildConversationPlans(inputs: PlanAnswerInput[]): ConversationPlans {
  const answers: PlanAnswer[] = [];
  for (const input of inputs) {
    if (!input.plan) continue;
    const key = `${input.messageId}|${input.number}|${input.live}|${input.question}`;
    const cached = answerCache.get(input.plan);
    const answer = cached && cached.key === key ? cached.answer : buildPlanAnswer(input);
    if (!cached || cached.key !== key) answerCache.set(input.plan, { key, answer });
    if (answer) answers.push(answer);
  }
  return answers.length ? { answers, current: answers[answers.length - 1] } : EMPTY_PLANS;
}

// ------------------------------------------------------
// From the visible branch's messages to the builder's input
// ------------------------------------------------------

const foldCache = new WeakMap<object, FoldedPlan | null>();

/** A settled answer's plan, read off its event log once per log. */
export function foldAnswerPlan(message: MessageOut): FoldedPlan | null {
  const events = message.rawEvents;
  if (!Array.isArray(events) || !events.length) return null;
  if (foldCache.has(events)) return foldCache.get(events) ?? null;
  const folded = foldPlanEvents(events);
  foldCache.set(events, folded);
  return folded;
}

// The live timeline's plan, paired with its timings once per pair, so the
// answer cache above can key on it across renders of the same frame.
const liveCache = new WeakMap<PlanSnapshot, { timings: unknown; folded: FoldedPlan }>();

function livePlan(timeline: RunTimeline | null): FoldedPlan | null {
  const plan = timeline?.plan;
  if (!plan) return null;
  const timings = timeline.planTimings ?? [];
  const cached = liveCache.get(plan);
  if (cached && cached.timings === timings) return cached.folded;
  const folded = { plan, timings };
  liveCache.set(plan, { timings, folded });
  return folded;
}

/**
 * Pair each answer on the branch with the question before it. The live answer
 * (the active run's assistant message) takes the run's timeline.
 */
export function collectPlanAnswers(
  messages: MessageOut[],
  live: { messageId: string | null; timeline: RunTimeline | null },
  fold: (message: MessageOut) => FoldedPlan | null = foldAnswerPlan,
): PlanAnswerInput[] {
  const inputs: PlanAnswerInput[] = [];
  let number = 0;
  let question = "";
  for (const message of messages) {
    if (message.sender !== "ai") {
      number += 1;
      question = message.content ?? "";
      continue;
    }
    const isLive = Boolean(live.messageId && message.id === live.messageId && live.timeline);
    inputs.push({
      messageId: message.id,
      number: Math.max(number, 1),
      question,
      plan: isLive ? livePlan(live.timeline) : fold(message),
      live: isLive,
    });
  }
  return inputs;
}

// ------------------------------------------------------
// Labels
// ------------------------------------------------------

/** "2 of 5 done", or "Done · 5 steps" once every step is. */
export function planProgressLabel(answer: Pick<PlanAnswer, "completed" | "total">): string {
  if (answer.total > 0 && answer.completed >= answer.total) {
    return `Done · ${answer.total} step${answer.total === 1 ? "" : "s"}`;
  }
  return `${answer.completed} of ${answer.total} done`;
}

const STATE_WORDS: Record<PlanStepState, string> = {
  done: "done",
  active: "in progress",
  stopped: "not finished",
  pending: "not started",
};

/** "Step 2 of 5, done in 0:12: Collect the prices" — a step's accessible name. */
export function planStepLabel(step: PlanStep, index: number, total: number): string {
  const took = step.state === "done" ? formatStepDuration(step.durationMs) : null;
  return `Step ${index + 1} of ${total}, ${STATE_WORDS[step.state]}${took ? ` in ${took}` : ""}: ${step.content}`;
}

/** "0:12", "3:05", "1:02:05" — how long a step took. */
export function formatStepDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
