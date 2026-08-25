import { LifeBuoy } from "lucide-react";

import { ScrollArea } from "@/shared/ui/scroll-area";
import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import type { ConversationSummary, ToolMetadata } from "@/shared/lib/types";
import HelpTab from "./profile_parts/HelpTab";

/**
 * HelpPanel — the dedicated Help & Resources modal, opened from the sidebar
 * profile menu (Help → Help center). Its own surface rather than a settings
 * section: documentation and support entry points, not preferences.
 */
type HelpPanelProps = {
  open: boolean;
  onClose: () => void;
  archivedConversations: ConversationSummary[];
  availableTools: (ToolMetadata & { enabled?: boolean })[];
};

export default function HelpPanel({
  open,
  onClose,
  archivedConversations,
  availableTools,
}: HelpPanelProps) {
  return (
    <PremiumModalShell open={open} onClose={onClose} closeLabel="Close help" className="max-w-3xl">
      <div className="flex h-[min(40rem,85vh)] flex-col">
        <div className="flex items-start gap-4 border-b border-white/10 px-6 py-5 pr-16 md:px-7">
          <div className="mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.12] bg-white/[0.06] text-white/80 sm:flex">
            <LifeBuoy className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h3 className="text-2xl font-semibold leading-tight tracking-tight text-white md:text-[2rem]">
              Help & Resources
            </h3>
            <p className="mt-1 text-sm text-white/55">
              Open product documentation and support entry points.
            </p>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 py-6 md:px-7">
            <HelpTab
              archivedConversations={archivedConversations}
              availableTools={availableTools}
            />
          </div>
        </ScrollArea>
      </div>
    </PremiumModalShell>
  );
}
