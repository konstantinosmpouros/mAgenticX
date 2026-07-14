import { Keyboard } from "lucide-react";

import { ScrollArea } from "@/shared/ui/scroll-area";
import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import ShortcutsTab from "./profile_parts/ShortcutsTab";

/**
 * ShortcutsPanel — the dedicated Keyboard Shortcuts modal, opened from the
 * sidebar profile menu (Help → Keyboard shortcuts) and the Alt+/ shortcut.
 * Deliberately its own surface, not a settings section: it's a reference
 * page, not a preference.
 */
type ShortcutsPanelProps = {
    open: boolean;
    onClose: () => void;
};

export default function ShortcutsPanel({ open, onClose }: ShortcutsPanelProps) {
    return (
        <PremiumModalShell open={open} onClose={onClose} closeLabel="Close keyboard shortcuts" className="max-w-3xl">
            <div className="flex h-[min(40rem,85vh)] flex-col">
                <div className="flex items-start gap-4 border-b border-white/10 px-6 py-5 pr-16 md:px-7">
                    <div className="mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.12] bg-white/[0.06] text-white/80 sm:flex">
                        <Keyboard className="h-5 w-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-2xl font-semibold leading-tight tracking-tight text-white md:text-[2rem]">
                            Keyboard Shortcuts
                        </h3>
                        <p className="mt-1 text-sm text-white/55">
                            Browse the same shortcut registry the UI runtime uses.
                        </p>
                    </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                    <div className="px-6 py-6 md:px-7">
                        <ShortcutsTab />
                    </div>
                </ScrollArea>
            </div>
        </PremiumModalShell>
    );
}
