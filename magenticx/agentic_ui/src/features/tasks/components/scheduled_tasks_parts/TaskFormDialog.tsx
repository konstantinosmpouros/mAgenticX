import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CalendarPlus, Pencil, X } from "lucide-react";

import type { Agent, ScheduledTaskCreatePayload } from "@/shared/lib/types";
import ScheduledTaskForm, {
  type ScheduledTaskFormInitial,
} from "@/features/tasks/components/scheduled_tasks_parts/ScheduledTaskForm";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

type TaskFormDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  /** Changes whenever a new form should start (another task, a template). */
  formKey: string;
  agents: Agent[];
  initial?: ScheduledTaskFormInitial;
  submitting: boolean;
  submitError?: string | null;
  onSubmit: (payload: ScheduledTaskCreatePayload) => void;
  onClose: () => void;
};

/**
 * The create/edit task dialog: a centred card on desktop, a full-height bottom
 * sheet on phones. Header and footer stay put while the sections scroll.
 * Radix owns focus trapping and Esc.
 */
export function TaskFormDialog({
  open,
  mode,
  formKey,
  agents,
  initial,
  submitting,
  submitError,
  onSubmit,
  onClose,
}: TaskFormDialogProps) {
  const editing = mode === "edit";
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={`fixed inset-0 z-[92] bg-black/55 backdrop-blur-[2px] ${RADIX_MOTION.backdrop}`}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Land on the instruction rather than the close button — on a
            // pointer device; on touch, focusing would throw up the keyboard
            // over the sheet before the user has read it.
            event.preventDefault();
            if (!window.matchMedia?.("(hover: hover)").matches) {
              (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
              return;
            }
            (event.currentTarget as HTMLElement | null)
              ?.querySelector<HTMLElement>("#task-prompt")
              ?.focus({ preventScroll: true });
          }}
          className={[
            "fixed z-[92] flex flex-col overflow-hidden border border-border/60 bg-card text-card-foreground shadow-[0_28px_80px_-24px_rgba(0,0,0,0.45)] outline-none",
            // Phones: a full-height sheet that rises from the bottom.
            "inset-x-0 bottom-0 h-[calc(100dvh-0.75rem)] rounded-t-[1.6rem]",
            // Desktop: a centred card.
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[min(54rem,calc(100dvh-3rem))] sm:w-[min(40rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[1.6rem]",
            // Shared panel motion: rises as a sheet on phones, settles as a panel above.
            RADIX_MOTION.sheetToPanel,
          ].join(" ")}
        >
          {/* Grab handle on the phone sheet. */}
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-10 flex-shrink-0 rounded-full bg-muted-foreground/25 sm:hidden"
          />
          <div className="relative flex flex-shrink-0 items-center gap-3 border-b border-border/60 px-5 pb-4 pt-3 sm:px-6 sm:pt-5">
            <span className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.06] to-transparent" />
            <span className="relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              {editing ? (
                <Pencil className="h-[18px] w-[18px]" aria-hidden />
              ) : (
                <CalendarPlus className="h-[18px] w-[18px]" aria-hidden />
              )}
            </span>
            <div className="relative min-w-0 flex-1">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight text-foreground">
                {editing ? "Edit scheduled task" : "New scheduled task"}
              </DialogPrimitive.Title>
              <p className="text-xs text-muted-foreground">
                {editing
                  ? "Changes apply from the next run."
                  : "Let an agent run on its own, on your schedule."}
              </p>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              disabled={submitting}
              className="relative grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <ScheduledTaskForm
            key={formKey}
            agents={agents}
            initial={initial}
            submitLabel={editing ? "Save changes" : "Create task"}
            submitting={submitting}
            submitError={submitError}
            onSubmit={onSubmit}
            onCancel={onClose}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
