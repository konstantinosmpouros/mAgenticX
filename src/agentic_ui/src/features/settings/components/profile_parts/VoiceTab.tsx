import { useCallback, useEffect, useRef, useState } from "react";
import { Languages, Sparkles } from "lucide-react";

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
import { cn, normalizeRealtimeVoice, normalizeVoiceModeLanguage } from "@/shared/lib/utils";
import { REALTIME_VOICES, VOICE_MODE_LANGUAGES, type RealtimeVoice, type VoiceModeLanguage } from "@/shared/lib/consts";
import { generateReadAloudPreviewAudio } from "@/shared/lib/api";
import type { UserPreferences, UserProfile } from "@/shared/lib/types";
import { InfoCard, SoftPanel } from "./shared";
import { VoiceGenderIcon } from "./icons";

/**
 * VoiceTab — the dedicated "Voice" settings section (mirroring ChatGPT's).
 * Owns the realtime-voice picker with audio preview and the voice-mode
 * language default; both persist as user preferences.
 */
type VoiceTabProps = {
    user: UserProfile | null;
    userPreferences: UserPreferences;
    preferencesSaving?: boolean;
    onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
    onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
};

export default function VoiceTab({
    user,
    userPreferences,
    preferencesSaving = false,
    onSelectVoiceModeVoice,
    onSelectVoiceModeLanguage,
}: VoiceTabProps) {
    const [voiceSelectorOpen, setVoiceSelectorOpen] = useState(false);
    const [languageSelectorOpen, setLanguageSelectorOpen] = useState(false);
    const [previewLoadingVoice, setPreviewLoadingVoice] = useState<RealtimeVoice | null>(null);
    const [previewPlayingVoice, setPreviewPlayingVoice] = useState<RealtimeVoice | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const previewAudioUrlRef = useRef<string | null>(null);

    const voiceModeVoice = normalizeRealtimeVoice(userPreferences?.voiceModeVoice);
    const selectedVoiceModeVoice =
        REALTIME_VOICES.find((voice) => voice.id === voiceModeVoice) ?? REALTIME_VOICES[0];
    const voiceModeLanguage = normalizeVoiceModeLanguage(userPreferences?.voiceModeLanguage);
    const selectedLanguage =
        VOICE_MODE_LANGUAGES.find((language) => language.id === voiceModeLanguage) ?? VOICE_MODE_LANGUAGES[0];

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
            if (import.meta.env.DEV) {
                console.error("Failed to preview read-aloud voice:", error);
            }
            clearVoicePreview();
        } finally {
            setPreviewLoadingVoice(null);
        }
    };

    return (
        <div className="space-y-6">
            <InfoCard
                eyebrow="Voice mode"
                title="Voice"
                description="The voice used for live voice mode and read aloud, and the default spoken language."
            >
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    <div className="px-5 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">Voice</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Preview each voice before choosing the one agents speak with.
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
                                <p className="text-sm font-semibold text-foreground">Spoken language</p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    Default response language for live voice conversations.
                                </p>
                            </div>
                            {/* Language picker mirrors the voice picker above: a trigger
                                showing the current selection + a searchable command dialog,
                                rather than a plain dropdown. */}
                            <VoiceSelector
                                value={voiceModeLanguage}
                                open={languageSelectorOpen}
                                onOpenChange={setLanguageSelectorOpen}
                            >
                                <VoiceSelectorTrigger asChild>
                                    <button
                                        type="button"
                                        disabled={preferencesSaving}
                                        className={cn(
                                            "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 text-left text-sm transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60 sm:w-56",
                                            languageSelectorOpen && "bg-background/80"
                                        )}
                                    >
                                        <span className="min-w-0">
                                            <span className="block truncate font-semibold text-foreground">
                                                {selectedLanguage.label}
                                            </span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {selectedLanguage.native}
                                            </span>
                                        </span>
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                            <Languages size={13} />
                                        </span>
                                    </button>
                                </VoiceSelectorTrigger>
                                <VoiceSelectorContent
                                    title="Spoken language"
                                    className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                                >
                                    <VoiceSelectorInput placeholder="Search languages..." />
                                    <VoiceSelectorList className="max-h-[22rem]">
                                        <VoiceSelectorEmpty>No language found.</VoiceSelectorEmpty>
                                        <VoiceSelectorGroup heading="Languages">
                                            {VOICE_MODE_LANGUAGES.map((language) => {
                                                const isSelected = language.id === voiceModeLanguage;

                                                return (
                                                    <VoiceSelectorItem
                                                        key={language.id}
                                                        value={`${language.label} ${language.native}`}
                                                        onSelect={() => {
                                                            setLanguageSelectorOpen(false);
                                                            onSelectVoiceModeLanguage?.(normalizeVoiceModeLanguage(language.id));
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
                                                            <Languages className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="flex min-w-0 items-center gap-2">
                                                                <VoiceSelectorName>{language.label}</VoiceSelectorName>
                                                                <VoiceSelectorAttributes className="ml-auto shrink-0 gap-2">
                                                                    <VoiceSelectorDescription className="whitespace-nowrap">
                                                                        {language.native}
                                                                    </VoiceSelectorDescription>
                                                                </VoiceSelectorAttributes>
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
        </div>
    );
}
