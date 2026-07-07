import { Radio } from "lucide-react";
import { Persona, type PersonaState } from "@/shared/ui/ai-elements/persona";
import type { Agent, VoiceModeStatus } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

type VoiceModeBodyProps = {
  status: VoiceModeStatus;
  muted: boolean;
  currentAgent?: Agent | null;
  errorMessage?: string | null;
};

const personaStateForStatus = (status: VoiceModeStatus, muted: boolean): PersonaState => {
  if (muted) return "asleep";
  if (status === "listening") return "listening";
  if (status === "thinking") return "thinking";
  if (status === "speaking") return "speaking";
  if (status === "error") return "asleep";
  return "idle";
};

const labelForStatus = (status: VoiceModeStatus, muted: boolean) => {
  if (muted) return "Microphone muted";
  if (status === "connecting") return "Connecting voice session";
  if (status === "listening") return "Listening";
  if (status === "thinking") return "Thinking";
  if (status === "speaking") return "Speaking";
  if (status === "error") return "Voice session interrupted";
  return "Voice mode";
};

function ObsidianSphere({ status, muted }: { status: VoiceModeStatus; muted: boolean }) {
  const active = !muted && status !== "error";
  const speaking = status === "speaking";
  const listening = status === "listening";
  const thinking = status === "thinking" || status === "connecting";
  const asleep = muted || status === "error";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "voice-persona-orb pointer-events-none absolute left-1/2 top-1/2 z-10 h-[76%] w-[76%] -translate-x-1/2 -translate-y-1/2 rounded-full",
        "border border-white/15 shadow-[0_24px_64px_rgba(0,0,0,0.72),inset_0_1px_2px_rgba(255,255,255,0.75),inset_4px_4px_12px_rgba(255,255,255,0.24),inset_-16px_-14px_26px_rgba(0,0,0,0.92),inset_0_0_0_2px_rgba(255,255,255,0.04)]",
        "transition-[opacity,transform,filter] duration-500",
        active ? "opacity-100" : "opacity-45 grayscale",
        asleep && "voice-persona-orb-asleep",
        !asleep && !listening && !thinking && !speaking && "voice-persona-orb-idle",
        listening && "voice-persona-orb-listening",
        thinking && "voice-persona-orb-thinking",
        speaking && "voice-persona-orb-speaking",
        speaking && "scale-110 shadow-[0_0_0_10px_rgba(168,85,247,0.08),0_0_70px_rgba(168,85,247,0.24),0_24px_64px_rgba(0,0,0,0.72),inset_0_1px_2px_rgba(255,255,255,0.75),inset_4px_4px_12px_rgba(255,255,255,0.24),inset_-16px_-14px_26px_rgba(0,0,0,0.92),inset_0_0_0_2px_rgba(255,255,255,0.04)]",
        listening && "scale-105",
      )}
    >
      <div className="voice-orb-material absolute inset-0 rounded-full">
        <div className="voice-orb-light-field absolute inset-[8%] rounded-full" />
        <div className="voice-orb-dark-field absolute inset-[6%] rounded-full" />
        <div className="voice-orb-inner-rim absolute inset-[2%] rounded-full" />
        <div className="voice-orb-outer-rim absolute -inset-[3%] rounded-full" />
        <div className="voice-orb-outer-rim voice-orb-outer-rim-slow absolute -inset-[7%] rounded-full" />
        <div className="voice-orb-highlight absolute inset-[9%] rounded-full" />
        <div className="absolute inset-x-[22%] bottom-[5%] h-[12%] rounded-full bg-black/55 blur-[5px]" />
      </div>
      {speaking ? (
        <div className="absolute -inset-[20%] -z-20 rounded-full border border-primary/25 opacity-70 animate-ping" />
      ) : null}
    </div>
  );
}

export default function VoiceModeBody({
  status,
  muted,
  currentAgent,
  errorMessage,
}: VoiceModeBodyProps) {
  const personaState = personaStateForStatus(status, muted);
  const statusLabel = labelForStatus(status, muted);

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center overflow-hidden px-6 py-8">
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <div className="relative flex h-[clamp(11.5rem,34vw,14rem)] w-[clamp(11.5rem,34vw,14rem)] items-center justify-center">
          <ObsidianSphere status={status} muted={muted} />
          <Persona
            state={personaState}
            variant="obsidian"
            theme="dark"
            className="relative z-0 h-full w-full opacity-0"
          />
        </div>

        <div className="mt-4 space-y-1.5">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Radio size={13} className={status === "speaking" ? "text-primary" : undefined} />
            {statusLabel}
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {currentAgent?.name || "Voice conversation"}
          </h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            {status === "error"
              ? errorMessage || "Realtime voice is unavailable right now."
              : currentAgent?.description || "Speak naturally. The assistant will listen, think, and answer aloud."}
          </p>
        </div>
      </div>
    </div>
  );
}
