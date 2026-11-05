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
      className="group relative flex h-full items-start gap-3 overflow-hidden rounded-xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--secondary)/0.55)_100%)] px-3.5 py-3 text-left shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] transition-[border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:border-primary/30 supports-[hover:hover]:hover:shadow-card"
    >
      <span className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform duration-300 ease-out motion-safe:group-hover:scale-105">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="relative flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-semibold leading-snug text-foreground">{template.label}</span>
        <span className="mt-0.5 line-clamp-1 text-xs leading-relaxed text-muted-foreground">{template.description}</span>
        <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <CalendarClock className="h-3 w-3 flex-shrink-0 text-primary" aria-hidden />
          <span className="truncate">{template.scheduleLabel}</span>
        </span>
      </span>
    </motion.button>
  );
}
