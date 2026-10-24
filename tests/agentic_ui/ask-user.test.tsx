// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The markdown renderer pulls in KaTeX's stylesheet, which Node cannot import.
vi.mock("@/shared/ui/ai-elements/response", () => ({
  Response: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { AskUserTakeover } from "@/features/chat/components/AskUserTakeover";
import { CoTBlock } from "@/features/chat/components/message_parts/CoTBlock";
import { approvalHeadline, presentInterrupt } from "@/features/chat/lib/approvalPresentation";
import {
  askUserAnswers,
  askUserQuestions,
  createTimeline,
  isAskUserInterrupt,
  pendingTimelineInterrupts,
  reduceTimelineEvents,
} from "@/features/inference";
import type { ThinkingBlock, TimelineHitlApproval } from "@/shared/lib/types";

/**
 * `ask_user`: the agent asks the user 1–3 clarifying questions and the run
 * waits on a HITL interrupt. Pinned here: the payload is read tolerantly; the
 * timeline keeps the questions (never on another tool's step) and, once
 * resolved, the answers; the panel walks the questions and resumes with
 * exactly `{decision: "approve", value: {answers}}` or a `reject` skip, and
 * keeps the answers when the resume fails; the resolved record reads back.
 */

type Event = Record<string, unknown>;

const QUESTIONS = [
  { id: "q1", question: "Which market?", options: ["Greece", "Cyprus", "Both"], multiple: false },
  {
    id: "q2",
    question: "Which channels matter?",
    options: ["Email", "SMS", "Push"],
    multiple: true,
  },
  { id: "q3", question: "Anything else we should know?", options: [], multiple: false },
];

const askContent = (questions: unknown[] = QUESTIONS, id = "int-ask") => ({
  id,
  value: { type: "ask_user", questions },
});

const askInterrupt = (questions: unknown[] = QUESTIONS, id = "int-ask"): Event => ({
  type: "CUSTOM",
  name: "HITL_INTERRUPT",
  value: { thread_id: "thread-1", interrupt: askContent(questions, id) },
});

const resolved = (id: string, decision: string, answers?: unknown): Event => ({
  type: "CUSTOM",
  name: "BRIDGE_HITL_RESOLVED",
  value: { interrupt_id: id, decision, reason: null, decisions: null, answers },
});

const toolStart = (id: string, name: string): Event => ({
  type: "TOOL_CALL_START",
  toolCallId: id,
  toolCallName: name,
});

const thought = (text: string): Event => ({ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: text });

const fold = (events: Event[]) => reduceTimelineEvents(createTimeline(), events);

const thinkingBlocks = (events: Event[]) =>
  fold(events).blocks.filter((block): block is ThinkingBlock => block.kind === "thinking");

const hitlItems = (events: Event[]) =>
  thinkingBlocks(events)
    .flatMap((block) => block.items)
    .filter((item): item is TimelineHitlApproval => item.kind === "hitl");

describe("ask_user parsing", () => {
  it("recognises the interrupt, wrapped or bare, and nothing else", () => {
    expect(isAskUserInterrupt(askContent())).toBe(true);
    expect(isAskUserInterrupt({ type: "ask_user", questions: [] })).toBe(true);
    expect(isAskUserInterrupt({ id: "x", value: { action_requests: [{ name: "ls" }] } })).toBe(
      false,
    );
    expect(isAskUserInterrupt(null)).toBe(false);
    expect(isAskUserInterrupt("ask_user")).toBe(false);
  });

  it("reads the questions as given", () => {
    expect(askUserQuestions(askContent())).toEqual(QUESTIONS);
  });

  it("trims, drops empty and repeated options, caps the counts and fills missing ids", () => {
    const questions = askUserQuestions(
      askContent([
        { question: "  Pick one  ", options: [" a ", "", "a", "b", "c", "d", "e", "f", "g"] },
        { id: "q2", question: "   ", options: ["x"] },
        "not a question",
        { id: "dup", question: "Open?", options: [], multiple: true },
        { id: "dup", question: "Third", options: ["y"] },
        { id: "q9", question: "Fourth" },
      ]),
    );
    expect(questions).toEqual([
      { id: "q1", question: "Pick one", options: ["a", "b", "c", "d", "e", "f"], multiple: false },
      // `multiple` without options to pick means nothing.
      { id: "dup", question: "Open?", options: [], multiple: false },
      { id: "q3", question: "Third", options: ["y"], multiple: false },
    ]);
  });

  it("is empty for anything that is not ask_user", () => {
    expect(askUserQuestions({ id: "x", value: { action_requests: [] } })).toEqual([]);
    expect(askUserQuestions({ type: "ask_user" })).toEqual([]);
  });

  it("reads resolved answers tolerantly", () => {
    expect(
      askUserAnswers([
        { id: "q1", selected: ["Greece", ""], text: "  soon " },
        { id: "q2" },
        { nope: true },
      ]),
    ).toEqual([
      { id: "q1", selected: ["Greece"], text: "soon" },
      { id: "q2", selected: [], text: "" },
    ]);
    expect(askUserAnswers(undefined)).toBeUndefined();
    expect(askUserAnswers([])).toBeUndefined();
  });

  it("reads sensibly wherever a generic surface presents an interrupt", () => {
    const summaries = presentInterrupt(askContent());
    expect(approvalHeadline(summaries)).toBe("Asked: Which market? (+2 more)");
    expect(summaries[0].fields).toHaveLength(3);
  });
});

describe("ask_user in the timeline", () => {
  it("adds a pending item carrying the questions, in a block of its own when none is open", () => {
    const state = fold([
      { type: "TEXT_MESSAGE_CONTENT", delta: "Before I start:" },
      askInterrupt(),
    ]);
    expect(state.blocks.map((block) => block.kind)).toEqual(["content", "thinking"]);
    const [item] = (state.blocks[1] as ThinkingBlock).items as TimelineHitlApproval[];
    expect(item).toMatchObject({ kind: "hitl", id: "int-ask", status: "pending" });
    expect(item.questions).toEqual(QUESTIONS);
    expect(pendingTimelineInterrupts(state).map((interrupt) => interrupt.id)).toEqual(["int-ask"]);
  });

  it("never binds to another tool's unfinished step", () => {
    const state = fold([thought("let me check"), toolStart("t1", "ls"), askInterrupt()]);
    const block = state.blocks[0] as ThinkingBlock;
    const tool = block.items.find((item) => item.kind === "tool");
    expect(tool && "approval" in tool ? tool.approval : undefined).toBeUndefined();
    expect(block.items.filter((item) => item.kind === "hitl")).toHaveLength(1);
  });

  it("stores the answers on resolution", () => {
    const answers = [
      { id: "q1", selected: ["Greece"], text: "" },
      { id: "q2", selected: ["Email", "Push"], text: "" },
      { id: "q3", selected: [], text: "Launch in May" },
    ];
    const events = [askInterrupt(), resolved("int-ask", "approve", answers)];
    const [item] = hitlItems(events);
    expect(item.status).toBe("approved");
    expect(item.answers).toEqual(answers);
    expect(fold(events).interrupts[0].answers).toEqual(answers);
  });

  it("records a skip as rejected, without answers", () => {
    const [item] = hitlItems([askInterrupt(), resolved("int-ask", "reject")]);
    expect(item.status).toBe("rejected");
    expect(item.answers).toBeUndefined();
  });

  it("keeps a sub-agent's question too (defensively) without crashing", () => {
    const inside = (event: Event): Event => ({
      type: "CUSTOM",
      name: "SUBAGENT_EVENT",
      value: { task_id: "call-a", namespace: ["tools:ns-a"], event },
    });
    const state = fold([
      {
        type: "CUSTOM",
        name: "TASK_SUBAGENT",
        value: { task_id: "call-a", subagent_type: "r", description: "d" },
      },
      inside(thought("hmm")),
      inside({ type: "CUSTOM", name: "HITL_INTERRUPT", value: askInterrupt().value }),
      inside(resolved("int-ask", "approve", [{ id: "q1", selected: ["Both"], text: "" }])),
    ]);
    const sub = state.blocks.find((block) => block.kind === "subagent");
    const items =
      sub && "blocks" in sub ? sub.blocks.flatMap((b) => ("items" in b ? b.items : [])) : [];
    const item = items.find((entry) => entry.kind === "hitl") as TimelineHitlApproval | undefined;
    expect(item?.questions).toHaveLength(3);
    expect(item?.answers).toEqual([{ id: "q1", selected: ["Both"], text: "" }]);
  });
});

const renderBlock = (block: ThinkingBlock, isLiveActive: boolean) =>
  render(
    <CoTBlock
      block={block}
      runId="run-1"
      isLiveActive={isLiveActive}
      open
      onOpenChange={() => {}}
    />,
  );

describe("ask_user record", () => {
  it("reads 'Waiting for your answer' while pending, and shows nothing of its own", () => {
    const [block] = thinkingBlocks([askInterrupt()]);
    // The header shimmers letter by letter, so it is read as the block's text.
    const { container } = renderBlock(block, true);
    expect(container.textContent).toContain("Waiting for your answer...");
    expect(container.textContent).not.toContain("Waiting for approval");
    expect(screen.queryByText("Which market?")).toBeNull();
  });

  it("shows what was answered once resolved (also after a reload)", () => {
    const [block] = thinkingBlocks([
      askInterrupt(),
      resolved("int-ask", "approve", [
        { id: "q1", selected: ["Cyprus"], text: "" },
        { id: "q2", selected: ["Email", "SMS"], text: "" },
        { id: "q3", selected: [], text: "Launch in May" },
      ]),
    ]);
    renderBlock(block, false);
    expect(screen.getByText("Asked you 3 questions")).toBeInTheDocument();
    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.getByText("· 3 questions")).toBeInTheDocument();
    // Its block holds nothing else, so it opens on the answers.
    expect(screen.getByText("Which market?")).toBeInTheDocument();
    expect(screen.getByText("Cyprus")).toBeInTheDocument();
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.getByText("Launch in May")).toBeInTheDocument();
  });

  it("says a skip was a skip", () => {
    const [block] = thinkingBlocks([askInterrupt(), resolved("int-ask", "reject")]);
    renderBlock(block, false);
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.getAllByText("Skipped — left to the agent")).toHaveLength(3);
  });
});

const interrupt = (questions: unknown[] = QUESTIONS) => ({
  interruptId: "int-ask",
  threadId: "thread-1",
  content: askContent(questions),
});

const renderPanel = (
  onResolve: (resolution: unknown) => Promise<void> = vi.fn().mockResolvedValue(undefined),
  questions: unknown[] = QUESTIONS,
) =>
  render(
    <AskUserTakeover
      interrupt={interrupt(questions)}
      agentName="Atlas"
      onResolve={onResolve as never}
    />,
  );

describe("AskUserTakeover", () => {
  it("asks one question at a time, with its suggested answers", () => {
    renderPanel();
    expect(screen.getByText("A few quick questions")).toBeInTheDocument();
    expect(screen.getByText("Which market?")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Which market?" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["1Greece", "2Cyprus", "3Both"]);
    expect(screen.queryByText("Which channels matter?")).toBeNull();
    // Focus starts on the first option.
    expect(document.activeElement).toBe(within(group).getAllByRole("radio")[0]);
  });

  it("names the agent when it asks a single question", () => {
    renderPanel(undefined, [QUESTIONS[0]]);
    expect(screen.getByText("Atlas has a question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send answer/i })).toBeDisabled();
  });

  it("moves on by itself after a single choice", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("radio", { name: /Cyprus/ }));
    expect(screen.getByRole("radio", { name: /Cyprus/ })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getByText("Which channels matter?")).toBeInTheDocument());
    // The question it left slides away.
    await waitFor(() => expect(screen.queryByText("Which market?")).toBeNull());
    expect(screen.getByRole("button", { name: "Question 1, answered" })).toBeInTheDocument();
  });

  it("lets a multiple choice pick several, and stays put", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Email/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Push/ }));
    expect(screen.getByRole("checkbox", { name: /Email/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /Push/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /SMS/ })).toHaveAttribute("aria-checked", "false");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("Which channels matter?")).toBeInTheDocument();
  });

  it("picks with the number keys", async () => {
    renderPanel();
    await userEvent.keyboard("3");
    expect(screen.getByRole("radio", { name: /Both/ })).toHaveAttribute("aria-checked", "true");
  });

  it("takes an answer in the user's own words; Enter moves on", async () => {
    renderPanel();
    await userEvent.type(screen.getByRole("textbox", { name: /own answer/i }), "Malta{Enter}");
    await waitFor(() => expect(screen.getByText("Which channels matter?")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Question 1, answered" }));
    expect(screen.getByRole("textbox", { name: "Your own answer to: Which market?" })).toHaveValue(
      "Malta",
    );
  });

  it("shows an open question as just the field, focused", async () => {
    renderPanel(undefined, [QUESTIONS[2]]);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Anything else we should know?" }),
    );
  });

  it("reviews every answer on the last step, each chip a way back", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("radio", { name: /Greece/ }));
    await waitFor(() => screen.getByText("Which channels matter?"));
    await userEvent.click(screen.getByRole("checkbox", { name: /SMS/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const review = screen.getByRole("group", { name: "Your answers" });
    expect(within(review).getByText("Greece")).toBeInTheDocument();
    expect(within(review).getByText("SMS")).toBeInTheDocument();
    expect(within(review).getByText("No preference")).toBeInTheDocument();

    await userEvent.click(within(review).getByRole("button", { name: /Question 1/ }));
    expect(screen.getByText("Which market?")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("group", { name: "Your answers" })).toBeNull());
  });

  it("sends every answer, in order, as the resume's value", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderPanel(onResolve);
    await userEvent.click(screen.getByRole("radio", { name: /Both/ }));
    await waitFor(() => screen.getByText("Which channels matter?"));
    // Picked out of order: sent in the order they were offered.
    await userEvent.click(screen.getByRole("checkbox", { name: /Push/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Email/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    // A change event rather than typing: user-event under happy-dom can lose a
    // keystroke when an unrelated re-render lands mid-word.
    fireEvent.change(screen.getByRole("textbox", { name: "Anything else we should know?" }), {
      target: { value: "  Launch in May  " },
    });
    await userEvent.click(screen.getByRole("button", { name: /send answers/i }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0]).toEqual({
      decision: "approve",
      value: {
        answers: [
          { id: "q1", selected: ["Both"], text: "" },
          { id: "q2", selected: ["Email", "Push"], text: "" },
          { id: "q3", selected: [], text: "Launch in May" },
        ],
      },
    });
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  it("skips with a reject, and nothing else", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderPanel(onResolve);
    await userEvent.click(screen.getByRole("button", { name: /skip/i }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0]).toEqual({ decision: "reject" });
  });

  it("keeps the answers when the resume fails", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("409"));
    renderPanel(onResolve, [QUESTIONS[0]]);
    await userEvent.click(screen.getByRole("radio", { name: /Cyprus/ }));
    await userEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Cyprus/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: /send answer/i })).toBeEnabled();
  });
});
