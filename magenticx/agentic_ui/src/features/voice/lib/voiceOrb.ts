import type { OrbState } from "@/shared/ui/orb";
import type { VoiceModeStatus } from "@/shared/lib/types";

/**
 * The voice orb's state, from the realtime session's own status and mute flag
 * (useRealtimeVoiceSession). Connecting reads as thinking, so the orb is busy
 * while the session comes up; muted or dropped, it sleeps.
 */
export function orbStateForVoice(status: VoiceModeStatus, muted: boolean): OrbState {
  if (muted || status === "muted" || status === "error") return "asleep";
  if (status === "listening") return "listening";
  if (status === "thinking" || status === "connecting") return "thinking";
  if (status === "speaking") return "speaking";
  return "idle";
}
