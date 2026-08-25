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

export const VOICE_MODE_LANGUAGES = [
  { id: "english", label: "English", native: "English" },
  { id: "greek", label: "Greek", native: "Ελληνικά" },
] as const;

export type VoiceModeLanguage = (typeof VOICE_MODE_LANGUAGES)[number]["id"];

export const DEFAULT_VOICE_MODE_LANGUAGE: VoiceModeLanguage = "english";
