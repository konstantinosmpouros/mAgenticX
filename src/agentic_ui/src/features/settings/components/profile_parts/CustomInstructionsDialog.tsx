import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { NotebookPen } from "lucide-react";

import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import { CUSTOM_INSTRUCTIONS_LIMITS } from "@/shared/lib/consts";
import { cn } from "@/shared/lib/utils";
import type { CustomInstructions } from "@/shared/lib/types";
import { ToggleSwitch } from "./shared";

/**
 * CustomInstructionsDialog — the "Custom instructions" editor opened from
 * Settings → Personalization (mirroring ChatGPT's dialog: nickname, occupation,
 * response traits, extra context, plus the enable toggle). Rendered as a
 * sibling of the settings shell — never nested inside it — because
 * PremiumModalShell doesn't portal and the shell's enter animation would trap
 * a nested fixed overlay. Saves the whole document in one preferences PUT and
 * closes only on success, so a failed save never discards the user's text.
 */
type CustomInstructionsDialogProps = {
  open: boolean;
  onClose: () => void;
  value: CustomInstructions;
  saving?: boolean;
  /** Persists the document; resolves true on success (dialog closes). */
  onSave?: (value: CustomInstructions) => Promise<boolean>;
};

const inputClass =
  "w-full rounded-2xl border border-white/[0.12] bg-white/[0.045] px-4 py-3 text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition placeholder:text-white/30 focus:border-white/30 focus:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/25";

const FieldLabel = ({ label, count, max }: { label: string; count: number; max: number }) => (
  <div className="mb-2 flex items-end justify-between gap-3">
    <p className="text-sm font-semibold text-white/85">{label}</p>
    <p
      className={cn(
        "text-[0.68rem] font-medium tabular-nums text-white/35",
        count >= max && "text-destructive",
      )}
    >
      {count}/{max}
    </p>
  </div>
);

export default function CustomInstructionsDialog({
  open,
  onClose,
  value,
  saving = false,
  onSave,
}: CustomInstructionsDialogProps) {
  const reduceMotion = useReducedMotion();
  const [draft, setDraft] = useState<CustomInstructions>(value);

  // Re-seed the draft from the persisted value every time the dialog opens,
  // so a previously cancelled edit never leaks into the next session.
  useEffect(() => {
    if (open) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes only this dialog: a capture-phase listener stops the event
  // before the app-wide shortcut handler (bubble phase) would also dismiss
  // the settings panel underneath in the same keypress.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, onClose]);

  const setField = (key: keyof CustomInstructions, fieldValue: string | boolean) =>
    setDraft((prev) => ({ ...prev, [key]: fieldValue }));

  const handleSave = async () => {
    if (!onSave || saving) return;
    const ok = await onSave(draft);
    if (ok) onClose();
  };

  const fieldMotion = (index: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.22, ease: "easeOut" as const, delay: 0.04 + index * 0.045 },
  });

  return (
    <PremiumModalShell
      open={open}
      onClose={onClose}
      closeLabel="Close custom instructions"
      className="max-w-xl"
    >
      <div className="flex max-h-[min(46rem,88vh)] flex-col">
        <div className="px-6 pt-6 md:px-7">
          <div className="flex items-center gap-3 pr-12">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <NotebookPen size={18} aria-hidden />
            </span>
            <div>
              <h3 className="text-xl font-semibold leading-tight tracking-tight text-white">
                Custom instructions
              </h3>
              <p className="mt-0.5 text-sm text-white/50">
                Applied to every conversation with your agents.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-2 md:px-7">
          <motion.div {...fieldMotion(0)}>
            <FieldLabel
              label="What should the agents call you?"
              count={draft.nickname.length}
              max={CUSTOM_INSTRUCTIONS_LIMITS.nickname}
            />
            <input
              type="text"
              value={draft.nickname}
              maxLength={CUSTOM_INSTRUCTIONS_LIMITS.nickname}
              onChange={(event) => setField("nickname", event.target.value)}
              placeholder="Nickname"
              aria-label="What should the agents call you?"
              className={inputClass}
            />
          </motion.div>

          <motion.div {...fieldMotion(1)}>
            <FieldLabel
              label="What do you do?"
              count={draft.occupation.length}
              max={CUSTOM_INSTRUCTIONS_LIMITS.occupation}
            />
            <input
              type="text"
              value={draft.occupation}
              maxLength={CUSTOM_INSTRUCTIONS_LIMITS.occupation}
              onChange={(event) => setField("occupation", event.target.value)}
              placeholder="Occupation or role"
              aria-label="What do you do?"
              className={inputClass}
            />
          </motion.div>

          <motion.div {...fieldMotion(2)}>
            <FieldLabel
              label="What traits should the agents have?"
              count={draft.traits.length}
              max={CUSTOM_INSTRUCTIONS_LIMITS.traits}
            />
            <textarea
              value={draft.traits}
              maxLength={CUSTOM_INSTRUCTIONS_LIMITS.traits}
              onChange={(event) => setField("traits", event.target.value)}
              placeholder="Describe or select traits — e.g. direct, skeptical, detail-oriented…"
              aria-label="What traits should the agents have?"
              rows={4}
              className={cn(inputClass, "resize-none leading-6")}
            />
          </motion.div>

          <motion.div {...fieldMotion(3)}>
            <FieldLabel
              label="Anything else the agents should know about you?"
              count={draft.about.length}
              max={CUSTOM_INSTRUCTIONS_LIMITS.about}
            />
            <textarea
              value={draft.about}
              maxLength={CUSTOM_INSTRUCTIONS_LIMITS.about}
              onChange={(event) => setField("about", event.target.value)}
              placeholder="Interests, ongoing projects, values, context worth remembering…"
              aria-label="Anything else the agents should know about you?"
              rows={4}
              className={cn(inputClass, "resize-none leading-6")}
            />
          </motion.div>
        </div>

        <div className="border-t border-white/[0.08] px-6 py-4 md:px-7">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white/85">Enable for new messages</p>
              <p className="mt-0.5 text-xs text-white/45">
                Turn off to keep the text saved without applying it.
              </p>
            </div>
            <ToggleSwitch
              checked={draft.enabled}
              disabled={saving}
              onToggle={() => setField("enabled", !draft.enabled)}
              label="Enable custom instructions"
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-11 rounded-full border border-white/[0.14] bg-white/[0.06] px-5 text-sm font-semibold text-white shadow-lg transition hover:scale-[1.03] hover:bg-white/[0.1] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="h-11 rounded-full bg-white px-6 text-sm font-semibold text-black shadow-lg transition hover:scale-[1.03] hover:bg-white/90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </PremiumModalShell>
  );
}
