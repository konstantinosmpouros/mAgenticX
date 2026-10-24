import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * A branch of a composer panel (the agent map's answers and sub-agents, the
 * plan's earlier plans) opening and closing: its height eases open, its
 * content fades. Reduced motion: a fade only.
 */
export function Collapse({
  open,
  id,
  children,
}: {
  open: boolean;
  /** For the toggle's `aria-controls`. */
  id?: string;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  // Clipped only while the height animates: at rest a running card's light and
  // glow (styles/subagent.css) reach past its edges and must not be cut off.
  const [animating, setAnimating] = React.useState(false);
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          id={id}
          initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: { duration: 0.28, ease: EASE } }}
          exit={
            reduceMotion
              ? { opacity: 0, transition: { duration: 0.1 } }
              : { height: 0, opacity: 0, transition: { duration: 0.2, ease: "easeIn" } }
          }
          onAnimationStart={() => setAnimating(true)}
          onAnimationComplete={() => setAnimating(false)}
          style={{ overflow: animating ? "hidden" : "visible" }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
