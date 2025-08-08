import React from "react";
import type { LucideIcon } from 'lucide-react';

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

    // Optional extras available in your page
    toast?: (opts: { title: string; description?: string; duration?: number }) => void;
    currentAgent?: { name?: string; description?: string } | null;
    Textarea: any;
};

export function InputContainer({
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
    toast,
    currentAgent,
    Textarea,
}: InputContainerProps) {
    return (
        <div
            className={`${positionClass} `}
        >
            {isMessagesEmpty && (
                <div className="text-center py-16">
                    <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-gradient-primary flex items-center justify-center mx-auto mb-4 md:mb-6 shadow-elegant">
                        <AgentIcon size={40} className="hidden md:block text-primary-foreground" />
                    </div>
                    <h3 className="text-xl md:text-2xl font-bold mb-2 md:mb-3">
                        Welcome to {currentAgent?.name}
                    </h3>
                    <p className="text-muted-foreground text-sm md:text-lg max-w-md mx-auto">
                        {currentAgent?.description}
                    </p>
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
                                    className={`flex items-center gap-2 bg-secondary/70 px-4 py-2 rounded-xl text-sm shadow-card border border-border ${isImg ? "pr-2" : ""}`}
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
                                        <span className="font-medium">{file.name}</span>
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
                                className="bg-transparent border-0 focus:ring-0 focus:outline-none min-h-[48px] max-h-[144px] text-base px-4 py-3 resize-none overflow-y-auto"
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
                                <TooltipContent>
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
                                <TooltipContent>
                                    <p>Voice Input</p>
                                </TooltipContent>
                            </Tooltip>

                            {/* Send Message */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        onClick={handleSendMessage}
                                        disabled={(!currentMessage.trim() && attachments.length === 0) || !!thinkingActive}
                                        className="bg-gradient-primary hover:opacity-90 transition-smooth shadow-elegant h-10 w-10 active:scale-110"
                                    >
                                        <Send size={16} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
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
