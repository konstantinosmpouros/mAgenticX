import { Brain, ChevronRight } from "lucide-react";

import type { UserPreferences } from "@/shared/lib/types";
import { InfoCard, PrefToggleRow, SoftPanel } from "./shared";
import { ComingSoonRow } from "./ComingSoon";

/**
 * PersonalizationTab — how agents adapt to the user, mirroring ChatGPT's
 * "Personalization" section: the memory switches plus a jump into the Memory
 * inspector. Theme moved to General and the voice picker to Voice when the
 * panel adopted the ChatGPT taxonomy.
 */
type PersonalizationTabProps = {
    userPreferences: UserPreferences;
    preferencesSaving?: boolean;
    onToggleSearchPastConvs?: () => void;
    onToggleUseMemory?: () => void;
    /** Deep-link into the Memory section (the per-agent inspector). */
    onOpenMemories?: () => void;
};

export default function PersonalizationTab({
    userPreferences,
    preferencesSaving = false,
    onToggleSearchPastConvs,
    onToggleUseMemory,
    onOpenMemories,
}: PersonalizationTabProps) {
    const searchPastConvs = userPreferences?.searchPastConvs === true;
    const useMemory = userPreferences?.useMemory !== false;

    return (
        <div className="space-y-8">
            <InfoCard
                eyebrow="Memory"
                title="Memory"
                description="Control what agents remember about you and how they use your history."
            >
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    <PrefToggleRow
                        title="Agent memory"
                        description="Let deep agents keep and use persistent memory about you across conversations. Turn off to run agents without their stored memory."
                        checked={useMemory}
                        disabled={preferencesSaving}
                        onToggle={onToggleUseMemory}
                    />
                    <PrefToggleRow
                        title="Reference chat history"
                        description="Let deep agents semantically search your earlier conversations to recall and reference relevant past messages."
                        checked={searchPastConvs}
                        disabled={preferencesSaving}
                        onToggle={onToggleSearchPastConvs}
                    />
                    <button
                        type="button"
                        onClick={onOpenMemories}
                        className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40"
                    >
                        <div className="flex min-w-0 items-start gap-3">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                <Brain size={16} aria-hidden />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">Manage memories</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Review and delete what each deep agent has remembered about you.
                                </p>
                            </div>
                        </div>
                        <ChevronRight
                            size={16}
                            aria-hidden
                            className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                        />
                    </button>
                </SoftPanel>
            </InfoCard>

            <InfoCard
                eyebrow="Planned"
                title="More personalization"
                description="Mirrored from the target settings layout — these land here once implemented."
            >
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    <ComingSoonRow
                        title="Custom instructions"
                        description="Tell agents about yourself and how you want them to respond, applied to every conversation."
                    />
                    <ComingSoonRow
                        title="Personality"
                        description="Pick a base personality for responses — friendly, pragmatic, or none."
                    />
                </SoftPanel>
            </InfoCard>
        </div>
    );
}
