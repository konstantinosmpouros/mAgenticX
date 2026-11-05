import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CircleAlert, Loader2, Play, X } from "lucide-react";

import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";
import { cn } from "@/shared/lib/utils";
import type { WorkflowInputDef, WorkflowInputDraft, WorkflowInputErrors } from "@/shared/lib/types";
import { buildRunInputs, initialInputDraft } from "@/features/workflows/lib/inputs";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/workflows/lib/consts";
import { errorText } from "@/features/workflows/lib/format";

type RunInputDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowName: string;
  inputs: WorkflowInputDef[];
  /** Starts the run; a rejection (a 409: one already running) shows inline. */
  onStart: (inputs: Record<string, unknown>) => Promise<void>;
};

const TYPE_HINT: Record<WorkflowInputDef["type"], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  object: "JSON object",
  array: "JSON array",
};

function InputField({
  def,
  value,
  error,
  disabled,
  onChange,
}: {
  def: WorkflowInputDef;
  value: string | boolean;
  error?: string;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [def.description ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  if (def.type === "boolean") {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-border/60 px-3.5 py-3">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={describedBy}
          className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-border accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-foreground">
            {def.name}
          </label>
          {def.description ? (
            <p id={hintId} className="text-xs text-muted-foreground">
              {def.description}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const json = def.type === "object" || def.type === "array";
  const common = {
    id,
    value: typeof value === "string" ? value : "",
    disabled,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": def.required ? true : undefined,
  };
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        <span>
          {def.name}
          {def.required ? (
            <span className="ml-0.5 text-destructive" aria-hidden>
              *
            </span>
          ) : null}
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">
          {TYPE_HINT[def.type]}
          {def.required ? "" : " · optional"}
        </span>
      </label>
      {json ? (
        <Textarea
          {...common}
          rows={5}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className={cn("font-mono text-[12.5px]", error && "border-destructive/60")}
        />
      ) : (
        <Input
          {...common}
          inputMode={def.type === "number" ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={cn(error && "border-destructive/60")}
        />
      )}
      {def.description ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {def.description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Run ▸: a small dialog whose form is generated from the workflow's declared
 * inputs (lib/inputs — text, number, yes/no, JSON for objects and arrays,
 * required marks, defaults filled in). A workflow with no inputs gets a plain
 * confirmation. Starting closes the dialog; a refusal (409 — a run is already
 * going) stays inline above the actions with the inputs kept.
 */
export function RunInputDialog({
  open,
  onOpenChange,
  workflowName,
  inputs,
  onStart,
}: RunInputDialogProps) {
  const [draft, setDraft] = React.useState<WorkflowInputDraft>(() => initialInputDraft(inputs));
  const [errors, setErrors] = React.useState<WorkflowInputErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // A fresh form each time it opens (defaults again, no stale errors).
  React.useEffect(() => {
    if (!open) return;
    setDraft(initialInputDraft(inputs));
    setErrors({});
    setSubmitError(null);
  }, [open, inputs]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const built = buildRunInputs(inputs, draft);
    setErrors(built.errors);
    if (Object.keys(built.errors).length) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onStart(built.inputs);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(errorText(err, "Could not start the run."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={`fixed inset-0 z-[92] bg-black/55 backdrop-blur-[2px] ${RADIX_MOTION.backdrop}`}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={[
            "fixed z-[92] flex flex-col overflow-hidden border border-border/60 bg-card text-card-foreground shadow-[0_28px_80px_-24px_rgba(0,0,0,0.45)] outline-none",
            "inset-x-0 bottom-0 max-h-[calc(100dvh-0.75rem)] rounded-t-[1.6rem]",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[min(44rem,calc(100dvh-3rem))] sm:w-[min(32rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[1.6rem]",
            RADIX_MOTION.sheetToPanel,
          ].join(" ")}
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-10 flex-shrink-0 rounded-full bg-muted-foreground/25 sm:hidden"
          />
          <div className="relative flex flex-shrink-0 items-center gap-3 border-b border-border/60 px-5 pb-4 pt-3 sm:px-6 sm:pt-5">
            <span className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.06] to-transparent" />
            <span className="relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Play className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div className="relative min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-base font-semibold leading-tight text-foreground">
                Run {workflowName}
              </DialogPrimitive.Title>
              <p className="text-xs text-muted-foreground">
                {inputs.length
                  ? "Fill in the inputs this workflow takes."
                  : "This workflow takes no inputs."}
              </p>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              disabled={submitting}
              className="relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-full text-muted-foreground transition-[background-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>

          <form
            onSubmit={(event) => void submit(event)}
            className="flex min-h-0 flex-1 flex-col"
            noValidate
          >
            {inputs.length ? (
              <div className="scrollbar-muted min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
                {inputs.map((def) => (
                  <InputField
                    key={def.name}
                    def={def}
                    value={draft[def.name] ?? (def.type === "boolean" ? false : "")}
                    error={errors[def.name]}
                    disabled={submitting}
                    onChange={(value) => setDraft((current) => ({ ...current, [def.name]: value }))}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex-shrink-0 space-y-3 border-t border-border/60 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
              {submitError ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
                >
                  <CircleAlert className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                  {submitError}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <DialogPrimitive.Close
                  type="button"
                  disabled={submitting}
                  className={SECONDARY_BUTTON}
                >
                  Cancel
                </DialogPrimitive.Close>
                <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
                  {submitting ? (
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}
                  Start run
                </button>
              </div>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
