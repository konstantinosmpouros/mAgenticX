import { Plus } from "lucide-react";

import { BrandMark } from "@/shared/ui/brand-mark";
import { PRIMARY_BUTTON } from "@/features/automations/lib/styles";

/**
 * The Automations page with nothing in it yet: a hero and "Create from
 * scratch". The template section renders right under it and is the page's
 * main content in this state, so there is no "Browse templates" detour.
 */
export function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-6 pb-10 pt-6 text-center">
      <BrandMark size={84} />
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold text-foreground">No automations yet</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Let an agent work on its own — once, on a repeat, or on a calendar — and find the result
          waiting. Start from scratch, or pick a template below.
        </p>
      </div>
      <button type="button" onClick={onCreate} className={PRIMARY_BUTTON}>
        <Plus className="h-4 w-4" aria-hidden />
        Create from scratch
      </button>
    </div>
  );
}
