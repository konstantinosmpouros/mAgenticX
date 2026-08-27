import { useEffect, useRef, useState } from "react";

/** Which surface the conversation body is currently showing. */
export type ConversationBodyMode = "chat" | "voice";

type UseVoiceBodyTransitionOptions = {
  /** The live realtime-session flag — the only thing that drives the staging. */
  voiceActive: boolean;
  /**
   * Empty conversations stage the swap because the chat bar and the voice bar
   * occupy different slots there (centered vs sticky-bottom). Once there are
   * messages both live at sticky-bottom, so they cross-fade in parallel.
   */
  isEmptyConversation: boolean;
};

/**
 * The staged chat ↔ voice transition for the conversation body.
 *
 * Entering and leaving voice mode is not a single boolean flip: on an empty
 * conversation the chat bar has to erase at the centered slot *before* the
 * persona orb enters, and the voice bar only appears once the orb has settled.
 * Reversing runs the same beats backwards. Sequencing them means several pieces
 * of derived state that must not be flipped independently, which is why they all
 * live here rather than beside their consumers.
 *
 * Extracted from ChatPage: as inline state it could only be exercised by
 * rendering the whole workspace, so the enter/exit staging had no test at all.
 */
export function useVoiceBodyTransition({
  voiceActive,
  isEmptyConversation,
}: UseVoiceBodyTransitionOptions) {
  const [bodyShowsVoice, setBodyShowsVoice] = useState(voiceActive);
  const [voiceBarReady, setVoiceBarReady] = useState(voiceActive);
  const [chatBarReady, setChatBarReady] = useState(!voiceActive);
  // Drives positionClass. Lags voiceBarReady going *false* by the voice-bar exit
  // duration (~200 ms) so the voice-bar finishes its exit at sticky-bottom
  // instead of teleporting to the centered slot. Matches voiceBarReady going
  // true immediately so voice-bar mounts at the right place.
  const [positionAtBottom, setPositionAtBottom] = useState(voiceActive);

  useEffect(() => {
    if (voiceBarReady) {
      setPositionAtBottom(true);
      return;
    }
    const t = window.setTimeout(() => setPositionAtBottom(false), 200);
    return () => window.clearTimeout(t);
  }, [voiceBarReady]);

  // Track the previous voice-active value so we only run the staged transition
  // when voice mode is actually being entered or left. Without this guard,
  // navigating between conversations (e.g. clicking "new chat" while voice is
  // already off) would falsely trigger the reverse stage, causing the chat-bar
  // to unmount and re-mount with a visible flicker.
  const wasVoiceActiveRef = useRef(voiceActive);
  useEffect(() => {
    const prev = wasVoiceActiveRef.current;
    const next = voiceActive;
    wasVoiceActiveRef.current = next;

    if (next && !prev && isEmptyConversation) {
      setBodyShowsVoice(false);
      setVoiceBarReady(false);
      setChatBarReady(true);
      const personaIn = window.setTimeout(() => setBodyShowsVoice(true), 180);
      const barIn = window.setTimeout(() => setVoiceBarReady(true), 180 + 560);
      return () => {
        window.clearTimeout(personaIn);
        window.clearTimeout(barIn);
      };
    }

    if (!next && prev && isEmptyConversation) {
      setVoiceBarReady(false);
      setChatBarReady(false);
      const personaOut = window.setTimeout(() => setBodyShowsVoice(false), 180);
      const chatBarIn = window.setTimeout(() => setChatBarReady(true), 180 + 560);
      return () => {
        window.clearTimeout(personaOut);
        window.clearTimeout(chatBarIn);
      };
    }

    setBodyShowsVoice(next);
    setVoiceBarReady(next);
    setChatBarReady(true);
  }, [voiceActive, isEmptyConversation]);

  const activeBodyMode: ConversationBodyMode = bodyShowsVoice ? "voice" : "chat";

  // The body keeps rendering the outgoing surface until its exit animation has
  // run, so both modes are live for one beat and `exiting` says which is on the
  // way out.
  const [bodyTransition, setBodyTransition] = useState<{
    current: ConversationBodyMode;
    exiting: ConversationBodyMode | null;
  }>(() => ({ current: activeBodyMode, exiting: null }));

  useEffect(() => {
    setBodyTransition((previous) => {
      if (previous.current === activeBodyMode) {
        return previous;
      }

      return { current: activeBodyMode, exiting: previous.current };
    });
  }, [activeBodyMode]);

  useEffect(() => {
    if (!bodyTransition.exiting) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setBodyTransition((previous) => ({ ...previous, exiting: null }));
    }, 560);

    return () => window.clearTimeout(timeout);
  }, [bodyTransition.current, bodyTransition.exiting]);

  return {
    bodyTransition,
    voiceBarReady,
    chatBarReady,
    /** True once the composer slot has settled at sticky-bottom. */
    settledVoiceActive: positionAtBottom,
  };
}
