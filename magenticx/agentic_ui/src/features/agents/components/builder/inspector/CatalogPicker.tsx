import { useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  VoiceSelector,
  VoiceSelectorContent,
  VoiceSelectorEmpty,
  VoiceSelectorGroup,
  VoiceSelectorInput,
  VoiceSelectorItem,
  VoiceSelectorList,
  VoiceSelectorName,
  VoiceSelectorTrigger,
} from "@/shared/ui/ai-elements/voice-selector";
import { SMALL_BUTTON } from "./fields";

/**
 * The one searchable "add" picker the builder uses — MCP tools (grouped by
 * server) and skills from the pool. Picking adds and keeps the list open, so
 * five tools are five clicks rather than five round trips; what is already
 * added shows a check and can be picked again to take it off.
 */

export type PickerItem = {
  key: string;
  title: string;
  subtitle?: string;
  /** Extra words the search matches on. */
  keywords?: string;
  badge?: ReactNode;
};

export type PickerGroup = { heading: string; items: PickerItem[] };

export function CatalogPicker({
  label,
  title,
  placeholder,
  empty,
  groups,
  selected,
  onToggle,
  disabled,
  icon,
}: {
  /** The trigger's text. */
  label: string;
  title: string;
  placeholder: string;
  empty: string;
  groups: PickerGroup[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
  icon: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <VoiceSelector open={open} onOpenChange={setOpen}>
      <VoiceSelectorTrigger asChild>
        <button type="button" disabled={disabled} className={SMALL_BUTTON}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      </VoiceSelectorTrigger>
      <VoiceSelectorContent
        title={title}
        className="max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
      >
        <VoiceSelectorInput placeholder={placeholder} />
        <VoiceSelectorList className="max-h-[24rem]">
          <VoiceSelectorEmpty>{empty}</VoiceSelectorEmpty>
          {groups.map((group) => (
            <VoiceSelectorGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => {
                const on = selected.has(item.key);
                return (
                  <VoiceSelectorItem
                    key={item.key}
                    value={`${item.key} ${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""}`}
                    onSelect={() => onToggle(item.key)}
                    className="items-center gap-3 rounded-xl px-3 py-2.5"
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-lg border",
                        on
                          ? "border-primary/40 bg-primary/15 text-primary"
                          : "border-border/60 bg-muted/40 text-muted-foreground",
                      )}
                    >
                      {on ? <Check className="h-3.5 w-3.5" aria-hidden /> : icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <VoiceSelectorName>{item.title}</VoiceSelectorName>
                      {item.subtitle ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      ) : null}
                    </span>
                    {item.badge}
                    <span className="sr-only">{on ? "(added — select to remove)" : ""}</span>
                  </VoiceSelectorItem>
                );
              })}
            </VoiceSelectorGroup>
          ))}
        </VoiceSelectorList>
      </VoiceSelectorContent>
    </VoiceSelector>
  );
}
