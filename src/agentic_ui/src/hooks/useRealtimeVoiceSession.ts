import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeVoice, VoiceModeLanguage } from "@/shared/lib/consts";
import type { VoiceModeStatus } from "@/shared/lib/types";
import {
  createRealtimeVoiceSession,
} from "@/shared/lib/api";

type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

type StartVoiceSessionArgs = {
  userId: string;
  selectedAgent: string;
  voice?: RealtimeVoice;
  language?: VoiceModeLanguage;
};

type UseRealtimeVoiceSessionArgs = {
  toast: ToastFn;
};

type RealtimeEvent = Record<string, unknown>;

const asRecord = (value: unknown): RealtimeEvent =>
  value && typeof value === "object" ? value as RealtimeEvent : {};

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

export function useRealtimeVoiceSession({
  toast,
}: UseRealtimeVoiceSessionArgs) {
  const [status, setStatus] = useState<VoiceModeStatus>("closed");
  const [muted, setMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const userIdRef = useRef<string | null>(null);
  // Bumped on every start() and close(); in-flight start() awaits compare against
  // their captured value and bail out if the user already closed the session.
  const generationRef = useRef(0);

  const cleanup = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {
      // ignore
    }
    try {
      pcRef.current?.close();
    } catch {
      // ignore
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current.remove();
    }
    dcRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    remoteAudioRef.current = null;
  }, []);

  const handleRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      const type = readString(event.type);
      if (type === "input_audio_buffer.speech_started") setStatus("listening");
      if (type === "input_audio_buffer.speech_stopped") setStatus("thinking");
      if (type === "response.created") setStatus("thinking");
      if (type === "response.audio.delta" || type === "response.output_audio.delta") setStatus("speaking");
      if (type === "response.done" || type === "response.audio.done") setStatus(muted ? "muted" : "listening");
      if (type === "error") {
        const error = asRecord(event.error);
        setErrorMessage(readString(error.message) || "Realtime voice session failed.");
        setStatus("error");
      }
    },
    [muted],
  );

  const start = useCallback(
    async ({ userId, selectedAgent, voice, language }: StartVoiceSessionArgs) => {
      if (!userId || !selectedAgent || status !== "closed") return;
      const myGeneration = ++generationRef.current;
      const isStale = () => generationRef.current !== myGeneration;

      setStatus("connecting");
      setErrorMessage(null);
      setMuted(false);
      userIdRef.current = userId;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStreamRef.current = stream;

        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.setAttribute("playsinline", "");
        audio.style.display = "none";
        document.body.appendChild(audio);
        remoteAudioRef.current = audio;
        pc.ontrack = (event) => {
          if (isStale()) return;
          audio.srcObject = event.streams[0];
        };

        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        dc.addEventListener("open", () => {
          if (isStale()) return;
          setStatus("listening");
        });
        dc.addEventListener("message", (message) => {
          if (isStale()) return;
          try {
            handleRealtimeEvent(JSON.parse(String(message.data)));
          } catch {
            // ignore non-JSON frames
          }
        });

        const offer = await pc.createOffer();
        if (isStale()) return;
        await pc.setLocalDescription(offer);
        if (isStale()) return;
        if (!offer.sdp) throw new Error("Browser did not create a WebRTC offer.");

        const session = await createRealtimeVoiceSession(userId, {
          agentId: selectedAgent,
          sdp: offer.sdp,
          voice,
          language,
        });
        if (isStale()) return;
        await pc.setRemoteDescription({ type: "answer", sdp: session.sdp });
      } catch (error) {
        if (isStale()) return;
        cleanup();
        const message = error instanceof Error ? error.message : "Unable to start realtime voice.";
        setErrorMessage(message);
        setStatus("error");
        toast({ title: "Voice mode failed", description: message, variant: "destructive" });
      }
    },
    [cleanup, handleRealtimeEvent, status, toast],
  );

  const close = useCallback(async () => {
    generationRef.current += 1;
    cleanup();
    setStatus("closed");
    setMuted(false);
    setErrorMessage(null);
    userIdRef.current = null;
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
    setStatus(nextMuted ? "muted" : "listening");
  }, [muted]);

  const interrupt = useCallback(() => {
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify({ type: "response.cancel" }));
      setStatus(muted ? "muted" : "listening");
    }
  }, [muted]);

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || dcRef.current?.readyState !== "open") return;
      dcRef.current.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: trimmed }],
        },
      }));
      dcRef.current.send(JSON.stringify({ type: "response.create" }));
      setStatus("thinking");
    },
    [],
  );

  useEffect(() => () => cleanup(), [cleanup]);

  return {
    status,
    muted,
    errorMessage,
    isActive: status !== "closed",
    start,
    close,
    toggleMute,
    interrupt,
    sendText,
  };
}
