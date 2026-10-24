import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Loader2, PencilLine, SendHorizontal } from "lucide-react";

import type { HitlInterrupt } from "@/features/chat/components/message_parts/HitlInterruptCard";
import { askUserQuestions, isAskUserAnswered } from "@/features/inference/hitl";
import { EASE_ENTER, EASE_EXIT } from "@/shared/lib/motion/panels";
import type { AskUserAnswer, AskUserQuestion } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Orb } from "@/shared/ui/orb";

/**
 * How the questions are resolved, as the resume sends it: the answers (one per
 * question, in order — an unanswered one has nothing selected and no text), or
 * a skip that lets the agent decide on its own.
 */
export type AskUserResolution =
  { decision: "approve"; value: { answers: AskUserAnswer[] } } | { decision: "reject" };

type AskUserTakeoverProps = {
  interrupt: HitlInterrupt;
  /** The agent asking ("Atlas has a question"). */
  agentName?: string;
  /** Rejects when the resume fails: the panel stays, answers intact. */
  onResolve: (resolution: AskUserResolution) => Promise<void>;
};

/** How long a single-choice pick stays on screen before the next question slides in. */
const AUTO_ADVANCE_MS = 300;
/** Options this short sit two to a row on wide screens. */
const SHORT_OPTION_CHARS = 28;

const FALLBACK_QUESTION: AskUserQuestion = {
  id: "q1",
  question: "The agent needs a little more from you to continue.",
  options: [],
  multiple: false,
};

const emptyAnswers = (questions: AskUserQuestion[]): AskUserAnswer[] =>
  questions.map((question) => ({ id: question.id, selected: [], text: "" }));

/** One answer as a line: the picks, then the user's own words. */
const askUserAnswerText = (answer: AskUserAnswer | undefined): string => {
  if (!answer) return "";
  const text = answer.text.trim();
  return [answer.selected.join(", "), text ? `“${text}”` : ""].filter(Boolean).join(" · ");
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
};

/** The height of an element, kept current — the panel eases to it on every step change. */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setHeight(element.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

/**
 * The progress of a multi-question ask: one numbered dot per question, joined
 * by a line that fills as the questions are answered. An answered dot turns
 * solid with a check; every dot jumps to its question.
 */
function StepDots({
  questions,
  answers,
  step,
  disabled,
  onJump,
}: {
  questions: AskUserQuestion[];
  answers: AskUserAnswer[];
  step: number;
  disabled: boolean;
  onJump: (index: number) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <ol className="flex shrink-0 items-center" aria-label="Questions">
      {questions.map((question, index) => {
        const answered = isAskUserAnswered(answers[index]);
        const current = index === step;
        return (
          <li key={question.id} className="flex items-center">
            {index > 0 ? (
              <span
                aria-hidden
                className="relative mx-1 h-0.5 w-3 overflow-hidden rounded-full bg-border sm:w-4"
              >
                <span
                  className={cn(
                    "absolute inset-0 origin-left rounded-full bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none",
                    isAskUserAnswered(answers[index - 1]) ? "scale-x-100" : "scale-x-0",
                  )}
                />
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onJump(index)}
              disabled={disabled}
              aria-current={current ? "step" : undefined}
              aria-label={`Question ${index + 1}${answered ? ", answered" : ""}`}
              className={cn(
                "relative flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                "transition-[background-color,color,box-shadow] duration-300 ease-out motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                answered
                  ? "bg-primary text-primary-foreground"
                  : current
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
                current && "shadow-[0_0_0_2px_hsl(var(--card)),0_0_0_4px_hsl(var(--primary)/0.45)]",
              )}
            >
              {answered ? (
                <motion.span
                  key="done"
                  initial={reduce ? false : { scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26 }}
                  className="flex"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                </motion.span>
              ) : (
                index + 1
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One suggested answer: a rounded card with its key (press 1–6) that turns into
 * a check when chosen — round for a single choice, square for a multiple one.
 */
function OptionCard({
  label,
  index,
  chosen,
  multiple,
  disabled,
  onToggle,
}: {
  label: string;
  index: number;
  chosen: boolean;
  multiple: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={chosen}
      aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
      data-option-index={index}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "group relative flex min-h-[2.875rem] w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left text-sm leading-snug",
        "transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out",
        "focus-visible:outline-none focus-visible:border-primary/45 focus-visible:ring-2 focus-visible:ring-primary/25",
        "active:scale-[0.985] disabled:cursor-default motion-reduce:transition-none motion-reduce:active:scale-100",
        chosen
          ? "border-primary/55 bg-primary/[0.07] text-foreground shadow-[0_0_0_3px_hsl(var(--primary)/0.10)]"
          : "border-border bg-secondary/40 text-foreground/90 hover:border-primary/35 hover:bg-primary/[0.04] hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative flex h-6 w-6 shrink-0 items-center justify-center text-[11px] font-semibold tabular-nums",
          "transition-[background-color,color,border-color] duration-200 motion-reduce:transition-none",
          multiple ? "rounded-[0.45rem]" : "rounded-full",
          chosen
            ? "border border-primary bg-primary text-primary-foreground"
            : "border border-border bg-card text-muted-foreground group-hover:border-primary/40 group-hover:text-primary",
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {chosen ? (
            <motion.span
              key="check"
              className="flex"
              initial={reduce ? { opacity: 0 } : { scale: 0, rotate: -45, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { scale: 0, opacity: 0 }}
              transition={
                reduce ? { duration: 0.1 } : { type: "spring", stiffness: 600, damping: 24 }
              }
            >
              <Check className="h-3.5 w-3.5" strokeWidth={3} />
            </motion.span>
          ) : (
            <motion.span
              key="key"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {index + 1}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="min-w-0 flex-1 break-words">{label}</span>
    </button>
  );
}

/**
 * The agent's clarifying questions (`ask_user`), in the composer's place while
 * the run waits on them. One question at a time: pick a suggested answer (a
 * single choice moves on by itself), several for a multiple one, or write your
 * own — always possible, and all there is for an open question. The last step
 * sends every answer at once (a strip of them above, to revisit any); "Skip"
 * lets the agent decide without them.
 *
 * Shaped and lit like the composer it stands in for (composer.css): the same
 * card, radius and travelling light, which quickens while the answers send.
 * Each question slides in from the side it comes from and the card eases to
 * its height; reduced motion keeps only fades.
 */
export function AskUserTakeover({ interrupt, agentName, onResolve }: AskUserTakeoverProps) {
  const reduce = useReducedMotion() ?? false;
  const parsed = useMemo(() => askUserQuestions(interrupt.content), [interrupt.content]);
  const questions = parsed.length ? parsed : [FALLBACK_QUESTION];
  const total = questions.length;

  const [answers, setAnswers] = useState<AskUserAnswer[]>(() => emptyAnswers(questions));
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [busy, setBusy] = useState<"send" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The orb arrives thinking (the agent just asked) and settles to idle.
  const [arriving, setArriving] = useState(true);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = useMeasuredHeight<HTMLDivElement>();
  const titleId = useId();
  const questionId = useId();

  const question = questions[step] ?? questions[0];
  const answer = answers[step] ?? { id: question.id, selected: [], text: "" };
  const isLast = step === total - 1;
  const answeredCount = answers.filter(isAskUserAnswered).length;
  const hasOptions = question.options.length > 0;
  const twoColumns =
    question.options.length > 1 &&
    question.options.every((option) => option.length <= SHORT_OPTION_CHARS);

  useEffect(() => {
    const timer = setTimeout(() => setArriving(false), 1400);
    return () => {
      clearTimeout(timer);
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, []);

  // The question on screen. Looked up by its step rather than held in a ref: the
  // one sliding out still shares the container until its exit ends.
  const bodyRef = body.ref;
  const currentStep = useCallback(
    () => bodyRef.current?.querySelector<HTMLElement>(`[data-step="${step}"]`) ?? null,
    [bodyRef, step],
  );

  // Each step starts where the hand is: the chosen option, else the first one,
  // else (an open question) the answer field.
  useEffect(() => {
    const root = currentStep();
    if (!root) return;
    const target =
      root.querySelector<HTMLElement>('[aria-checked="true"]') ??
      root.querySelector<HTMLElement>("[data-option-index]") ??
      root.querySelector<HTMLElement>("textarea");
    target?.focus({ preventScroll: true });
  }, [currentStep]);

  // The answer field grows with what is written (up to its max height).
  useLayoutEffect(() => {
    const field = currentStep()?.querySelector("textarea");
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [answer.text, currentStep]);

  const clearAdvance = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  };

  const goTo = (target: number) => {
    clearAdvance();
    const next = Math.max(0, Math.min(target, total - 1));
    if (next === step) return;
    setDirection(next > step ? 1 : -1);
    setStep(next);
  };

  const update = (change: (current: AskUserAnswer) => AskUserAnswer) =>
    setAnswers((current) => current.map((item, index) => (index === step ? change(item) : item)));

  const toggle = (option: string) => {
    if (busy) return;
    setError(null);
    if (question.multiple) {
      update((current) => ({
        ...current,
        selected: current.selected.includes(option)
          ? current.selected.filter((item) => item !== option)
          : [...current.selected, option],
      }));
      return;
    }
    const picking = !answer.selected.includes(option);
    update((current) => ({ ...current, selected: picking ? [option] : [] }));
    // A single-choice pick answers the question: let it land, then move on.
    if (picking && !isLast && !answer.text.trim()) {
      clearAdvance();
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setDirection(1);
        setStep((current) => Math.min(current + 1, total - 1));
      }, AUTO_ADVANCE_MS);
    }
  };

  const send = async () => {
    if (busy || answeredCount === 0) return;
    clearAdvance();
    setBusy("send");
    setError(null);
    // Picks in the order they were offered, words trimmed.
    const payload = questions.map((item, index) => {
      const current = answers[index];
      return {
        id: item.id,
        selected: item.options.filter((option) => current?.selected.includes(option)),
        text: current?.text.trim() ?? "",
      };
    });
    try {
      await onResolve({ decision: "approve", value: { answers: payload } });
    } catch {
      setBusy(null);
      setError("Your answers weren't sent — they're still here, try again.");
    }
  };

  const skip = async () => {
    if (busy) return;
    clearAdvance();
    setBusy("skip");
    setError(null);
    try {
      await onResolve({ decision: "reject" });
    } catch {
      setBusy(null);
      setError("Couldn't skip — try again.");
    }
  };

  const next = () => {
    if (isLast) void send();
    else goTo(step + 1);
  };

  // Keys 1–6 pick an option — unless the user is typing, or focus is in some
  // other surface (a dialog, the sidebar): only from the panel or the page.
  const panelRef = useRef<HTMLElement>(null);
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event) => {
    if (busy || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;
    const active = document.activeElement;
    const inPanel = !active || active === document.body || panelRef.current?.contains(active);
    if (!inPanel) return;
    const key = Number(event.key);
    if (!Number.isInteger(key) || key < 1 || key > question.options.length) return;
    event.preventDefault();
    toggle(question.options[key - 1]);
    currentStep()
      ?.querySelector<HTMLElement>(`[data-option-index="${key - 1}"]`)
      ?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // Arrow keys walk the options (and on into the answer field).
  const onOptionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (!delta) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-option-index]")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const target = items[index + delta];
    if (target) target.focus();
    else if (delta === 1) currentStep()?.querySelector("textarea")?.focus();
  };

  const name = agentName?.trim() || "The agent";
  const title = total > 1 ? "A few quick questions" : `${name} has a question`;
  const subtitle =
    total > 1
      ? `${name} · question ${step + 1} of ${total}`
      : "It's paused until you answer — or let it decide.";
  const hint = !hasOptions
    ? "Answer in your own words"
    : question.multiple
      ? "Choose all that apply, or write your own"
      : "Choose one, or write your own";
  const sendLabel = total > 1 ? "Send answers" : "Send answer";

  const slide: Variants = {
    enter: (dir: 1 | -1) => (reduce ? { opacity: 0 } : { opacity: 0, x: dir * 36 }),
    center: {
      opacity: 1,
      x: 0,
      transition: reduce
        ? { duration: 0.16 }
        : { duration: 0.34, ease: EASE_ENTER, staggerChildren: 0.03, delayChildren: 0.04 },
    },
    exit: (dir: 1 | -1) =>
      reduce
        ? { opacity: 0, transition: { duration: 0.1 } }
        : { opacity: 0, x: dir * -28, transition: { duration: 0.18, ease: EASE_EXIT } },
  };
  const rise: Variants = reduce
    ? { enter: { opacity: 1 }, center: { opacity: 1 } }
    : {
        enter: { opacity: 0, y: 6 },
        center: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_ENTER } },
      };

  return (
    <section
      ref={panelRef}
      aria-labelledby={titleId}
      aria-busy={busy !== null}
      className="composer-shell z-20"
      data-busy={busy !== null}
    >
      <div aria-hidden className="composer-glow" />
      <div className="composer-surface">
        {/* A wash of the primary at the top, like light falling on the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-[1.75rem] bg-gradient-to-b from-primary/[0.07] to-transparent"
        />

        <header className="relative flex items-center gap-3 px-4 pt-4 sm:px-5">
          <Orb size={30} state={arriving || busy ? "thinking" : "idle"} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
              {title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
          {total > 1 ? (
            <StepDots
              questions={questions}
              answers={answers}
              step={step}
              disabled={busy !== null}
              onJump={goTo}
            />
          ) : null}
        </header>

        {/* The card eases to the height of the question on screen. */}
        <motion.div
          className="scrollbar-muted relative max-h-[min(30rem,55vh)] overflow-y-auto overflow-x-hidden"
          initial={false}
          animate={{ height: body.height ?? "auto" }}
          transition={reduce ? { duration: 0 } : { duration: 0.34, ease: EASE_ENTER }}
        >
          <div ref={body.ref} className="relative px-4 pb-1 pt-4 sm:px-5">
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.div
                key={step}
                data-step={step}
                custom={direction}
                variants={slide}
                initial="enter"
                animate="center"
                exit="exit"
                className={cn(
                  "transition-opacity duration-200",
                  busy && "pointer-events-none opacity-60",
                )}
              >
                <h3
                  id={questionId}
                  className="text-balance text-[1.05rem] font-semibold leading-snug tracking-[-0.01em] text-foreground sm:text-lg"
                >
                  {question.question}
                </h3>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{hint}</span>
                  {hasOptions ? (
                    <span aria-hidden className="hidden items-center gap-1 sm:inline-flex">
                      Press
                      <kbd className="rounded-md border border-border bg-secondary/60 px-1.5 py-px font-sans text-[10px] font-medium text-foreground/80">
                        1
                      </kbd>
                      {question.options.length > 1 ? (
                        <>
                          –
                          <kbd className="rounded-md border border-border bg-secondary/60 px-1.5 py-px font-sans text-[10px] font-medium text-foreground/80">
                            {question.options.length}
                          </kbd>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </div>

                {hasOptions ? (
                  <div
                    role={question.multiple ? "group" : "radiogroup"}
                    aria-labelledby={questionId}
                    onKeyDown={onOptionsKeyDown}
                    className={cn("mt-3 grid gap-2", twoColumns && "sm:grid-cols-2")}
                  >
                    {question.options.map((option, index) => (
                      <motion.div key={option} variants={rise}>
                        <OptionCard
                          label={option}
                          index={index}
                          chosen={answer.selected.includes(option)}
                          multiple={question.multiple}
                          disabled={busy !== null}
                          onToggle={() => toggle(option)}
                        />
                      </motion.div>
                    ))}
                  </div>
                ) : null}

                <motion.label
                  variants={rise}
                  className={cn(
                    "mt-2 flex cursor-text items-start gap-2.5 rounded-2xl border px-3 transition-[border-color,background-color,box-shadow] duration-200 motion-reduce:transition-none",
                    hasOptions ? "py-2.5" : "mt-3 py-3",
                    "focus-within:border-solid focus-within:border-primary/55 focus-within:bg-card focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.10)]",
                    answer.text.trim()
                      ? "border-solid border-primary/40 bg-card"
                      : hasOptions
                        ? "border-dashed border-border hover:border-primary/35"
                        : "border-border bg-secondary/40",
                  )}
                >
                  <PencilLine
                    aria-hidden
                    className={cn(
                      "mt-[0.2rem] h-4 w-4 shrink-0 transition-colors",
                      answer.text.trim() ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <textarea
                    rows={hasOptions ? 1 : 2}
                    value={answer.text}
                    disabled={busy !== null}
                    onChange={(event) => {
                      setError(null);
                      const text = event.target.value;
                      update((current) => ({ ...current, text }));
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        next();
                      }
                    }}
                    placeholder={hasOptions ? "Write your own answer…" : "Write your answer…"}
                    aria-label={
                      hasOptions ? `Your own answer to: ${question.question}` : question.question
                    }
                    className={cn(
                      "max-h-32 min-w-0 flex-1 resize-none bg-transparent leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60",
                      hasOptions ? "text-sm" : "text-[0.95rem]",
                    )}
                  />
                </motion.label>
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>

        {/* The last step of several: every answer at a glance, each a way back. */}
        <AnimatePresence initial={false}>
          {isLast && total > 1 ? (
            <motion.div
              key="review"
              initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={
                reduce
                  ? { opacity: 1 }
                  : { opacity: 1, height: "auto", transition: { duration: 0.3, ease: EASE_ENTER } }
              }
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, height: 0, transition: { duration: 0.18, ease: EASE_EXIT } }
              }
              className="overflow-hidden"
            >
              <div className="px-4 pt-3 sm:px-5" role="group" aria-label="Your answers">
                <div className="flex flex-wrap gap-1.5 border-t border-border/70 pt-3">
                  {questions.map((item, index) => {
                    const text = askUserAnswerText(answers[index]);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => goTo(index)}
                        disabled={busy !== null}
                        title={item.question}
                        aria-label={`Question ${index + 1}: ${text || "no answer"} — edit`}
                        className={cn(
                          "inline-flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs transition-colors duration-200",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
                          text
                            ? "border-primary/25 bg-primary/[0.07] text-foreground hover:border-primary/45"
                            : "border-dashed border-border text-muted-foreground hover:text-foreground",
                          index === step && "border-primary/50",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                            text
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {index + 1}
                        </span>
                        <span className="truncate sm:max-w-[16rem]">{text || "No preference"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {error ? (
          <p role="alert" className="px-4 pt-2 text-xs text-destructive sm:px-5">
            {error}
          </p>
        ) : null}

        <footer className="relative flex items-center gap-2 px-2.5 pb-2.5 pt-3 sm:px-3.5 sm:pb-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void skip()}
            disabled={busy !== null}
            className="h-10 gap-1.5 rounded-full px-3 font-normal text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:ring-primary/70 focus-visible:ring-offset-card"
          >
            {busy === "skip" ? <Loader2 className="animate-spin" aria-hidden /> : null}
            <span>
              Skip<span className="hidden sm:inline"> — let the agent decide</span>
            </span>
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <AnimatePresence initial={false}>
              {step > 0 ? (
                <motion.span
                  key="back"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.16 }}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => goTo(step - 1)}
                    disabled={busy !== null}
                    aria-label="Previous question"
                    className="h-10 gap-1.5 rounded-full px-3 text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:ring-primary/70 focus-visible:ring-offset-card"
                  >
                    <ArrowLeft aria-hidden />
                    <span className="hidden sm:inline">Back</span>
                  </Button>
                </motion.span>
              ) : null}
            </AnimatePresence>
            {isLast ? (
              <Button
                type="button"
                onClick={() => void send()}
                disabled={busy !== null || answeredCount === 0}
                className="h-10 gap-2 rounded-full px-5 shadow-[0_6px_20px_-8px_hsl(var(--primary)/0.7)] transition-[background-color,box-shadow,transform] duration-200 active:scale-[0.97] focus-visible:ring-primary/70 focus-visible:ring-offset-card disabled:shadow-none motion-reduce:active:scale-100"
              >
                {busy === "send" ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden />
                    Sending…
                  </>
                ) : (
                  <>
                    {sendLabel}
                    <SendHorizontal aria-hidden />
                  </>
                )}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={next}
                disabled={busy !== null}
                className="h-10 gap-1.5 rounded-full px-4 transition-[background-color,transform] duration-200 active:scale-[0.97] focus-visible:ring-primary/70 focus-visible:ring-offset-card motion-reduce:active:scale-100"
              >
                Next
                <ArrowRight aria-hidden />
              </Button>
            )}
          </div>
        </footer>
      </div>
    </section>
  );
}
