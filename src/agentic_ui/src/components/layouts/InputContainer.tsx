import React from "react";
import type { LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import SplitText from "@/components/utils/react_bits/split_text";
import StarBorder from "@/components/utils/react_bits/star_border";


type InputContainerProps = {
    /** Replace "top-1/2 -translate-y-1/2" with anything you want */
    positionClass?: string;

    // State/controls from your page
    attachments: any[];
    isMessagesEmpty?: boolean;
    isPrivateMode: boolean;
    thinkingActive?: boolean;
    currentMessage: string;
    setCurrentMessage: (v: string) => void;
    handlePaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
    handleSendMessage: () => void;

    // Helpers/refs you already have
    isImageFile: (f: any) => boolean;
    getImageUrl: (f: any) => string;
    handleImageClick: (url: string) => void;
    removeAttachment: (i: number) => void;
    handleFileUpload: React.ChangeEventHandler<HTMLInputElement>;
    fileInputRef: React.RefObject<HTMLInputElement>;
    textareaRef: React.RefObject<HTMLTextAreaElement>;

    // UI bits you already import in the page
    AgentIcon: LucideIcon;
    Tooltip: any;
    TooltipTrigger: any;
    TooltipContent: any;
    Paperclip: any;
    Mic: any;
    Button: any;
    Send: any;
    X: any; // Add X icon for remove functionality

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
        currentMessage,
        setCurrentMessage,
        handlePaste,
        handleSendMessage,
        isImageFile,
        getImageUrl,
        handleImageClick,
        removeAttachment,
        handleFileUpload,
        fileInputRef,
        textareaRef,
        AgentIcon,
        Tooltip,
        TooltipTrigger,
        TooltipContent,
        Paperclip,
        Mic,
        Button,
        Send,
        X,
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
        if (!isMessagesEmpty) return;               // pause rotation when messages exist
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
        return () => clearInterval(id);             // clean up on unmount or when empty-state hides
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
            /* Force dark token scope so the input stays dark even in light theme */
            className={`${positionClass} dark`}
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
                {/* Attachments */}
                {attachments.length > 0 && (
                    <div className="mb-4 flex flex-wrap gap-2 justify-center">
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
                                        <Paperclip size={14} className="text-primary" />
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
                
                {/* Floating Input Container */}
                <div
                    className={`bg-background rounded-2xl shadow-lg p-4 ${
                        isPrivateMode ? "border-2 border-primary/50" : "border"
                    }`}
                >
                    <div className="flex items-center gap-3">
                        {/* Text Input Area */}
                        <div className="flex-1">
                            <Textarea
                                ref={(textarea: any) => {
                                // keep your existing auto-resize logic
                                (textareaRef as any).current = textarea;
                                if (textarea) {
                                    textarea.style.height = "auto";
                                    textarea.style.height = Math.min(textarea.scrollHeight, 144) + "px";
                                }
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
                                    (currentMessage.trim() || attachments.length > 0)
                                ) {
                                    e.preventDefault();
                                    handleSendMessage();
                                }
                                }}
                                className="bg-transparent border-0 focus:ring-0 focus:outline-none min-h-[48px] max-h-[144px] text-base px-4 py-3 resize-none overflow-y-auto text-foreground placeholder:text-muted-foreground"
                                rows={1}
                                style={{ height: "auto" }}
                            />
                        </div>
                        
                        {/* Action Buttons */}
                        <div className="flex items-center gap-2">
                            {/* Attach files */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div
                                        className="w-10 h-10 rounded-full hover:bg-muted transition-smooth cursor-pointer flex items-center justify-center active:bg-muted/80 active:scale-110"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <Paperclip size={18} className="text-muted-foreground active:text-white" />
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
                            
                            {/* Voice Input */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div
                                        className="w-10 h-10 rounded-full hover:bg-muted transition-smooth cursor-pointer flex items-center justify-center active:bg-muted/80 active:scale-110"
                                        onClick={() =>
                                        toast?.({ title: "Voice input", description: "Feature coming soon!", duration: 2000 })
                                        }
                                    >
                                        <Mic size={18} className="text-muted-foreground active:text-white" />
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
                            
                            {/* Send Message */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <StarBorder
                                        innerClassName="bg-gradient-primary text-primary-foreground flex items-center justify-center h-10 w-10 py-0 px-0 border-0 rounded-full font-normal text-[inherit]"  // Overrides default inner styles to match original button; added flex centering for icon, removed unnecessary padding/text styles
                                        className="shadow-elegant active:scale-110 hover:opacity-90 transition-smooth"  // Added hover and transition here for the outer container
                                        color="hsl(var(--primary))"  // Use your theme's primary color variable for the star effect; fallback to 'magenta' or any color
                                        thickness={3}
                                        onClick={handleSendMessage}
                                        disabled={(!currentMessage.trim() && attachments.length === 0) || !!thinkingActive}
                                    >
                                        <Send size={16} />
                                    </StarBorder>
                                </TooltipTrigger>
                                <TooltipContent
                                    side="top"
                                    align="center"
                                    className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                >
                                    <p>Send Message</p>
                                </TooltipContent>
                            </Tooltip>
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
