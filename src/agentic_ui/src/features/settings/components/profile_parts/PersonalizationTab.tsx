import { useState } from "react";
import { Brain, ChevronRight, NotebookPen, Sparkles } from "lucide-react";

import {
    VoiceSelector,
    VoiceSelectorContent,
    VoiceSelectorEmpty,
    VoiceSelectorGroup,
    VoiceSelectorInput,
    VoiceSelectorItem,
    VoiceSelectorList,
    VoiceSelectorTrigger,
} from "@/shared/ui/ai-elements/voice-selector";
import { PERSONALITY_PRESETS, type PersonalityId } from "@/shared/lib/consts";
import { cn, normalizeCustomInstructions, normalizePersonality } from "@/shared/lib/utils";
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
    const [personalitySelectorOpen, setPersonalitySelectorOpen] = useState(false);
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
                            {/* Personality picker mirrors the voice + language pickers:
                                a trigger showing the current preset + a searchable command
                                dialog, instead of a plain dropdown. */}
                            <VoiceSelector
                                value={personality}
                                open={personalitySelectorOpen}
                                onOpenChange={setPersonalitySelectorOpen}
                            >
                                <VoiceSelectorTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label="Personality"
                                        disabled={preferencesSaving}
                                        className={cn(
                                            "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 text-left text-sm transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60 sm:w-56",
                                            personalitySelectorOpen && "bg-background/80"
                                        )}
                                    >
                                        <span className="min-w-0">
                                            <span className="block truncate font-semibold text-foreground">
                                                {selectedPreset.label}
                                            </span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {selectedPreset.description}
                                            </span>
                                        </span>
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                            <Sparkles size={13} />
                                        </span>
                                    </button>
                                </VoiceSelectorTrigger>
                                <VoiceSelectorContent
                                    title="Personality"
                                    className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                                >
                                    <VoiceSelectorInput placeholder="Search personalities..." />
                                    <VoiceSelectorList className="max-h-[22rem]">
                                        <VoiceSelectorEmpty>No personality found.</VoiceSelectorEmpty>
                                        <VoiceSelectorGroup heading="Personalities">
                                            {PERSONALITY_PRESETS.map((preset) => {
                                                const isSelected = preset.id === personality;

                                                return (
                                                    <VoiceSelectorItem
                                                        key={preset.id}
                                                        value={`${preset.label} ${preset.description}`}
                                                        onSelect={() => {
                                                            setPersonalitySelectorOpen(false);
                                                            onSelectPersonality?.(normalizePersonality(preset.id));
                                                        }}
                                                        className={cn(
                                                            "items-center gap-3 rounded-xl px-3 py-3",
                                                            isSelected && "bg-primary/10"
                                                        )}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "flex size-7 shrink-0 items-center justify-center rounded-lg border",
                                                                isSelected
                                                                    ? "border-primary/40 bg-primary/15 text-primary"
                                                                    : "border-border/60 bg-muted/40 text-muted-foreground"
                                                            )}
                                                        >
                                                            <Sparkles className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate text-left font-medium text-foreground">
                                                                {preset.label}
                                                            </span>
                                                            <span className="block truncate text-left text-xs text-muted-foreground">
                                                                {preset.description}
                                                            </span>
                                                        </span>
                                                    </VoiceSelectorItem>
                                                );
                                            })}
                                        </VoiceSelectorGroup>
                                    </VoiceSelectorList>
                                </VoiceSelectorContent>
                            </VoiceSelector>
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
