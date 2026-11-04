import { motion } from "framer-motion";
import { CalendarClock } from "lucide-react";

import type { AutomationTemplate } from "@/shared/lib/types";

/**
 * One template in "Start from a template". A click goes straight to the create
 * dialog, filled in from the template — the dialog is the preview.
 */
export function TemplateCard({
  template,
  onUse,
  index,
  reduceMotion,
}: {
  template: AutomationTemplate;
  onUse: (template: AutomationTemplate) => void;
  index: number;
  reduceMotion: boolean;
}) {
  const Icon = template.icon;
  return (
    <motion.button
      type="button"
      onClick={() => onUse(template)}
      data-testid="template-card"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.26, ease: [0.22, 1, 0.36, 1], delay: Math.min(index * 0.04, 0.32) }
      }
      whileHover={reduceMotion ? undefined : { y: -2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
      className="group relative flex h-full flex-col gap-3 overflow-hidden rounded-2xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.55)_100%)] p-4 text-left shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] transition-[border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:border-primary/30 supports-[hover:hover]:hover:shadow-card"
    >
      <span className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-primary/[0.05] to-transparent" />
      <span className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform duration-300 ease-out motion-safe:group-hover:scale-105">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <div className="relative text-sm font-semibold leading-snug text-foreground">
        {template.label}
      </div>
      <p className="relative line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {template.description}
      </p>
      <div className="relative mt-auto inline-flex items-center gap-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5 text-primary" aria-hidden />
        {template.scheduleLabel}
      </div>
    </motion.button>
  );
}
