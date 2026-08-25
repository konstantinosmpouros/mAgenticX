import { useMemo } from "react";
import { updateUserPreferences } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type { CustomInstructions, UserPreferences } from "@/shared/lib/types";
import {
  DEFAULT_PERSONALITY,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_VOICE_MODE_LANGUAGE,
  type PersonalityId,
  type RealtimeVoice,
  type VoiceModeLanguage,
} from "@/shared/lib/consts";
import {
  normalizeCustomInstructions,
  normalizePersonality,
  normalizeRealtimeVoice,
  normalizeVoiceModeLanguage,
} from "@/shared/lib/utils";

// Preferences handlers derive the tool toggle model shown in settings and persist changes optimistically.
type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

export type PreferencesHandlers = {
  resolvedPreferences: UserPreferences;
  handleToggleSuggestionsEnabled: () => Promise<void>;
  handleToggleShowMessageTokenUsage: () => Promise<void>;
  handleToggleSearchPastConvs: () => Promise<void>;
  handleToggleUseMemory: () => Promise<void>;
  handleSelectPersonality: (personality: PersonalityId) => Promise<void>;
  handleSaveCustomInstructions: (customInstructions: CustomInstructions) => Promise<boolean>;
  handleSelectVoiceModeVoice: (voice: RealtimeVoice) => Promise<void>;
  handleSelectVoiceModeLanguage: (language: VoiceModeLanguage) => Promise<void>;
};

type PreferencesCtx = {
  userId: string | null;
  userPreferences: UserPreferences | null;
  setUserPreferences: (v: UserPreferences | null) => void;
  isSavingPreferences: boolean;
  setIsSavingPreferences: (v: boolean) => void;
  toast: ToastFn;
  persistUIState: () => void;
};

export function usePreferencesHandlers(ctx: PreferencesCtx): PreferencesHandlers {
  const {
    userId,
    userPreferences,
    setUserPreferences,
    setIsSavingPreferences,
    toast,
    persistUIState,
  } = ctx;

  const defaultPreferences: UserPreferences = useMemo(
    // Keep downstream code simple by always resolving a complete preference object.
    () => ({
      prefersAgenticChat: false,
      suggestionsEnabled: true,
      showMessageTokenUsage: false,
      searchPastConvs: false,
      useMemory: true,
      personality: DEFAULT_PERSONALITY,
      customInstructions: normalizeCustomInstructions(undefined),
      voiceModeVoice: DEFAULT_REALTIME_VOICE,
      voiceModeLanguage: DEFAULT_VOICE_MODE_LANGUAGE,
    }),
    [],
  );
  const resolvedPreferences = {
    ...defaultPreferences,
    ...(userPreferences ?? {}),
    personality: normalizePersonality(userPreferences?.personality),
    customInstructions: normalizeCustomInstructions(userPreferences?.customInstructions),
    voiceModeVoice: normalizeRealtimeVoice(userPreferences?.voiceModeVoice),
    voiceModeLanguage: normalizeVoiceModeLanguage(userPreferences?.voiceModeLanguage),
  };

  // The PUT endpoint is a FULL replacement: every save must carry every field.
  // All handlers build their payload through this snapshot + overrides, so a
  // newly added preference can never be silently wiped by an unrelated toggle.
  const snapshotPrefs = (overrides: Partial<UserPreferences>): UserPreferences => ({
    prefersAgenticChat: resolvedPreferences.prefersAgenticChat,
    suggestionsEnabled: resolvedPreferences.suggestionsEnabled !== false,
    showMessageTokenUsage: resolvedPreferences.showMessageTokenUsage === true,
    searchPastConvs: resolvedPreferences.searchPastConvs === true,
    useMemory: resolvedPreferences.useMemory !== false,
    personality: resolvedPreferences.personality,
    customInstructions: resolvedPreferences.customInstructions,
    voiceModeVoice: resolvedPreferences.voiceModeVoice,
    voiceModeLanguage: resolvedPreferences.voiceModeLanguage,
    ...overrides,
  });

  // Shared optimistic-persist flow: apply instantly, PUT, adopt the canonical
  // response; roll back + toast on failure. Returns success for callers that
  // gate UI on it (the custom-instructions dialog closes only on success).
  const persistPrefs = async (nextPrefs: UserPreferences, errorTitle: string): Promise<boolean> => {
    if (!userId) {
      toast({
        title: "Authentication required",
        description: "Please sign in again.",
        variant: "destructive",
      });
      return false;
    }
    const prevPrefs = resolvedPreferences;
    setUserPreferences(nextPrefs);
    setIsSavingPreferences(true);
    try {
      const saved = await updateUserPreferences(userId, nextPrefs);
      // Replace the optimistic snapshot with the canonical payload returned by the backend.
      setUserPreferences(saved);
      persistUIState();
      return true;
    } catch (error) {
      setUserPreferences(prevPrefs);
      toastError(toast, errorTitle, error, {
        description: error instanceof Error ? error.message : "Please try again.",
      });
      return false;
    } finally {
      setIsSavingPreferences(false);
    }
  };

  const handleToggleSuggestionsEnabled = async () => {
    await persistPrefs(
      snapshotPrefs({ suggestionsEnabled: !(resolvedPreferences.suggestionsEnabled !== false) }),
      "Could not update preferences",
    );
  };

  const handleToggleShowMessageTokenUsage = async () => {
    await persistPrefs(
      snapshotPrefs({
        showMessageTokenUsage: !(resolvedPreferences.showMessageTokenUsage === true),
      }),
      "Could not update preferences",
    );
  };

  const handleToggleSearchPastConvs = async () => {
    await persistPrefs(
      snapshotPrefs({ searchPastConvs: !(resolvedPreferences.searchPastConvs === true) }),
      "Could not update preferences",
    );
  };

  const handleToggleUseMemory = async () => {
    await persistPrefs(
      snapshotPrefs({ useMemory: !(resolvedPreferences.useMemory !== false) }),
      "Could not update preferences",
    );
  };

  const handleSelectPersonality = async (personality: PersonalityId) => {
    const nextPersonality = normalizePersonality(personality);
    if (nextPersonality === resolvedPreferences.personality) return;
    await persistPrefs(
      snapshotPrefs({ personality: nextPersonality }),
      "Could not update personality",
    );
  };

  const handleSaveCustomInstructions = async (
    customInstructions: CustomInstructions,
  ): Promise<boolean> => {
    return persistPrefs(
      snapshotPrefs({ customInstructions: normalizeCustomInstructions(customInstructions) }),
      "Could not save custom instructions",
    );
  };

  const handleSelectVoiceModeVoice = async (voice: RealtimeVoice) => {
    const nextVoice = normalizeRealtimeVoice(voice);
    if (nextVoice === normalizeRealtimeVoice(resolvedPreferences.voiceModeVoice)) return;
    await persistPrefs(
      snapshotPrefs({ voiceModeVoice: nextVoice }),
      "Could not update voice mode voice",
    );
  };

  const handleSelectVoiceModeLanguage = async (language: VoiceModeLanguage) => {
    const nextLanguage = normalizeVoiceModeLanguage(language);
    if (nextLanguage === normalizeVoiceModeLanguage(resolvedPreferences.voiceModeLanguage)) return;
    await persistPrefs(
      snapshotPrefs({ voiceModeLanguage: nextLanguage }),
      "Could not update voice mode language",
    );
  };

  return {
    resolvedPreferences,
    handleToggleSuggestionsEnabled,
    handleToggleShowMessageTokenUsage,
    handleToggleSearchPastConvs,
    handleToggleUseMemory,
    handleSelectPersonality,
    handleSaveCustomInstructions,
    handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage,
  };
}
