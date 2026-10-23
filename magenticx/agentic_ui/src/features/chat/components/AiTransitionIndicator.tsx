import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Orb } from "@/shared/ui/orb";

/**
 * The bridge between sending and the agent's first signal: a small thinking orb
 * where the answer will start (the empty reply row collapses meanwhile, see
 * ChatMessage). When the first content arrives it fades out in place — popped
 * out of the layout, so the answer takes its spot while it goes — and the
 * answer's own entrance plays over it.
 */
export function AiTransitionIndicator({ visible }: { visible: boolean }) {
  const rm = useReducedMotion() ?? false;
  return (
    <AnimatePresence mode="popLayout">
      {visible ? (
        <motion.div
          key="ai-transition"
          role="status"
          aria-label="Waiting for the reply"
          className="flex justify-start"
          initial={{ opacity: 0, scale: rm ? 1 : 0.8 }}
          animate={{
            opacity: 1,
            scale: 1,
            transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
          }}
          exit={{
            opacity: 0,
            scale: rm ? 1 : 0.85,
            transition: { duration: rm ? 0.12 : 0.28, ease: "easeIn" },
          }}
        >
          <Orb state="thinking" size={26} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
