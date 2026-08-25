import type { ComponentType } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Hourglass, type LucideProps } from "lucide-react";

import { SoftPanel } from "./shared";

/**
 * ComingSoon — the "not implemented yet" settings surface.
 *
 * The profile panel mirrors ChatGPT's full settings taxonomy; sections we have
 * not built yet still get a nav slot so the structure is complete, and this
 * component is what renders inside them. `ComingSoonRow` is the row-sized
 * variant used to stub individual fields inside otherwise-real sections.
 */
export default function ComingSoon({
  icon: Icon,
  title,
  description,
  notes = [],
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  description: string;
  /** Planned capabilities, listed so the empty state still informs. */
  notes?: string[];
}) {
  const reduceMotion = useReducedMotion();
  const rise = (delay: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: "easeOut" as const, delay },
  });

  return (
    <div className="flex min-h-[22rem] items-center justify-center py-10">
      <div className="flex max-w-md flex-col items-center text-center">
        <motion.div
          {...rise(0)}
          className="flex h-16 w-16 items-center justify-center rounded-3xl border border-border/50 bg-muted/40 text-primary shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)]"
        >
          <Icon size={28} strokeWidth={1.75} aria-hidden />
        </motion.div>

        <motion.h3
          {...rise(0.06)}
          className="mt-5 text-lg font-semibold tracking-tight text-foreground"
        >
          {title}
        </motion.h3>

        <motion.p {...rise(0.12)} className="mt-2 text-sm leading-6 text-muted-foreground">
          {description}
        </motion.p>

        <motion.span
          {...rise(0.18)}
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        >
          <Hourglass size={12} aria-hidden />
          Not implemented yet
        </motion.span>

        {notes.length > 0 ? (
          <motion.div {...rise(0.24)} className="mt-6 w-full">
            <SoftPanel className="divide-y divide-border/40 overflow-hidden text-left">
              {notes.map((note) => (
                <div key={note} className="px-4 py-3">
                  <p className="text-xs leading-5 text-muted-foreground">{note}</p>
                </div>
              ))}
            </SoftPanel>
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}

/** Row-sized stub for a single not-yet-built field inside a real section. */
export const ComingSoonRow = ({ title, description }: { title: string; description: string }) => (
  <div className="px-5 py-4">
    <div className="flex items-start justify-between gap-4 opacity-75">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Soon
      </span>
    </div>
  </div>
);
