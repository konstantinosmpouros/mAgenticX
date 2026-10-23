import { Radio } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import { Orb } from "@/shared/ui/orb";
import { orbStateForVoice } from "@/features/voice/lib/voiceOrb";
import type { Agent, VoiceModeStatus } from "@/shared/lib/types";

type VoiceModeBodyProps = {
  status: VoiceModeStatus;
  muted: boolean;
  currentAgent?: Agent | null;
  errorMessage?: string | null;
};

const labelForStatus = (status: VoiceModeStatus, muted: boolean) => {
  if (muted) return "Microphone muted";
  if (status === "connecting") return "Connecting voice session";
  if (status === "listening") return "Listening";
  if (status === "thinking") return "Thinking";
  if (status === "speaking") return "Speaking";
  if (status === "error") return "Voice session interrupted";
  return "Voice mode";
};

const EASE = [0.22, 1, 0.36, 1] as const;

// Driven by the panel that swaps the chat and voice surfaces (ChatView's
// `hidden` / `shown` / `exit`): the orb scales in first, then the status, the
// name and the line under it; leaving, they go in reverse, quicker. Reduced
// motion: a plain fade.
const orbVariants: Variants = {
  hidden: { opacity: 0, scale: 0.82 },
  shown: { opacity: 1, scale: 1, transition: { duration: 0.5, ease: EASE } },
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.22, ease: "easeIn" } },
};
const textVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.36, ease: EASE } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.16, ease: "easeIn" } },
};
const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};
const stackVariants: Variants = {
  shown: { transition: { staggerChildren: 0.06 } },
  exit: { transition: { staggerChildren: 0.03, staggerDirection: -1 } },
};

export default function VoiceModeBody({
  status,
  muted,
  currentAgent,
  errorMessage,
}: VoiceModeBodyProps) {
  const statusLabel = labelForStatus(status, muted);
  const rm = useReducedMotion() ?? false;
  const item = rm ? fadeVariants : textVariants;

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center overflow-hidden px-6 py-8">
      <motion.div
        variants={rm ? undefined : stackVariants}
        className="flex w-full max-w-2xl flex-col items-center text-center"
      >
        <motion.div variants={rm ? fadeVariants : orbVariants}>
          <Orb
            state={orbStateForVoice(status, muted)}
            className="size-[clamp(11.5rem,34vw,14rem)]"
          />
        </motion.div>

        <div className="mt-4 space-y-1.5">
          <motion.div
            variants={item}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"
          >
            <Radio size={13} className={status === "speaking" ? "text-primary" : undefined} />
            {statusLabel}
          </motion.div>
          <motion.h2
            variants={item}
            className="text-2xl font-semibold tracking-tight text-foreground"
          >
            {currentAgent?.name || "Voice conversation"}
          </motion.h2>
          <motion.p variants={item} className="mx-auto max-w-md text-sm text-muted-foreground">
            {status === "error"
              ? errorMessage || "Realtime voice is unavailable right now."
              : currentAgent?.description ||
                "Speak naturally. The assistant will listen, think, and answer aloud."}
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
