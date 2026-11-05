import { Check, MessagesSquare } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowMemoryMode, WorkflowSpec } from "@/shared/lib/types";
import { MEMORY_CHOICES, OWN_THREAD } from "@/features/workflows/lib/builder/consts";
import { sharedWith, threadOptions } from "@/features/workflows/lib/builder/stepData";
import { ChoiceSelect } from "./Controls";

/**
 * An llm step's conversation, as one block: whether it remembers its earlier
 * turns (`memory`: across a loop's iterations, say) or starts fresh, and
 * whose conversation it talks in (`thread`: its own, or another llm step's
 * by id). Says who else shares it, so a shared thread is never a surprise.
 */
export function ConversationField({
  id,
  nodeId,
  spec,
  memory,
  memoryOptions,
  thread,
  onMemory,
  onThread,
  memoryInvalid,
  threadInvalid,
}: {
  id: string;
  nodeId: string;
  spec?: WorkflowSpec;
  /** The stored memory (or the schema's default); null when the kind has no memory field. */
  memory: string | null;
  /** The memory values the schema allows. */
  memoryOptions: readonly string[];
  thread: string;
  onMemory: (memory: WorkflowMemoryMode) => void;
  onThread: (thread: string) => void;
  memoryInvalid?: boolean;
  threadInvalid?: boolean;
}) {
  const choices = MEMORY_CHOICES.filter((choice) => memoryOptions.includes(choice.value));
  const others = spec ? threadOptions(spec, nodeId) : [];
  const own = !thread || thread === nodeId;
  const options = [
    { value: OWN_THREAD, label: "This step only" },
    ...others.map((step) => ({ value: step.id, label: step.label })),
    // A thread naming no llm step (deleted, or typed in JSON): shown so the select says what is stored.
    ...(!own && !others.some((step) => step.id === thread) ? [{ value: thread, label: `${thread} (not an LLM step)` }] : []),
  ];
  const shared = spec ? sharedWith(spec, nodeId) : [];
  const shareId = `${id}-share`;

  return (
    <div className="space-y-3">
      {memory !== null && choices.length ? (
        <div role="radiogroup" aria-label="Memory" aria-invalid={memoryInvalid || undefined} className="space-y-1.5">
          {choices.map((choice) => {
            const active = memory === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onMemory(choice.value)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  active
                    ? "border-primary/45 bg-primary/[0.06]"
                    : "border-border/60 bg-background/50 hover:border-border hover:bg-[hsl(var(--hover-surface))]",
                )}
              >
                <span
                  className={cn(
                    "mt-[1px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                  aria-hidden
                >
                  {active ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-foreground">{choice.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{choice.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div>
        <label htmlFor={shareId} className="mb-1.5 block text-xs font-medium text-foreground/80">
          Share with
        </label>
        <ChoiceSelect
          id={shareId}
          value={own ? OWN_THREAD : thread}
          options={options}
          onChange={(next) => onThread(next === OWN_THREAD ? "" : next)}
          invalid={threadInvalid}
        />
        {shared.length ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <MessagesSquare className="mt-[2px] h-3.5 w-3.5 flex-shrink-0 text-primary/70" aria-hidden />
            <span className="min-w-0 break-words">
              Shared with: <span className="text-foreground/85">{shared.map((step) => step.label).join(", ")}</span>
            </span>
          </p>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Pick another LLM step to continue its conversation instead of starting this step&apos;s own.
          </p>
        )}
      </div>
    </div>
  );
}
