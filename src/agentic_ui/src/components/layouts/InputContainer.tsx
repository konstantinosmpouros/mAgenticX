import React from "react";
import type { LucideIcon } from 'lucide-react';
import { Plus, FileText } from "lucide-react";
import { HiArrowUp } from "react-icons/hi";
import { VscMicFilled } from "react-icons/vsc";
import { FaStop } from "react-icons/fa6";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import SplitText from "@/components/ui/react_bits/split_text";
import StarBorder from "@/components/ui/react_bits/star_border";

type InputContainerProps = {
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

export function InputContainer(props: InputContainerProps) {
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
                    className={`bg-background rounded-3xl shadow-lg px-3 pt-3 pb-1 ${
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
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center justify-between gap-3">
                            <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                    <div
                                        className="w-10 h-10 rounded-full hover:bg-muted transition-smooth cursor-pointer flex items-center justify-center active:bg-muted/80 active:scale-110"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <Plus size={20} className="text-muted-foreground active:text-white" />
                                    </div>
                                </TooltipTrigger>
                                <TooltipContent
                                    side="top"
                                    align="center"
                                    className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                >
                                    <p>Attach files & photos</p>
                                </TooltipContent>
                            </Tooltip>

                            <div className="flex items-center gap-2">
                                <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                        <div
                                            className="w-10 h-10 rounded-full hover:bg-muted transition-smooth cursor-pointer flex items-center justify-center active:bg-muted/80 active:scale-110"
                                            onClick={() =>
                                                toast?.({ title: "Voice input", description: "Feature coming soon!", duration: 2000 })
                                            }
                                        >
                                            <VscMicFilled size={21} className="text-muted-foreground active:text-white" />
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="top"
                                        align="center"
                                        className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                    >
                                        <p>Voice Input</p>
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
                                            disabled={isStreaming ? false : ((!currentMessage.trim() && attachments.length === 0) || !!thinkingActive)}
                                        >
                                            {isStreaming ? <FaStop size={16} /> : <HiArrowUp size={16} />}
                                        </StarBorder>
                                    </TooltipTrigger>
                                </Tooltip>
                            </div>
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
