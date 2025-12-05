import React from "react";
import type { LucideIcon } from 'lucide-react';
import { Plus, FileText, Check, X } from "lucide-react";
import { HiArrowUp } from "react-icons/hi";
import { VscMicFilled } from "react-icons/vsc";
import { FaStop } from "react-icons/fa6";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import SplitText from "@/components/ui/react_bits/split_text";
import StarBorder from "@/components/ui/react_bits/star_border";
import { useVoiceVisualizer, VoiceVisualizer } from "react-voice-visualizer";
import { Loader } from "@/components/ui/shadcn-io/loader";

export type DictationStatus = "idle" | "recording" | "review" | "submitting";

type ChatInputBarProps = {
    /** Replace "top-1/2 -translate-y-1/2" with anything you want */
    positionClass?: string;

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
    AgentIcon: LucideIcon;
    Tooltip: any;
    TooltipTrigger: any;
    TooltipContent: any;

    // Optional extras available in your page
    toast?: (opts: { title: string; description?: string; duration?: number }) => void;
    currentAgent?: { name?: string; description?: string } | null;
    Textarea: any;
    onDictationSubmit?: (audioBlob: Blob) => void;
    onDictationStatusChange?: (status: DictationStatus) => void;
    dictationStatus?: DictationStatus;
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
    "Let’s turn a rough idea into something real.",
    "Small step or big build — we can tackle it together.",
];

export function ChatInputBar(props: ChatInputBarProps) {
    const {
        positionClass = "top-1/2 -translate-y-1/2",
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
        AgentIcon,
        Tooltip,
        TooltipTrigger,
        TooltipContent,
        toast,
        currentAgent,
        Textarea,
        onDictationSubmit,
        onDictationStatusChange,
        dictationStatus = "idle",
    } = props;

    
    // Pick a starting quote whenever agent changes or the empty-state toggles on
    const [quoteIndex, setQuoteIndex] = React.useState<number>(() =>
        Math.floor(Math.random() * WELCOME_QUOTES.length)
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
            setQuoteIndex(prev => {
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
        currentAgent?.name ?? "the agent"
    );
    
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
            onDictationStatusChange?.(
                submitAfterStopRef.current ? "submitting" : "review",
            );
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
            boosted[i] = amplified < 0
                ? 0
                : amplified > 255
                    ? 255
                    : Math.round(amplified);
        }
        return boosted;
    }, [recorderControls.audioData]);

    const visualizerControls = React.useMemo(
        () =>
            boostedAudioData
                ? { ...recorderControls, audioData: boostedAudioData }
                : recorderControls,
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
    const confirmButtonDisabled =
        (!isRecordingInProgress && !recordedBlob) ||
        isDictationSubmitting;
    
    const quoteVariants = {
        initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: prefersReducedMotion ? 0 : -8 },
    };
    
    return (
        <div
            ref={containerRef}
            /* Force dark token scope so the input stays dark even in light theme */
            className={`${positionClass} dark`}
            style={emptyWrapperStyle}
        >
            {isMessagesEmpty && (
                <div className="text-center py-16">
                    {/* <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-gradient-primary flex items-center justify-center mx-auto mb-4 md:mb-6 shadow-elegant">
                        <AgentIcon size={40} className="hidden md:block text-primary-foreground" />
                    </div> */}
                    
                    {/* Random welcome quote */}
                    <div className="min-h-[2.75rem] md:min-h-[3rem]">
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={quoteIndex} // key causes exit/enter on change
                                variants={{
                                    exit: { opacity: 0, y: prefersReducedMotion ? 0 : -8 }
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
            
            <div className="mx-auto max-w-3xl pointer-events-auto">
                {/* Floating Input Container */}
                <div
                    className={`bg-background rounded-[2rem] shadow-lg px-3 pt-3 pb-1 ${
                        isPrivateMode ? "border-2 border-primary/50" : "border"
                    }`}
                >
                    <div className="flex flex-col">
                        <div
                            className={`transition-all duration-200 overflow-hidden ${attachments.length ? "mb-4 opacity-100" : "mb-0 opacity-0"}`}
                        >
                            {attachments.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center">
                                    {attachments.map((file, index) => {
                                        const isImg = isImageFile(file);
                                        return (
                                            <div
                                                key={index}
                                                className={`flex items-center gap-2 bg-secondary/70 px-4 py-2 rounded-xl text-sm shadow-card border border-border ${isImg ? "pr-2" : "w-64 md:w-80 "}`}
                                            >
                                                {isImg ? (
                                                    <div className="flex items-center gap-2">
                                                        <img
                                                            src={getImageUrl(file)}
                                                            alt="Preview"
                                                            className="w-8 h-8 object-cover rounded cursor-pointer"
                                                            onClick={() => handleImageClick(getImageUrl(file))}
                                                        />
                                                    </div>
                                                ) : (
                                                    <>
                                                        <FileText size={18} className="text-primary" />
                                                        <div className="flex-1 min-w-0">
                                                            <span className="font-medium truncate block">{file.name}</span>
                                                        </div>
                                                    </>
                                                )}
                                                <button
                                                    onClick={() => removeAttachment(index)}
                                                    className="text-destructive hover:text-destructive/80 transition-smooth ml-2 w-5 h-5 rounded-full bg-destructive/20 flex items-center justify-center"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        );
                                    })}
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
                                    placeholder={`Message ${currentAgent?.name}...`}
                                    onKeyDown={(e: any) => {
                                        if (
                                            e.key === "Enter" &&
                                            !e.shiftKey &&
                                            !thinkingActive &&
                                            !isStreaming &&
                                            (currentMessage.trim() || attachments.length > 0)
                                        ) {
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
                            <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        className="w-10 h-10 rounded-full hover:bg-[hsl(var(--hover-surface))] transition-smooth cursor-pointer flex items-center justify-center active:bg-[hsl(var(--hover-surface-strong))] active:scale-110 focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                                        onClick={() => fileInputRef.current?.click()}
                                        aria-label="Attach files"
                                    >
                                        <Plus size={20} className="text-muted-foreground active:text-white" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent
                                    side="top"
                                    align="center"
                                    className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                >
                                    <p>Attach files & photos</p>
                                </TooltipContent>
                            </Tooltip>

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
                                                <VscMicFilled size={21} className="text-muted-foreground active:text-white" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="top"
                                            align="center"
                                            className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
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
                                                innerClassName="bg-gradient-primary text-primary-foreground flex items-center justify-center border-0 rounded-full"
                                                className="shadow-elegant active:scale-110 hover:opacity-90 transition-smooth"
                                                color="hsl(var(--primary))"
                                                thickness={2}
                                                onClick={() => {
                                                    if (isStreaming) {
                                                        handleStopStreaming?.();
                                                    } else {
                                                        handleSendMessage();
                                                    }
                                                }}
                                                disabled={
                                                    isInDictationMode ||
                                                    isDictationSubmitting ||
                                                    (isStreaming
                                                        ? false
                                                        : ((!currentMessage.trim() && attachments.length === 0) || !!thinkingActive))
                                                }
                                            >
                                                {isStreaming ? <FaStop size={16} /> : <HiArrowUp size={16} />}
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
                                                className="w-10 h-10 rounded-full border border-border text-muted-foreground flex items-center justify-center transition-smooth hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground/60 disabled:opacity-40 disabled:cursor-not-allowed"
                                                onClick={handleCancelDictation}
                                                disabled={isCancelDisabled}
                                                aria-label="Cancel voice dictation"
                                            >
                                                <X size={18} />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="top"
                                            align="center"
                                            className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
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
                                        <TooltipContent
                                            side="top"
                                            align="center"
                                            className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
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
                    onChange={(e) => { handleFileUpload(e); e.currentTarget.value = ''; }}
                />
            </div>
        </div>
    );
}
