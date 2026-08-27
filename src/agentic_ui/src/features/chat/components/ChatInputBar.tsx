import React from "react";
import { Mic, MicOff, PhoneOff, Plus, FileText, Check, X } from "lucide-react";
import { HiArrowUp } from "react-icons/hi";
import { VscMicFilled } from "react-icons/vsc";
import { FaStop } from "react-icons/fa6";
// import { RiVoiceprintLine } from "react-icons/ri";
import { PiWaveformBold } from "react-icons/pi";
import { AnimatePresence, motion, useReducedMotion, useAnimationControls } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";

// Spring-with-overshoot tap pulse, matches the one used in ActionBars so the
// feel is consistent across the whole app.
const TAP_PULSE: TargetAndTransition = { scale: [1, 1.28, 1] };
const TAP_PULSE_TRANSITION: Transition = { duration: 0.36, ease: [0.34, 1.56, 0.64, 1] };
import SplitText from "@/shared/ui/react_bits/split_text";
import StarBorder from "@/shared/ui/react_bits/star_border";
import { useVoiceVisualizer, VoiceVisualizer } from "react-voice-visualizer";
import { Loader } from "@/shared/ui/shadcn-io/loader";
import { Suggestion, Suggestions } from "@/shared/ui/ai-elements/suggestion";

import type { DictationStatus } from "@/shared/lib/types";
import { INTERACTIVE_SURFACE } from "@/shared/lib/consts";
export type { DictationStatus };
export type ChatInputMode = "chat" | "voice";

type ChatInputBarProps = {
  /** Replace "top-1/2 -translate-y-1/2" with anything you want */
  positionClass?: string;
  mode?: ChatInputMode;
  /**
   * Gate the voice-bar mount even when mode === "voice". Used by the empty-conversation
   * sequencing so the persona is fully animated in before the voice-bar slides up at
   * the bottom. Defaults to true (mount immediately when mode is "voice").
   */
  voiceBarVisible?: boolean;
  /**
   * Gate the chat-bar mount when mode === "chat". Used by the empty-conversation
   * reverse sequencing so the persona has fully exited before the chat-bar appears
   * at the centered position. Defaults to true (mount immediately when mode is "chat").
   */
  chatBarVisible?: boolean;

  // State/controls from your page
  attachments: any[];
  isMessagesEmpty?: boolean;
  isPrivateMode: boolean;
  thinkingActive?: boolean;
  isStreaming?: boolean;
  currentMessage: string;
  setCurrentMessage: (v: string) => void;
  handlePaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  handleSendMessage: () => void;
  handleStopStreaming?: () => void;

  // Helpers/refs you already have
  isImageFile: (f: any) => boolean;
  getImageUrl: (f: any) => string;
  handleImageClick: (url: string) => void;
  removeAttachment: (i: number) => void;
  handleFileUpload: React.ChangeEventHandler<HTMLInputElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  emptyWrapperStyle?: React.CSSProperties;
  textareaMaxHeight: number;

  // UI bits you already import in the page
  Tooltip: any;
  TooltipTrigger: any;
  TooltipContent: any;

  // Optional extras available in your page
  toast?: (opts: { title: string; description?: string; duration?: number }) => void;
  onVoiceMode?: () => void;
  voiceStatus?: string;
  voiceMuted?: boolean;
  onCloseVoiceMode?: () => void;
  onToggleVoiceMute?: () => void;
  onVoiceTextSubmit?: (text: string) => void;
  currentAgent?: { name?: string; description?: string } | null;
  Textarea: any;
  onDictationSubmit?: (audioBlob: Blob) => void;
  onDictationStatusChange?: (status: DictationStatus) => void;
  dictationStatus?: DictationStatus;
  dictationRequestSignal?: number;
  dictationCancelSignal?: number;
  topAccessory?: React.ReactNode;
  // When set, replaces the chat composer inside the same AnimatePresence
  // swap (voice-bar precedent) — used for the pending-HITL approval surface
  // so the action lives at the bottom where the user is already looking.
  hitlTakeover?: React.ReactNode;
  starterSuggestions?: string[];
  onStarterSuggestionSelect?: (suggestion: string) => void;
};

// Random welcome quotes (use {agent} to inject the agent's name)
const WELCOME_QUOTES: string[] = [
  "Ready when you are.",
  "What do you want to accomplish today?",
  "Ask {agent} anything.",
  "Drop files or paste images to get started.",
  "Tell me your goal! I'll help you get there.",
  "New chat — new ideas.",
  "I can draft, analyze, or plan — your call.",
  "Need a summary, a plan, or code? Say the word.",
  "Let's turn a rough idea into something real.",
  "Small step or big build — we can tackle it together.",
];

export function ChatInputBar(props: ChatInputBarProps) {
  const {
    positionClass = "top-1/2 -translate-y-1/2",
    mode = "chat",
    voiceBarVisible = true,
    chatBarVisible = true,
    isMessagesEmpty = false,
    attachments,
    isPrivateMode,
    thinkingActive,
    isStreaming = false,
    currentMessage,
    setCurrentMessage,
    handlePaste,
    handleSendMessage,
    handleStopStreaming,
    isImageFile,
    getImageUrl,
    handleImageClick,
    removeAttachment,
    handleFileUpload,
    fileInputRef,
    textareaRef,
    containerRef,
    emptyWrapperStyle,
    textareaMaxHeight,
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    toast,
    onVoiceMode,
    voiceStatus,
    voiceMuted = false,
    onCloseVoiceMode,
    onToggleVoiceMute,
    onVoiceTextSubmit,
    currentAgent,
    Textarea,
    onDictationSubmit,
    onDictationStatusChange,
    dictationStatus = "idle",
    dictationRequestSignal,
    dictationCancelSignal,
    topAccessory,
    hitlTakeover,
    starterSuggestions = [],
    onStarterSuggestionSelect,
  } = props;

  // Pick a starting quote whenever agent changes or the empty-state toggles on
  const [quoteIndex, setQuoteIndex] = React.useState<number>(() =>
    Math.floor(Math.random() * WELCOME_QUOTES.length),
  );

  // Reset the starting quote when agent changes OR when the empty-state appears
  React.useEffect(() => {
    if (!isMessagesEmpty) return;
    setQuoteIndex(Math.floor(Math.random() * WELCOME_QUOTES.length));
  }, [currentAgent?.name, isMessagesEmpty]);

  // Rotate to a different random quote every 5s while empty-state is visible
  React.useEffect(() => {
    if (!isMessagesEmpty) return;
    const id = setInterval(() => {
      setQuoteIndex((prev) => {
        if (WELCOME_QUOTES.length < 2) return prev;
        let next = prev;
        // ensure the next quote differs from the current one
        while (next === prev) {
          next = Math.floor(Math.random() * WELCOME_QUOTES.length);
        }
        return next;
      });
    }, 8000);
    return () => clearInterval(id);
  }, [isMessagesEmpty]);

  // Final string with agent name injected
  const welcomeQuote = WELCOME_QUOTES[quoteIndex].replace(
    "{agent}",
    currentAgent?.name ?? "the agent",
  );

  const agentDisplayName = React.useMemo(() => {
    const rawName = currentAgent?.name?.trim();
    if (!rawName) return null;
    return /agent$/i.test(rawName) ? rawName : `${rawName} Agent`;
  }, [currentAgent?.name]);

  // No agent selected → keep the placeholder vague rather than naming one.
  const messagePlaceholder = agentDisplayName
    ? `Message ${agentDisplayName}...`
    : "Type a message...";

  const voiceClosePulse = useAnimationControls();
  const voiceMutePulse = useAnimationControls();

  const attachmentStripRef = React.useRef<HTMLDivElement | null>(null);
  const [attachmentFade, setAttachmentFade] = React.useState({ left: false, right: false });

  // Measure the AnimatePresence inner content and animate the wrapper's actual
  // `height` to the measured value. We need a real height transition (not a scale
  // transform) so the flex container reflows during the animation — this is what
  // makes the body shell grow/shrink smoothly when chat-bar (~150px) swaps with
  // voice-bar (~75px), instead of snapping and dropping the persona.
  const innerMeasureRef = React.useRef<HTMLDivElement | null>(null);
  const [measuredInnerHeight, setMeasuredInnerHeight] = React.useState<number | undefined>(
    undefined,
  );
  React.useEffect(() => {
    const el = innerMeasureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = entry.contentRect.height;
        setMeasuredInnerHeight((prev) => (prev === next ? prev : next));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const orderedAttachments = React.useMemo(() => {
    const indexed = attachments.map((file, index) => ({
      file,
      index,
      isImage: isImageFile(file),
    }));
    return [...indexed.filter((item) => item.isImage), ...indexed.filter((item) => !item.isImage)];
  }, [attachments, isImageFile]);

  // Preview URLs, minted once per attachment list rather than per render.
  // `getImageUrl` calls URL.createObjectURL for a File, and an object URL has no
  // TTL and is never garbage collected — it pins the file until revoked or the
  // document unloads. Calling it inline in the JSX below meant a brand-new,
  // permanently-pinned URL for every attached image on *every keystroke* in the
  // composer. Indexed to match `attachments`, so the ordered list can look up by
  // its original index.
  const attachmentPreviewUrls = React.useMemo(
    () => attachments.map((file) => (isImageFile(file) ? getImageUrl(file) : "")),
    [attachments, isImageFile, getImageUrl],
  );

  React.useEffect(() => {
    return () => {
      // Only revoke what we minted — getImageUrl also returns data: and remote
      // URLs, which must not be revoked.
      attachmentPreviewUrls.forEach((url) => {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      });
    };
  }, [attachmentPreviewUrls]);

  const updateAttachmentFade = React.useCallback(() => {
    const node = attachmentStripRef.current;
    if (!node) {
      setAttachmentFade({ left: false, right: false });
      return;
    }

    const { scrollLeft, clientWidth, scrollWidth } = node;
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    setAttachmentFade({
      left: scrollLeft > 2,
      right: maxScrollLeft - scrollLeft > 2,
    });
  }, []);

  React.useEffect(() => {
    updateAttachmentFade();
  }, [attachments.length, orderedAttachments, updateAttachmentFade]);

  React.useEffect(() => {
    const handleResize = () => updateAttachmentFade();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updateAttachmentFade]);

  const prefersReducedMotion = useReducedMotion();

  const submitAfterStopRef = React.useRef(false);
  const cancelRequestedRef = React.useRef(false);

  const recorderControls = useVoiceVisualizer({
    onStartRecording: () => {
      submitAfterStopRef.current = false;
      cancelRequestedRef.current = false;
      onDictationStatusChange?.("recording");
    },
    onStopRecording: () => {
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        onDictationStatusChange?.("idle");
        return;
      }
      onDictationStatusChange?.(submitAfterStopRef.current ? "submitting" : "review");
    },
    onClearCanvas: () => {
      if (dictationStatus !== "submitting") {
        onDictationStatusChange?.("idle");
      }
    },
    onErrorPlayingAudio: (error) => {
      toast?.({
        title: "Voice input error",
        description: error.message,
        duration: 4000,
      });
    },
  });

  // Amplify waveform amplitudes so quieter speech still animates visibly.
  const VOICE_VISUALIZER_GAIN = 1.8;

  const boostedAudioData = React.useMemo(() => {
    const source = recorderControls.audioData;
    if (!source || source.length === 0) {
      return source;
    }

    const boosted = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
      const centered = source[i] - 128;
      const amplified = 128 + centered * VOICE_VISUALIZER_GAIN;
      boosted[i] = amplified < 0 ? 0 : amplified > 255 ? 255 : Math.round(amplified);
    }
    return boosted;
  }, [recorderControls.audioData]);

  const visualizerControls = React.useMemo(
    () =>
      boostedAudioData ? { ...recorderControls, audioData: boostedAudioData } : recorderControls,
    [boostedAudioData, recorderControls],
  );

  const {
    startRecording,
    stopRecording,
    clearCanvas,
    recordedBlob,
    isRecordingInProgress,
    isProcessingStartRecording,
    isProcessingRecordedAudio,
    _setIsProcessingAudioOnComplete,
  } = recorderControls;

  const isDictationProcessing = isProcessingStartRecording || isProcessingRecordedAudio;
  const isDictationSubmitting = dictationStatus === "submitting";
  const isInDictationMode = dictationStatus !== "idle";
  const isDictationBusy = isDictationProcessing || isDictationSubmitting;

  React.useEffect(() => {
    if (!isProcessingRecordedAudio) {
      try {
        _setIsProcessingAudioOnComplete?.(false);
      } catch {
        // ignore
      }
    }
  }, [isProcessingRecordedAudio, _setIsProcessingAudioOnComplete]);

  const handleDictationRequest = React.useCallback(() => {
    if (isDictationBusy || dictationStatus !== "idle") return;
    try {
      submitAfterStopRef.current = false;
      cancelRequestedRef.current = false;
      startRecording();
      onDictationStatusChange?.("recording");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to access your microphone.";
      toast?.({
        title: "Microphone unavailable",
        description: message,
        duration: 4000,
      });
      onDictationStatusChange?.("idle");
      submitAfterStopRef.current = false;
    }
  }, [dictationStatus, isDictationBusy, onDictationStatusChange, startRecording, toast]);

  const lastDictationRequestSignalRef = React.useRef(dictationRequestSignal ?? 0);
  React.useEffect(() => {
    const nextSignal = dictationRequestSignal ?? 0;
    if (nextSignal === 0 || nextSignal === lastDictationRequestSignalRef.current) {
      return;
    }
    lastDictationRequestSignalRef.current = nextSignal;
    handleDictationRequest();
  }, [dictationRequestSignal, handleDictationRequest]);

  const handleCancelDictation = React.useCallback(() => {
    if (dictationStatus === "idle" || dictationStatus === "submitting") return;
    cancelRequestedRef.current = true;
    try {
      if (isRecordingInProgress) {
        stopRecording();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stop recording.";
      toast?.({
        title: "Voice input error",
        description: message,
        duration: 3000,
      });
    }
    onDictationStatusChange?.("idle");
    clearCanvas();
    submitAfterStopRef.current = false;
    try {
      _setIsProcessingAudioOnComplete?.(false);
    } catch {
      // ignore
    }
  }, [
    clearCanvas,
    dictationStatus,
    isRecordingInProgress,
    onDictationStatusChange,
    stopRecording,
    toast,
    _setIsProcessingAudioOnComplete,
  ]);

  const lastDictationCancelSignalRef = React.useRef(dictationCancelSignal ?? 0);
  React.useEffect(() => {
    const nextSignal = dictationCancelSignal ?? 0;
    if (nextSignal === 0 || nextSignal === lastDictationCancelSignalRef.current) {
      return;
    }
    lastDictationCancelSignalRef.current = nextSignal;
    handleCancelDictation();
  }, [dictationCancelSignal, handleCancelDictation]);

  const handleConfirmDictation = React.useCallback(() => {
    if (dictationStatus === "idle" || dictationStatus === "submitting") return;
    cancelRequestedRef.current = false;
    if (isRecordingInProgress) {
      try {
        submitAfterStopRef.current = true;
        onDictationStatusChange?.("submitting");
        stopRecording();
      } catch (error) {
        submitAfterStopRef.current = false;
        onDictationStatusChange?.("recording");
        const message = error instanceof Error ? error.message : "Unable to stop recording.";
        toast?.({
          title: "Voice input error",
          description: message,
          duration: 3000,
        });
      }
      return;
    }

    if (!recordedBlob) {
      toast?.({
        title: "No recording captured",
        description: "Try recording again before submitting.",
        duration: 2500,
      });
      return;
    }

    submitAfterStopRef.current = false;
    onDictationStatusChange?.("submitting");
    onDictationSubmit?.(recordedBlob);
    try {
      _setIsProcessingAudioOnComplete?.(false);
    } catch {
      // ignore
    }
  }, [
    dictationStatus,
    isRecordingInProgress,
    onDictationSubmit,
    recordedBlob,
    stopRecording,
    toast,
    _setIsProcessingAudioOnComplete,
  ]);

  React.useEffect(() => {
    if (!submitAfterStopRef.current) return;
    if (!recordedBlob) return;
    submitAfterStopRef.current = false;
    onDictationStatusChange?.("submitting");
    onDictationSubmit?.(recordedBlob);
    try {
      _setIsProcessingAudioOnComplete?.(false);
    } catch {
      // ignore
    }
  }, [recordedBlob, onDictationStatusChange, onDictationSubmit, _setIsProcessingAudioOnComplete]);

  const lastStatusRef = React.useRef<DictationStatus>(dictationStatus);
  React.useEffect(() => {
    if (dictationStatus === "idle" && lastStatusRef.current !== "idle") {
      clearCanvas();
      try {
        _setIsProcessingAudioOnComplete?.(false);
      } catch {
        // ignore
      }
    }
    lastStatusRef.current = dictationStatus;
  }, [clearCanvas, dictationStatus, _setIsProcessingAudioOnComplete]);

  const isCancelDisabled = isDictationSubmitting;
  const confirmButtonDisabled = (!isRecordingInProgress && !recordedBlob) || isDictationSubmitting;

  const canSubmitVoiceText = currentMessage.trim().length > 0;
  const rm = prefersReducedMotion ?? false;

  const isCenteredPosition = positionClass.includes("absolute");
  // Only animate the wrapper's position when chat-bar is the active visible bar.
  // For voice-mode transitions in an empty conversation the wrapper's positionClass
  // also changes (sticky-bottom <-> centered), but the bar is empty during the
  // staging gap and the voice-bar mounts AT its final sticky-bottom slot — we don't
  // want Framer Motion to drag the wrapper from the centered position down to the
  // bottom, because that visually pulls the voice-bar in from the middle of the
  // page where the persona is.
  const animateWrapperPosition = mode === "chat" && chatBarVisible;
  return (
    <motion.div
      ref={containerRef as React.Ref<HTMLDivElement>}
      layout={animateWrapperPosition ? "position" : false}
      transition={{ layout: { duration: rm ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] } }}
      transformTemplate={(_, generatedTransform) => {
        // Centered (absolute top-[35%]) slot. Once the wrapper height has been
        // measured, `emptyWrapperStyle` pins the TOP edge via
        // `top: calc(35% - centerAnchorOffset)`, so we translate on X ONLY —
        // a -50% on Y would anchor the box by its vertical center and make it
        // expand both up and down as the textarea auto-grows. The box must
        // only ever grow downward from a fixed top. Before that first
        // measurement (emptyWrapperStyle undefined) we fall back to a full
        // translate(-50%, -50%) so the initial paint is already centered at
        // 35% — both branches land the box in the same spot, so the switch
        // is jump-free. We compose translateX here (not in the className)
        // because Framer Motion's layout animation writes to `transform` and
        // would otherwise clobber a Tailwind translate mid-animation.
        const centerOffset = isCenteredPosition
          ? emptyWrapperStyle
            ? "translateX(-50%)"
            : "translate(-50%, -50%)"
          : "";
        const generated = generatedTransform || "";
        return `${centerOffset} ${generated}`.trim();
      }}
      /* Force dark token scope so the input stays dark even in light theme */
      className={`${positionClass} dark`}
      style={mode === "chat" ? emptyWrapperStyle : undefined}
    >
      <motion.div
        animate={{ height: measuredInnerHeight ?? "auto" }}
        transition={{ duration: rm ? 0 : 0.38, ease: [0.22, 1, 0.36, 1] }}
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          // Sticky-bottom bar grows/shrinks from the bottom (flex-end) so the
          // persona above it doesn't jump during the chat<->voice swap. The
          // centered empty-state instead top-anchors (flex-start) so the
          // height animation reveals new textarea lines DOWNWARD, never up.
          justifyContent: isCenteredPosition ? "flex-start" : "flex-end",
        }}
      >
        <div ref={innerMeasureRef} style={{ width: "100%" }}>
          <AnimatePresence mode="wait">
            {mode === "voice" ? (
              voiceBarVisible ? (
                <motion.div
                  key="voice-bar"
                  initial={{ opacity: 0, y: rm ? 0 : 10 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
                  }}
                  exit={{
                    opacity: 0,
                    y: rm ? 0 : 5,
                    transition: { duration: 0.18, ease: "easeIn" },
                  }}
                  style={{ transformOrigin: "center bottom" }}
                >
                  <div className="relative mx-auto max-w-3xl pointer-events-auto">
                    <div className="relative z-20 rounded-[2rem] border border-border/70 bg-background px-3 py-3 shadow-lg">
                      <div className="flex items-center gap-2">
                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                onCloseVoiceMode?.();
                                voiceClosePulse.start(TAP_PULSE, TAP_PULSE_TRANSITION);
                              }}
                              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10 text-destructive transition-smooth hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                              aria-label="Close voice mode"
                            >
                              <motion.span animate={voiceClosePulse} className="inline-flex">
                                <PhoneOff size={18} />
                              </motion.span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="center">
                            <p>Close voice mode</p>
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                onToggleVoiceMute?.();
                                voiceMutePulse.start(TAP_PULSE, TAP_PULSE_TRANSITION);
                              }}
                              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                              aria-label={voiceMuted ? "Unmute microphone" : "Mute microphone"}
                            >
                              <motion.span animate={voiceMutePulse} className="inline-flex">
                                {voiceMuted ? <MicOff size={19} /> : <Mic size={19} />}
                              </motion.span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="center">
                            <p>{voiceMuted ? "Unmute microphone" : "Mute microphone"}</p>
                          </TooltipContent>
                        </Tooltip>

                        <div className="min-w-0 flex-1">
                          <Textarea
                            ref={(textarea: any) => {
                              (textareaRef as any).current = textarea;
                            }}
                            value={currentMessage}
                            onChange={(e: any) => setCurrentMessage(e.target.value)}
                            placeholder={
                              voiceStatus === "connecting"
                                ? "Connecting voice..."
                                : "Type to the voice session..."
                            }
                            onKeyDown={(e: any) => {
                              if (e.key === "Enter" && !e.shiftKey && canSubmitVoiceText) {
                                e.preventDefault();
                                onVoiceTextSubmit?.(currentMessage);
                                setCurrentMessage("");
                              }
                            }}
                            className="max-h-24 min-h-[44px] w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-3 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
                            rows={1}
                          />
                        </div>

                        <StarBorder
                          as="button"
                          innerClassName="w-11 h-11"
                          className="shadow-elegant active:scale-110 hover:opacity-90 transition-smooth"
                          color="hsl(var(--primary))"
                          thickness={2}
                          onClick={() => {
                            if (!canSubmitVoiceText) return;
                            onVoiceTextSubmit?.(currentMessage);
                            setCurrentMessage("");
                          }}
                          disabled={!canSubmitVoiceText}
                        >
                          <HiArrowUp size={18} />
                        </StarBorder>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : null
            ) : hitlTakeover ? (
              <motion.div
                key="hitl-bar"
                initial={{ opacity: 0, y: rm ? 0 : 10 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{ opacity: 0, y: rm ? 0 : 5, transition: { duration: 0.18, ease: "easeIn" } }}
                style={{ transformOrigin: "center bottom" }}
              >
                <div className="relative mx-auto max-w-3xl pointer-events-auto">{hitlTakeover}</div>
              </motion.div>
            ) : chatBarVisible ? (
              <motion.div
                key="chat-bar"
                initial={{ opacity: 0, y: rm ? 0 : 10 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{ opacity: 0, y: rm ? 0 : 5, transition: { duration: 0.18, ease: "easeIn" } }}
                style={{ transformOrigin: "center bottom" }}
              >
                {isMessagesEmpty && (
                  <div className="text-center py-8 md:py-16 pointer-events-none">
                    {/* Random welcome quote */}
                    <div className="min-h-[2.75rem] md:min-h-[3rem]">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={quoteIndex}
                          variants={{
                            exit: { opacity: 0, y: prefersReducedMotion ? 0 : -8 },
                          }}
                          exit="exit"
                          transition={{ duration: 0.35, ease: "easeOut" }}
                          initial={false}
                          className="text-xl md:text-2xl font-bold mb-2 md:mb-3"
                        >
                          <SplitText
                            text={welcomeQuote}
                            tag="h2"
                            useScrollTrigger={false}
                            from={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }}
                            to={{ opacity: 1, y: 0 }}
                            duration={1}
                            delay={25}
                            splitType="chars"
                          />
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* Optional: keep agent description as a softer subline if present */}
                    {currentAgent?.description && (
                      <p className="text-muted-foreground text-sm md:text-lg max-w-md mx-auto">
                        {currentAgent.description}
                      </p>
                    )}
                  </div>
                )}

                <div className="relative mx-auto max-w-3xl pointer-events-auto">
                  {topAccessory}
                  {/* Floating Input Container */}
                  <div
                    className={`relative z-20 bg-background rounded-[2rem] shadow-lg px-3 pt-3 pb-1 ${
                      isPrivateMode ? "border-2 border-primary/50" : "border"
                    }`}
                  >
                    <div className="flex flex-col">
                      <div
                        className={`transition-all duration-200 overflow-hidden ${attachments.length ? "mb-4 opacity-100" : "mb-0 opacity-0"}`}
                      >
                        {attachments.length > 0 && (
                          <div className="relative overflow-hidden rounded-2xl">
                            <div
                              ref={attachmentStripRef}
                              onScroll={updateAttachmentFade}
                              className="attachment-strip-scroll overflow-x-auto px-2 pr-7 pb-1"
                            >
                              <div className="flex min-w-max flex-nowrap items-center gap-2">
                                {orderedAttachments.map(({ file, index, isImage }) => {
                                  return (
                                    <div
                                      key={index}
                                      className={`relative shrink-0 overflow-hidden rounded-2xl border border-border bg-secondary/70 shadow-card ${
                                        isImage
                                          ? "flex items-center p-1.5"
                                          : "flex items-center gap-2.5 px-3 py-2.5 max-w-[14rem] md:max-w-[16rem]"
                                      }`}
                                    >
                                      {isImage ? (
                                        <div className="flex items-center">
                                          <img
                                            src={attachmentPreviewUrls[index]}
                                            alt="Preview"
                                            className="h-14 w-14 rounded-xl object-cover cursor-pointer"
                                            onClick={() =>
                                              handleImageClick(attachmentPreviewUrls[index])
                                            }
                                          />
                                        </div>
                                      ) : (
                                        <>
                                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                            <FileText size={16} className="text-primary" />
                                          </div>
                                          <div className="min-w-0 flex-1 pr-5">
                                            <span className="block truncate text-sm font-medium">
                                              {file.name}
                                            </span>
                                          </div>
                                        </>
                                      )}
                                      <button
                                        onClick={() => removeAttachment(index)}
                                        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm ring-1 ring-border/70 backdrop-blur transition-smooth hover:text-destructive/80"
                                        aria-label="Remove attachment"
                                      >
                                        <X
                                          size={12}
                                          strokeWidth={2.5}
                                          className="pointer-events-none"
                                        />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            {attachmentFade.left && (
                              <div className="pointer-events-none absolute inset-y-0 left-0 w-5 rounded-l-2xl bg-gradient-to-r from-background via-background/88 to-transparent" />
                            )}
                            {attachmentFade.right && (
                              <div className="pointer-events-none absolute inset-y-0 right-0 w-5 rounded-r-2xl bg-gradient-to-l from-background via-background/88 to-transparent" />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Text Input Area */}
                      <div className="w-full">
                        {dictationStatus === "idle" ? (
                          <Textarea
                            ref={(textarea: any) => {
                              (textareaRef as any).current = textarea;
                            }}
                            value={currentMessage}
                            onChange={(e: any) => setCurrentMessage(e.target.value)}
                            onPaste={handlePaste}
                            placeholder={messagePlaceholder}
                            onKeyDown={(e: any) => {
                              const shouldSubmit =
                                e.key === "Enter" &&
                                !e.shiftKey &&
                                !thinkingActive &&
                                !isStreaming &&
                                (currentMessage.trim() || attachments.length > 0);
                              if (shouldSubmit) {
                                e.preventDefault();
                                handleSendMessage();
                              }
                            }}
                            className="bg-transparent border-0 focus:ring-0 focus:outline-none min-h-[48px] text-base px-4 py-3 resize-none overflow-y-auto text-foreground placeholder:text-muted-foreground w-full"
                            rows={1}
                            style={{ height: "auto", maxHeight: textareaMaxHeight }}
                          />
                        ) : (
                          <div className="px-3 pt-1 pb-2">
                            <VoiceVisualizer
                              controls={visualizerControls}
                              isDefaultUIShown={false}
                              isControlPanelShown={false}
                              isAudioProcessingTextShown={false}
                              height={49}
                              backgroundColor="transparent"
                              mainBarColor="rgba(255,255,255,0.85)"
                              secondaryBarColor="rgba(255,255,255,0.25)"
                              barWidth={1}
                              gap={2}
                              rounded={5}
                              canvasContainerClassName="w-full h-12 [&>canvas]:scale-y-[2.55] [&>canvas]:origin-center"
                              mainContainerClassName="w-full"
                            />
                          </div>
                        )}
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1">
                          <Tooltip delayDuration={0}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="w-10 h-10 rounded-full hover:bg-[hsl(var(--hover-surface))] transition-smooth cursor-pointer flex items-center justify-center active:bg-[hsl(var(--hover-surface-strong))] active:scale-110 focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                                onClick={() => fileInputRef.current?.click()}
                                aria-label="Attach files"
                              >
                                <Plus
                                  size={24}
                                  className="text-muted-foreground active:text-white"
                                />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="center">
                              <p>Attach files & photos</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>

                        {dictationStatus === "idle" ? (
                          <div className="flex items-center gap-2">
                            <Tooltip delayDuration={0}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="w-10 h-10 rounded-full hover:bg-[hsl(var(--hover-surface))] transition-smooth cursor-pointer flex items-center justify-center active:bg-[hsl(var(--hover-surface-strong))] active:scale-110 focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 disabled:opacity-40 disabled:cursor-not-allowed"
                                  onClick={handleDictationRequest}
                                  disabled={isDictationBusy || isStreaming || isInDictationMode}
                                  aria-label="Start voice dictation"
                                >
                                  <VscMicFilled
                                    size={21}
                                    className="text-muted-foreground active:text-white"
                                  />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" align="center">
                                <p>
                                  {isDictationSubmitting
                                    ? "Transcribing..."
                                    : isDictationProcessing
                                      ? "Preparing microphone..."
                                      : "Dictate"}
                                </p>
                              </TooltipContent>
                            </Tooltip>

                            <Tooltip delayDuration={0}>
                              <TooltipTrigger asChild>
                                <StarBorder
                                  as="button"
                                  innerClassName="w-11 h-11"
                                  className="shadow-elegant active:scale-110 hover:opacity-90 transition-smooth"
                                  color="hsl(var(--primary))"
                                  thickness={2}
                                  onClick={() => {
                                    if (isStreaming) {
                                      handleStopStreaming?.();
                                    } else if (!currentMessage.trim() && attachments.length === 0) {
                                      onVoiceMode?.();
                                    } else {
                                      handleSendMessage();
                                    }
                                  }}
                                  disabled={
                                    isInDictationMode ||
                                    isDictationSubmitting ||
                                    (!isStreaming && !!thinkingActive)
                                  }
                                >
                                  {isStreaming ? (
                                    <FaStop size={18} />
                                  ) : !currentMessage.trim() && attachments.length === 0 ? (
                                    <PiWaveformBold size={22} />
                                  ) : (
                                    <HiArrowUp size={18} />
                                  )}
                                </StarBorder>
                              </TooltipTrigger>
                            </Tooltip>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Tooltip delayDuration={0}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className={`w-10 h-10 rounded-full border border-border text-muted-foreground flex items-center justify-center transition-smooth ${INTERACTIVE_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground/60 disabled:opacity-40 disabled:cursor-not-allowed`}
                                  onClick={handleCancelDictation}
                                  disabled={isCancelDisabled}
                                  aria-label="Cancel voice dictation"
                                >
                                  <X size={18} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" align="center">
                                <p>Discard recording</p>
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip delayDuration={0}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="w-10 h-10 rounded-full border border-primary/60 bg-primary/15 text-primary flex items-center justify-center transition-smooth hover:bg-primary/25 active:bg-primary/35 focus-visible:bg-primary/25 active:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 disabled:cursor-not-allowed"
                                  onClick={handleConfirmDictation}
                                  disabled={confirmButtonDisabled}
                                  aria-label="Use recording"
                                >
                                  {isDictationSubmitting ? (
                                    <Loader size={18} className="text-primary" />
                                  ) : (
                                    <Check size={18} />
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" align="center">
                                <p>Use recording</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="*/*"
                    className="hidden"
                    onChange={(e) => {
                      handleFileUpload(e);
                      e.currentTarget.value = "";
                    }}
                  />
                  <AnimatePresence initial={false}>
                    {starterSuggestions.length > 0 ? (
                      <motion.div
                        key="starter-suggestions"
                        initial={{
                          opacity: 0,
                          y: prefersReducedMotion ? 0 : -4,
                          filter: "blur(6px)",
                        }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4, filter: "blur(6px)" }}
                        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                        className="absolute left-0 right-0 top-[calc(100%+0.75rem)] z-10"
                      >
                        <Suggestions wrap className="px-1">
                          {starterSuggestions.map((suggestion, index) => (
                            <motion.div
                              key={suggestion}
                              initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: prefersReducedMotion ? 0 : 6, scale: 0.98 }}
                              transition={{
                                duration: 0.36,
                                delay: prefersReducedMotion ? 0 : index * 0.045,
                                ease: [0.22, 1, 0.36, 1],
                              }}
                            >
                              <Suggestion
                                suggestion={suggestion}
                                onClick={onStarterSuggestionSelect}
                                className="border-border/60 bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors duration-200 hover:bg-[hsl(var(--hover-surface))] hover:text-foreground"
                              />
                            </motion.div>
                          ))}
                        </Suggestions>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
