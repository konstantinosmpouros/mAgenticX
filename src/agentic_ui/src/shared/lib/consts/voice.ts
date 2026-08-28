/**
 * Voice catalogs — the realtime voices and the languages voice mode can be
 * driven in.
 *
 * There is deliberately no separate read-aloud catalog. Read-aloud once had its
 * own voice list and `readAloudVoice` preference; both were collapsed into the
 * single `voiceModeVoice` preference, and the bridge now resolves the TTS voice
 * server-side through the realtime allow-list. One catalog drives live voice
 * mode and read-aloud alike (see VoiceTab, whose per-voice preview button calls
 * the read-aloud endpoint).
 *
 * Deliberately a LEAF (no imports): `types/preferences.ts` and `types/voice.ts`
 * import `RealtimeVoice` / `VoiceModeLanguage` from here directly rather than
 * through the consts barrel, which would otherwise close a module cycle.
 */

export const REALTIME_VOICES = [
  { id: "alloy", label: "Alloy", description: "Balanced", gender: "male", genderSymbol: "♂" },
  { id: "ash", label: "Ash", description: "Clear", gender: "male", genderSymbol: "♂" },
  { id: "ballad", label: "Ballad", description: "Warm", gender: "male", genderSymbol: "♂" },
  { id: "cedar", label: "Cedar", description: "Rich", gender: "male", genderSymbol: "♂" },
  { id: "coral", label: "Coral", description: "Bright", gender: "female", genderSymbol: "♀" },
  { id: "echo", label: "Echo", description: "Deep", gender: "male", genderSymbol: "♂" },
  { id: "marin", label: "Marin", description: "Natural", gender: "female", genderSymbol: "♀" },
  { id: "sage", label: "Sage", description: "Calm", gender: "female", genderSymbol: "♀" },
  { id: "shimmer", label: "Shimmer", description: "Light", gender: "female", genderSymbol: "♀" },
  { id: "verse", label: "Verse", description: "Expressive", gender: "female", genderSymbol: "♀" },
] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number]["id"];

export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "alloy";

/**
 * The language voice mode OPENS in — not a lock.
 *
 * The bridge builds one instruction template with this value interpolated and
 * then tells the model to mirror whatever language the user actually speaks, so
 * a mismatch corrects itself on the first utterance. The preference only
 * decides the first turn, which is why the list can be this wide: there is no
 * per-language prompt to author, and the Realtime session pins no transcription
 * locale either.
 *
 * Must stay in sync with `supported_voice_mode_languages` in the bridge
 * (dialogue_bridge/core/settings.py) — an id the bridge rejects silently falls
 * back to its default, so the picker would show a language that never applies.
 */
export const VOICE_MODE_LANGUAGES = [
  { id: "english", label: "English", native: "English" },
  { id: "greek", label: "Greek", native: "Ελληνικά" },
  { id: "spanish", label: "Spanish", native: "Español" },
  { id: "french", label: "French", native: "Français" },
  { id: "german", label: "German", native: "Deutsch" },
  { id: "italian", label: "Italian", native: "Italiano" },
  { id: "portuguese", label: "Portuguese", native: "Português" },
  { id: "dutch", label: "Dutch", native: "Nederlands" },
  { id: "polish", label: "Polish", native: "Polski" },
  { id: "romanian", label: "Romanian", native: "Română" },
  { id: "turkish", label: "Turkish", native: "Türkçe" },
  { id: "arabic", label: "Arabic", native: "العربية" },
  { id: "hindi", label: "Hindi", native: "हिन्दी" },
  { id: "russian", label: "Russian", native: "Русский" },
  { id: "ukrainian", label: "Ukrainian", native: "Українська" },
  { id: "chinese", label: "Chinese", native: "中文" },
  { id: "japanese", label: "Japanese", native: "日本語" },
  { id: "korean", label: "Korean", native: "한국어" },
] as const;

export type VoiceModeLanguage = (typeof VOICE_MODE_LANGUAGES)[number]["id"];

export const DEFAULT_VOICE_MODE_LANGUAGE: VoiceModeLanguage = "english";
