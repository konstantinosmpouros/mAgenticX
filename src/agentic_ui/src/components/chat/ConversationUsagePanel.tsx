import { useEffect, useState } from "react";
import { TbGauge } from "react-icons/tb";

import type { ConversationUsage } from "@/lib/types";
import { formatCompactTokens } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";

// Dispatched by the global Escape/dismiss cascade (handlers/ui.ts) to close
// transient popovers; the global capture-phase shortcut handler swallows the
// raw Escape, so we close off this event rather than Radix's native handling.
const CLOSE_AI_ACTION_MENUS_EVENT = "magenticx:close-ai-action-menus";

type ConversationUsagePanelProps = {
  usage: ConversationUsage;
  showMessageTokenUsage: boolean;
  onToggleMessageTokenUsage: () => void;
  disabled?: boolean;
};

const StatRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-4 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium tabular-nums text-foreground">{value}</span>
  </div>
);

// Popover off the input-bar gauge button: per-conversation token totals/averages
// plus the checkbox that mirrors the `showMessageTokenUsage` preference (also
// editable from the profile Personalization tab — same shared handler).
export function ConversationUsagePanel({
  usage,
  showMessageTokenUsage,
  onToggleMessageTokenUsage,
  disabled = false,
}: ConversationUsagePanelProps) {
  const [open, setOpen] = useState(false);

  // Close on Escape (via the global dismiss event) and keep a direct keydown
  // fallback, only while open — mirrors the AIActionBar menu pattern.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleCloseMenus = () => setOpen(false);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(CLOSE_AI_ACTION_MENUS_EVENT, handleCloseMenus);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(CLOSE_AI_ACTION_MENUS_EVENT, handleCloseMenus);
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Conversation token usage"
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-smooth hover:bg-[hsl(var(--hover-surface))] active:scale-110 active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <TbGauge size={20} className="text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          <p>Usage</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-72">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Conversation usage</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tokens consumed by the assistant in this conversation.
            </p>
          </div>
          <div className="space-y-1.5">
            <StatRow label="Total tokens" value={formatCompactTokens(usage.totalTokens)} />
            <StatRow label="Input" value={formatCompactTokens(usage.totalInput)} />
            <StatRow label="Output" value={formatCompactTokens(usage.totalOutput)} />
            <StatRow label="AI messages" value={String(usage.aiMessageCount)} />
            <StatRow label="Avg input / msg" value={formatCompactTokens(usage.avgInput)} />
            <StatRow label="Avg output / msg" value={formatCompactTokens(usage.avgOutput)} />
          </div>
          <label className="flex cursor-pointer select-none items-center gap-2.5 border-t border-border pt-3">
            <Checkbox
              checked={showMessageTokenUsage}
              onCheckedChange={() => onToggleMessageTokenUsage()}
              disabled={disabled}
              aria-label="Show per-message token usage"
            />
            <span className="text-sm text-foreground">Show usage on each message</span>
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
