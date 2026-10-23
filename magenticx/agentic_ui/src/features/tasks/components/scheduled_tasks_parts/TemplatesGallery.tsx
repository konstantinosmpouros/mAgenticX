import * as React from "react";
import { motion } from "framer-motion";
import { ArrowLeft, CalendarClock, MessageSquare, Plus, Search } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { targetModeLabel } from "@/features/tasks/lib/schedule";
import {
  TASK_TEMPLATES,
  type ScheduledTaskTemplate,
} from "@/features/tasks/components/scheduled_tasks_parts/templates";

const EYEBROW = "text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground";

function TemplateCard({
  template,
  onOpen,
  index,
  reduceMotion,
}: {
  template: ScheduledTaskTemplate;
  onOpen: () => void;
  index: number;
  reduceMotion: boolean;
}) {
  const Icon = template.icon;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
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

function TemplateDetail({
  template,
  onBack,
  onUse,
}: {
  template: ScheduledTaskTemplate;
  onBack: () => void;
  onUse: () => void;
}) {
  const Icon = template.icon;
  const detailRows: [string, string][] = [
    ["Repeats", template.scheduleLabel],
    ["Results", targetModeLabel(template.targetMode)],
    ["Agent", "Chosen on import"],
    ["Tools", "Your current tools"],
  ];
  return (
    <div className="mx-auto w-full max-w-2xl">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Templates
      </button>

      <div className="mt-5 flex items-center gap-4">
        <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-7 w-7" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{template.label}</h2>
          <p className="text-sm text-muted-foreground">{template.description}</p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-border/70 bg-card p-5">
        <p className={EYEBROW}>Instruction</p>
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
          {template.instructions}
        </p>
      </div>

      <div className="mt-4 divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/70 bg-card">
        {detailRows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-5 py-3 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium text-foreground">{value}</span>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <button
          type="button"
          onClick={onUse}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Use this template
        </button>
      </div>
    </div>
  );
}

/** The Templates tab: a searchable grid, and a template's detail page. */
export function TemplatesGallery({
  selected,
  onSelect,
  onUse,
  reduceMotion,
}: {
  selected: ScheduledTaskTemplate | null;
  onSelect: (template: ScheduledTaskTemplate | null) => void;
  onUse: (template: ScheduledTaskTemplate) => void;
  reduceMotion: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TASK_TEMPLATES;
    return TASK_TEMPLATES.filter((t) =>
      [t.label, t.description, t.instructions].some((field) => field.toLowerCase().includes(q)),
    );
  }, [query]);

  if (selected) {
    return (
      <TemplateDetail
        template={selected}
        onBack={() => onSelect(null)}
        onUse={() => onUse(selected)}
      />
    );
  }

  return (
    <div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          aria-label="Search templates"
          className="h-11 w-full rounded-xl border border-border/70 bg-card pl-10 pr-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:ring-4 focus-visible:ring-primary/15"
          spellCheck={false}
        />
      </div>

      <p className={cn(EYEBROW, "mt-6")}>System</p>
      <div className="mt-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/80 py-10 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-5 w-5" aria-hidden />
            No matching templates.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((template, index) => (
              <TemplateCard
                key={template.id}
                template={template}
                index={index}
                reduceMotion={reduceMotion}
                onOpen={() => onSelect(template)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
