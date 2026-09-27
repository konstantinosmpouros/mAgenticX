import { cn } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import type { AgentDraft } from "@/shared/lib/types";

/**
 * AgentSummary — the builder's live preview (plan 20 §5).
 *
 * The agent as it will appear in the agent list, plus what it can do, updated
 * as the form is filled in. That is what makes tools and sub-agents feel real
 * before the agent exists.
 *
 * A strip above the form rather than the plan's right-hand column, on purpose:
 * the settings panel leaves the builder about 45rem, and a side column wide
 * enough to be readable would have squeezed every section's inputs. A strip
 * never competes for width, and it stays in view whichever section is open.
 */

type Props = {
  draft: AgentDraft;
  /** Display label of the agent's model, e.g. "GPT-4o". */
  modelLabel: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function AgentSummary({ draft, modelLabel }: Props) {
  // The same resolver the agent list and composer use, so the preview cannot
  // show an icon the saved agent would not.
  const Icon = mapIcon(draft.icon);
  const subagents = draft.subagents.filter((sa) => sa.name.trim()).length;
  const facts = [
    modelLabel,
    plural(draft.tools.length, "tool", "tools"),
    plural(draft.skills.length, "skill", "skills"),
    plural(subagents, "sub-agent", "sub-agents"),
    draft.memory ? "Memory on" : "Memory off",
  ];

  return (
    <section
      aria-label="Preview"
      className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/30 px-3 py-2.5"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 text-primary">
        <Icon size={17} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-semibold",
            draft.name.trim() ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {draft.name.trim() || "Untitled agent"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {draft.description.trim() || "No description yet"}
        </p>
      </div>
      {/* Capability facts: one line on a wide panel, hidden where they would
          wrap into a second row — the section tabs already carry the counts. */}
      <ul
        aria-label="Capabilities"
        className="hidden shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground lg:flex"
      >
        {facts.map((fact) => (
          <li key={fact} className="rounded-md bg-background/50 px-1.5 py-0.5">
            {fact}
          </li>
        ))}
      </ul>
    </section>
  );
}
