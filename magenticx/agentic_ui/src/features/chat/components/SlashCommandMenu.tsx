import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Lock, Zap } from "lucide-react";

import { useSpaceAbove } from "@/features/chat/hooks/useSpaceAbove";
import type { SlashComposer } from "@/features/chat/hooks/useSlashCommands";
import { Command, CommandGroup, CommandItem, CommandList } from "@/shared/ui/command";
import { cn } from "@/shared/lib/utils";

/**
 * The composer's `/` menu (plan 35), opened by a bare `/word` in the draft.
 *
 * Built on the shadcn `Command` (cmdk) primitives, but the keyboard stays in the
 * composer's textarea — the caret never leaves it — so the selection is driven
 * from `useSlashCommands` (↑ ↓ Enter Tab Esc) and mirrored here through cmdk's
 * controlled `value`; the mouse selects through `onSelect`. A command the agent
 * cannot run stays listed, dimmed, with its reason. Its height adjusts to the
 * room between the composer and the chat header, so it never reaches the
 * header — whether the composer sits mid-screen or at the bottom.
 */
export function SlashCommandMenu({ slash }: { slash: SlashComposer }) {
  const reduceMotion = useReducedMotion();
  const active = slash.items[Math.min(slash.activeIndex, slash.items.length - 1)];
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // At most 18rem; less when the header is closer than that (8px clear of
  // the composer below and of the header above).
  const spaceAbove = useSpaceAbove(panelRef, { gapPx: 8, fallbackPx: 288 });
  const listMaxHeight = Math.min(288, Math.max(0, spaceAbove - 2)); // 2 = the panel's border

  // The keyboard lives in the textarea, so cmdk never scrolls on its own:
  // keep the selected row in view as ↑ ↓ move it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-command="${active?.name ?? ""}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.name]);

  return (
    <motion.div
      ref={panelRef}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-30"
    >
      <Command
        shouldFilter={false}
        value={active?.name ?? ""}
        // The app's menu surface (shared/ui/dropdown-menu): same radius, border,
        // padding and shadow, so the "/" menu reads as one of them.
        className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg"
      >
        <CommandList
          ref={listRef}
          id="slash-command-menu"
          aria-label="Slash commands"
          className="scrollbar-muted p-1"
          style={{ maxHeight: listMaxHeight }}
        >
          <CommandGroup heading="Commands" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
            {slash.items.map((command, index) => (
              <CommandItem
                key={command.name}
                value={command.name}
                data-command={command.name}
                onSelect={() => slash.select(command)}
                onMouseEnter={() => slash.setActiveIndex(index)}
                aria-disabled={!command.available}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors",
                  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                  !command.available && "opacity-55",
                )}
              >
                <span className="mt-0.5 font-mono text-sm font-medium text-foreground">/{command.name}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-muted-foreground">
                    {command.available ? command.description : command.unavailableReason ?? command.description}
                  </span>
                </span>
                {command.argumentHint && command.available ? (
                  <span className="mt-0.5 shrink-0 text-xs text-muted-foreground/80">{command.argumentHint}</span>
                ) : null}
                {command.kind === "action" ? (
                  <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Runs in the app" />
                ) : null}
                {command.readOnly ? (
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Read-only" />
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </motion.div>
  );
}
