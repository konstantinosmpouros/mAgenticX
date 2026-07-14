import { Brain, ChevronRight, NotebookPen } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { PERSONALITY_PRESETS, type PersonalityId } from "@/shared/lib/consts";
import { normalizeCustomInstructions, normalizePersonality } from "@/shared/lib/utils";
import type { UserPreferences } from "@/shared/lib/types";
import { InfoCard, PrefToggleRow, SoftPanel } from "./shared";

/**
 * PersonalizationTab — how agents adapt to the user, mirroring ChatGPT's
 * "Personalization" section: the memory switches plus a jump into the Memory
 * inspector, and the style controls — custom instructions (opened in its own
 * dialog, owned by ProfilePanel) and the base personality preset. Theme moved
 * to General and the voice picker to Voice when the panel adopted the ChatGPT
 * taxonomy.
 */
type PersonalizationTabProps = {
    userPreferences: UserPreferences;
    preferencesSaving?: boolean;
    onToggleSearchPastConvs?: () => void;
    onToggleUseMemory?: () => void;
    /** Deep-link into the Memory section (the per-agent inspector). */
    onOpenMemories?: () => void;
    /** Open the custom-instructions editor dialog (rendered by ProfilePanel). */
    onOpenCustomInstructions?: () => void;
    onSelectPersonality?: (personality: PersonalityId) => void;
};

export default function PersonalizationTab({
    userPreferences,
    preferencesSaving = false,
    onToggleSearchPastConvs,
    onToggleUseMemory,
    onOpenMemories,
    onOpenCustomInstructions,
    onSelectPersonality,
}: PersonalizationTabProps) {
    const searchPastConvs = userPreferences?.searchPastConvs === true;
    const useMemory = userPreferences?.useMemory !== false;
    const personality = normalizePersonality(userPreferences?.personality);
    const selectedPreset =
        PERSONALITY_PRESETS.find((preset) => preset.id === personality) ?? PERSONALITY_PRESETS[0];
    const customInstructions = normalizeCustomInstructions(userPreferences?.customInstructions);
    const customInstructionsOn = customInstructions.enabled;

    return (
        <div className="space-y-8">
            <InfoCard
                eyebrow="Style"
                title="Instructions & personality"
                description="Shape how agents write to you — your standing instructions plus a base personality."
            >
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    <button
                        type="button"
                        onClick={onOpenCustomInstructions}
                        className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40"
                    >
                        <div className="flex min-w-0 items-start gap-3">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                <NotebookPen size={16} aria-hidden />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">Custom instructions</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Tell agents about yourself and how you want them to respond, applied to every conversation.
                                </p>
                            </div>
                        </div>
                        <span className="flex shrink-0 items-center gap-2">
                            <span
                                className={
                                    customInstructionsOn
                                        ? "rounded-full bg-primary/15 px-2.5 py-0.5 text-[0.68rem] font-semibold text-primary"
                                        : "rounded-full bg-background/60 px-2.5 py-0.5 text-[0.68rem] font-semibold text-muted-foreground"
                                }
                            >
                                {customInstructionsOn ? "On" : "Off"}
                            </span>
                            <ChevronRight
                                size={16}
                                aria-hidden
                                className="text-muted-foreground transition-transform group-hover:translate-x-0.5"
                            />
                        </span>
                    </button>
                    <div className="px-5 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">Personality</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    The base voice agents respond with — Default keeps each agent's own.
                                </p>
                            </div>
                            <Select
                                value={personality}
                                onValueChange={(value) => onSelectPersonality?.(normalizePersonality(value))}
                                disabled={preferencesSaving}
                            >
                                <SelectTrigger
                                    aria-label="Personality"
                                    className="h-11 w-full rounded-xl border-border/60 bg-background/60 px-3 text-sm font-semibold hover:bg-background/80 focus:ring-primary/60 sm:w-44"
                                >
                                    <SelectValue>{selectedPreset.label}</SelectValue>
                                </SelectTrigger>
                                <SelectContent className="z-[90]">
                                    {PERSONALITY_PRESETS.map((preset) => (
                                        <SelectItem key={preset.id} value={preset.id}>
                                            <span className="flex min-w-0 flex-col">
                                                <span className="font-semibold">{preset.label}</span>
                                                <span className="text-xs text-muted-foreground">{preset.description}</span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </SoftPanel>
            </InfoCard>

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
        </div>
    );
}
