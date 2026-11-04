import * as React from "react";
import { ChevronDown } from "lucide-react";

import type { AutomationTemplate } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { AUTOMATION_TEMPLATES } from "@/features/automations/lib/templates";
import { TemplateCard } from "@/features/automations/components/automations_parts/TemplateCard";

const EYEBROW = "text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground";

/** How many templates the compact section shows before "Show all". */
const COMPACT_COUNT = 4;

/** Templates grouped by category, in first-seen order (the data file's order). */
function groupByCategory(templates: AutomationTemplate[]): [string, AutomationTemplate[]][] {
  const groups = new Map<string, AutomationTemplate[]>();
  for (const template of templates) {
    const group = groups.get(template.category);
    if (group) group.push(template);
    else groups.set(template.category, [template]);
  }
  return [...groups.entries()];
}

/**
 * "Start from a template": the template gallery on the Automations page, under
 * the list (or under the empty state's hero, where it is the main content).
 *
 * `compact` (the user has automations) shows the first few with "Show all",
 * which expands in place; otherwise every template shows. Category headings
 * appear only once there is more than one category.
 */
export function TemplateSection({
  compact,
  onUse,
  reduceMotion,
}: {
  compact: boolean;
  onUse: (template: AutomationTemplate) => void;
  reduceMotion: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const collapsed = compact && !expanded && AUTOMATION_TEMPLATES.length > COMPACT_COUNT;
  const shown = collapsed ? AUTOMATION_TEMPLATES.slice(0, COMPACT_COUNT) : AUTOMATION_TEMPLATES;
  const groups = groupByCategory(shown);
  const showCategories = groupByCategory(AUTOMATION_TEMPLATES).length > 1;
  const headingId = React.useId();

  let index = 0;
  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          Start from a template
        </h2>
        {compact && AUTOMATION_TEMPLATES.length > COMPACT_COUNT ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
          >
            {expanded ? "Show fewer" : `Show all ${AUTOMATION_TEMPLATES.length}`}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      <div className="mt-3 space-y-5">
        {groups.map(([category, templates]) => (
          <div key={category}>
            {showCategories ? <p className={cn(EYEBROW, "mb-3")}>{category}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  index={index++}
                  reduceMotion={reduceMotion}
                  onUse={onUse}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
