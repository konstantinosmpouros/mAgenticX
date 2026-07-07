import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { MoonStar, Sparkles } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import {
    VoiceSelector,
    VoiceSelectorAttributes,
    VoiceSelectorContent,
    VoiceSelectorDescription,
    VoiceSelectorEmpty,
    VoiceSelectorGroup,
    VoiceSelectorInput,
    VoiceSelectorItem,
    VoiceSelectorList,
    VoiceSelectorName,
    VoiceSelectorPreview,
    VoiceSelectorTrigger,
} from "@/shared/ui/ai-elements/voice-selector";
import { cn, fmtBoolean, normalizeRealtimeVoice, normalizeVoiceModeLanguage } from "@/shared/lib/utils";
import { REALTIME_VOICES, VOICE_MODE_LANGUAGES, type RealtimeVoice, type VoiceModeLanguage } from "@/shared/lib/consts";
import { generateReadAloudPreviewAudio } from "@/shared/lib/api";
import type { UserPreferences, UserProfile } from "@/shared/lib/types";
import { InfoCard, SoftPanel } from "./shared";
import { VoiceGenderIcon } from "./icons";

const themeOptions = [
    {
        name: "Light",
        value: "light",
        icon: Sparkles,
        previewClassName:
            "bg-[linear-gradient(135deg,hsl(0_0%_100%)_0%,hsl(240_4.8%_95.9%)_52%,hsl(216_50%_92%)_100%)]",
        cardClassName: "border-white/70 bg-white/80",
    },
    {
        name: "Dark",
        value: "dark",
        icon: MoonStar,
        previewClassName:
            "bg-[linear-gradient(135deg,hsl(240_6%_6%)_0%,hsl(240_8%_10%)_55%,hsl(216_100%_8%)_100%)]",
        cardClassName: "border-white/10 bg-black/20",
    },
] as const;

type PersonalizationTabProps = {
    user: UserProfile | null;
    userPreferences: UserPreferences;
    preferencesSaving?: boolean;
    onToggleSuggestionsEnabled?: () => void;
    onToggleMessageTokenUsage?: () => void;
    onToggleSearchPastConvs?: () => void;
    onToggleUseMemory?: () => void;
    onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
    onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
};

export default function PersonalizationTab({
    user,
    userPreferences,
    preferencesSaving = false,
    onToggleSuggestionsEnabled,
    onToggleMessageTokenUsage,
    onToggleSearchPastConvs,
    onToggleUseMemory,
    onSelectVoiceModeVoice,
    onSelectVoiceModeLanguage,
}: PersonalizationTabProps) {
    const { theme, setTheme } = useTheme();
    const currentTheme = theme === "dark" ? "dark" : "light";

    const [voiceSelectorOpen, setVoiceSelectorOpen] = useState(false);
    const [previewLoadingVoice, setPreviewLoadingVoice] = useState<RealtimeVoice | null>(null);
    const [previewPlayingVoice, setPreviewPlayingVoice] = useState<RealtimeVoice | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const previewAudioUrlRef = useRef<string | null>(null);

    const prefersAgentic =
        typeof userPreferences?.prefersAgenticChat === "boolean" ? userPreferences.prefersAgenticChat : undefined;
    const displayPrefersAgentic = fmtBoolean(prefersAgentic);
    const suggestionsEnabled = userPreferences?.suggestionsEnabled !== false;
    const showMessageTokenUsage = userPreferences?.showMessageTokenUsage === true;
    const searchPastConvs = userPreferences?.searchPastConvs === true;
    const useMemory = userPreferences?.useMemory !== false;
    const voiceModeVoice = normalizeRealtimeVoice(userPreferences?.voiceModeVoice);
    const selectedVoiceModeVoice =
        REALTIME_VOICES.find((voice) => voice.id === voiceModeVoice) ?? REALTIME_VOICES[0];
    const voiceModeLanguage = normalizeVoiceModeLanguage(userPreferences?.voiceModeLanguage);

    const clearVoicePreview = useCallback(() => {
        previewAudioRef.current?.pause();
        previewAudioRef.current = null;
        if (previewAudioUrlRef.current) {
            URL.revokeObjectURL(previewAudioUrlRef.current);
            previewAudioUrlRef.current = null;
        }
        setPreviewPlayingVoice(null);
    }, []);

    useEffect(() => () => clearVoicePreview(), [clearVoicePreview]);

    const handlePreviewVoice = async (voice: RealtimeVoice) => {
        if (!user?.id) return;
        if (previewPlayingVoice === voice) {
            clearVoicePreview();
            return;
        }

        clearVoicePreview();
        setPreviewLoadingVoice(voice);

        try {
            const audioBlob = await generateReadAloudPreviewAudio(user.id, voice, "Hey! I am your AI speaker.");
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            previewAudioUrlRef.current = audioUrl;
            previewAudioRef.current = audio;
            audio.onended = clearVoicePreview;
            audio.onerror = clearVoicePreview;
            setPreviewPlayingVoice(voice);
            await audio.play();
        } catch (error) {
            console.error("Failed to preview read-aloud voice:", error);
            clearVoicePreview();
        } finally {
            setPreviewLoadingVoice(null);
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr),minmax(18rem,0.85fr)]">
                <InfoCard
                    eyebrow="Theme"
                    title="Choose a theme"
                    description="Keep the selection explicit and lightweight, similar to a settings-first chat product."
                >
                    <div className="grid gap-4 md:grid-cols-2">
                        {themeOptions.map((themeOption) => {
                            const Icon = themeOption.icon;
                            const isActive = currentTheme === themeOption.value;

                            return (
                                <button
                                    key={themeOption.value}
                                    type="button"
                                    onClick={() => setTheme(themeOption.value)}
                                    className={cn(
                                        "rounded-[1.5rem] p-4 text-left transition-colors",
                                        isActive
                                            ? "bg-primary/10"
                                            : "bg-muted/30 hover:bg-muted/45"
                                    )}
                                >
                                    <div
                                        className={cn(
                                            "h-28 rounded-[1.2rem] p-4",
                                            themeOption.cardClassName
                                        )}
                                    >
                                        <div className={cn("flex h-full flex-col justify-between", themeOption.previewClassName)}>
                                            <div className="flex items-center gap-2">
                                                <div className="h-2.5 w-2.5 rounded-full bg-primary/70" />
                                                <div className="h-2 w-16 rounded-full bg-black/10 dark:bg-white/10" />
                                            </div>
                                            <div className="grid gap-2">
                                                <div className="h-3 rounded-full bg-black/10 dark:bg-white/10" />
                                                <div className="h-3 w-4/5 rounded-full bg-black/10 dark:bg-white/10" />
                                                <div className="h-8 w-28 rounded-2xl bg-primary/70" />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mt-4 flex items-start justify-between gap-4">
                                        <div>
                                            <p className="text-sm font-semibold text-foreground">
                                                {themeOption.name}
                                            </p>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                                {isActive ? "Currently applied" : "Switch workspace theme"}
                                            </p>
                                        </div>
                                        <div
                                            className={cn(
                                                "flex h-10 w-10 items-center justify-center rounded-2xl bg-black/10 text-muted-foreground dark:bg-white/[0.04]",
                                                isActive && "bg-primary/12 text-primary"
                                            )}
                                        >
                                            <Icon size={18} />
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </InfoCard>

                <InfoCard
                    eyebrow="Defaults"
                    title="Conversation defaults"
                    description="Read-only defaults surfaced from stored preferences and active workspace state."
                >
                    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                        <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-sm font-semibold text-foreground">
                                        Agentic chat
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Controls whether the user profile prefers the agentic chat experience.
                                    </p>
                                </div>
                                <span className="inline-flex rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                    {displayPrefersAgentic}
                                </span>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Conversation suggestions
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Show personalized starter prompts below the composer on new chats.
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-3">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={suggestionsEnabled}
                                        aria-disabled={preferencesSaving}
                                        onClick={() => !preferencesSaving && onToggleSuggestionsEnabled?.()}
                                        className={cn(
                                            "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                            suggestionsEnabled
                                                ? "border-primary/40 bg-primary/20"
                                                : "border-transparent bg-background/80",
                                            preferencesSaving && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                suggestionsEnabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Per-message token usage
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Show how many input and output tokens each assistant message used, in its action bar.
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-3">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={showMessageTokenUsage}
                                        aria-disabled={preferencesSaving}
                                        onClick={() => !preferencesSaving && onToggleMessageTokenUsage?.()}
                                        className={cn(
                                            "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                            showMessageTokenUsage
                                                ? "border-primary/40 bg-primary/20"
                                                : "border-transparent bg-background/80",
                                            preferencesSaving && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                showMessageTokenUsage ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Search past conversations
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Let deep agents semantically search your earlier conversations to recall and reference relevant past messages.
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-3">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={searchPastConvs}
                                        aria-disabled={preferencesSaving}
                                        onClick={() => !preferencesSaving && onToggleSearchPastConvs?.()}
                                        className={cn(
                                            "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                            searchPastConvs
                                                ? "border-primary/40 bg-primary/20"
                                                : "border-transparent bg-background/80",
                                            preferencesSaving && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                searchPastConvs ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Agent memory
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Let deep agents keep and use persistent memory about you across conversations. Turn off to run agents without their stored memory.
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-3">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={useMemory}
                                        aria-disabled={preferencesSaving}
                                        onClick={() => !preferencesSaving && onToggleUseMemory?.()}
                                        className={cn(
                                            "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                            useMemory
                                                ? "border-primary/40 bg-primary/20"
                                                : "border-transparent bg-background/80",
                                            preferencesSaving && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                useMemory ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Voice mode
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Voice used for live voice mode and read aloud.
                                    </p>
                                </div>
                                <VoiceSelector
                                    value={voiceModeVoice}
                                    open={voiceSelectorOpen}
                                    onOpenChange={setVoiceSelectorOpen}
                                >
                                    <VoiceSelectorTrigger asChild>
                                        <button
                                            type="button"
                                            disabled={preferencesSaving}
                                            className={cn(
                                                "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 text-left text-sm transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60 sm:w-56",
                                                voiceSelectorOpen && "bg-background/80"
                                            )}
                                        >
                                            <span className="min-w-0">
                                                <span className="block truncate font-semibold text-foreground">
                                                    {selectedVoiceModeVoice.label}
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {selectedVoiceModeVoice.description}
                                                </span>
                                            </span>
                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                                <Sparkles size={13} />
                                            </span>
                                        </button>
                                    </VoiceSelectorTrigger>
                                    <VoiceSelectorContent
                                        title="Voice mode"
                                        className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                                    >
                                        <VoiceSelectorInput placeholder="Search voices..." />
                                        <VoiceSelectorList className="max-h-[22rem]">
                                            <VoiceSelectorEmpty>No voice found.</VoiceSelectorEmpty>
                                            <VoiceSelectorGroup heading="Voices">
                                                {REALTIME_VOICES.map((voice) => {
                                                    const isSelected = voice.id === voiceModeVoice;

                                                    return (
                                                        <VoiceSelectorItem
                                                            key={voice.id}
                                                            value={`${voice.label} ${voice.description}`}
                                                            onSelect={() => {
                                                                setVoiceSelectorOpen(false);
                                                                onSelectVoiceModeVoice?.(normalizeRealtimeVoice(voice.id));
                                                            }}
                                                            className={cn(
                                                                "items-center gap-3 rounded-xl px-3 py-3",
                                                                isSelected && "bg-primary/10"
                                                            )}
                                                        >
                                                            <VoiceSelectorPreview
                                                                loading={previewLoadingVoice === voice.id}
                                                                playing={previewPlayingVoice === voice.id}
                                                                onPlay={() => handlePreviewVoice(voice.id)}
                                                                className={cn(
                                                                    "size-6 shrink-0 rounded-lg border",
                                                                    isSelected
                                                                        ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/20"
                                                                        : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60"
                                                                )}
                                                            />
                                                            <span className="min-w-0 flex-1">
                                                                <span className="flex min-w-0 items-center gap-2">
                                                                    <VoiceSelectorName>{voice.label}</VoiceSelectorName>
                                                                    <VoiceSelectorAttributes className="ml-auto shrink-0 gap-2">
                                                                        <VoiceSelectorDescription className="whitespace-nowrap">
                                                                            {voice.description}
                                                                        </VoiceSelectorDescription>
                                                                    </VoiceSelectorAttributes>
                                                                    <span
                                                                        className={cn(
                                                                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                                                                            isSelected
                                                                                ? "bg-primary/20 text-primary"
                                                                                : "bg-muted/60 text-muted-foreground"
                                                                        )}
                                                                        title={voice.gender === "female" ? "Female voice" : "Male voice"}
                                                                    >
                                                                        <VoiceGenderIcon gender={voice.gender} className="h-3.5 w-3.5" />
                                                                    </span>
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
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-foreground">
                                        Voice mode language
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Default response language for live voice conversations.
                                    </p>
                                </div>
                                <Select
                                    value={voiceModeLanguage}
                                    onValueChange={(value) => onSelectVoiceModeLanguage?.(normalizeVoiceModeLanguage(value))}
                                    disabled={preferencesSaving}
                                >
                                    <SelectTrigger className="h-11 w-full rounded-xl border-border/60 bg-background/60 px-3 text-sm font-semibold hover:bg-background/80 focus:ring-primary/60 sm:w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {VOICE_MODE_LANGUAGES.map((language) => (
                                            <SelectItem key={language.id} value={language.id}>
                                                {language.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </SoftPanel>
                </InfoCard>
            </div>
        </div>
    );
}
