import type * as React from "react";
import { Plus } from "lucide-react";

import { BrandMark } from "@/shared/ui/brand-mark";
import { PRIMARY_BUTTON } from "@/features/automations/lib/styles";

/**
 * An Automations area with nothing in it yet: a hero and its create action.
 * The Schedules area's template section renders right under it and is the
 * page's main content in that state, so there is no "Browse templates" detour.
 * The defaults are the Schedules area's words; the Workflows area passes its own.
 */
export function EmptyState({
  onCreate,
  title = "No automations yet",
  description = "Let an agent work on its own — once, on a repeat, or on a calendar — and find the result waiting. Start from scratch, or pick a template below.",
  actionLabel = "Create from scratch",
}: {
  onCreate: () => void;
  title?: string;
  description?: React.ReactNode;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-6 pb-10 pt-6 text-center">
      <BrandMark size={84} />
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <button type="button" onClick={onCreate} className={PRIMARY_BUTTON}>
        <Plus className="h-4 w-4" aria-hidden />
        {actionLabel}
      </button>
    </div>
  );
}
