import { useCallback, useMemo, useRef, useState } from "react";

import { createAttachmentHandlers } from "@/features/attachments/handlers/attachments";
import { type DictationStatus } from "@/features/chat/components/ChatInputBar";
import { useCenteredComposerLayout } from "@/features/chat/hooks/useChatEffects";
import { createVoiceDictationHandlers } from "@/features/voice/handlers/voice";
import type { ConversationDetail } from "@/shared/lib/types";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

type UseComposerOptions = {
  userId: string | null;
  currentConversation: ConversationDetail | null;
  toast: ToastFn;
  /**
   * From `useInferenceRuns`. Combined with the local send flag to form `isBusy`,
   * which is what actually gates input — a server-owned run still streaming into
   * this conversation must block a second send just as a local one does.
   */
  isConversationStreaming: boolean;
};

/**
 * Everything the message composer owns: the draft, its attachments, the
 * in-flight send flag, the dictation state machine, and the centered-empty-state
 * layout.
 *
 * It deliberately stops short of *sending*. `createInferenceHandlers` needs the
 * conversation, the agent list and the run machinery to start a run, so the send
 * pipeline stays with the caller and this hook hands it the setters it writes
 * through (`setCurrentMessage`, `setAttachments`, `setIsSendingMessage`). The
 * same setters are what conversation-switch and shared-conversation handlers use
 * to clear the composer, which is the other reason they are exposed rather than
 * sealed in here.
 */
export function useComposer({
  userId,
  currentConversation,
  toast,
  isConversationStreaming,
}: UseComposerOptions) {
  const [currentMessage, setCurrentMessage] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSendingMessage, setIsSendingMessage] = useState(false);

  // Dictation state machine. The two signals are counters, not booleans: the
  // recorder lives inside ChatInputBar, so the only way to ask it to start or
  // cancel is to hand it a value that changed.
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");
  const [dictationRequestSignal, setDictationRequestSignal] = useState(0);
  const [dictationCancelSignal, setDictationCancelSignal] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** A local send OR a run already streaming server-side. */
  const isBusy = isSendingMessage || isConversationStreaming;
  const isMessagesEmpty = (currentConversation?.messages?.length ?? 0) === 0;

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const openAttachments = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const startDictation = useCallback(() => {
    if (isBusy || dictationStatus !== "idle") {
      return;
    }
    setDictationRequestSignal((prev) => prev + 1);
  }, [dictationStatus, isBusy]);

  const cancelDictation = useCallback(() => {
    // "submitting" is past the point of no return — the audio is already on its
    // way to transcription, so cancelling would strand the status.
    if (dictationStatus === "idle" || dictationStatus === "submitting") {
      return;
    }
    setDictationCancelSignal((prev) => prev + 1);
  }, [dictationStatus]);

  const { handleDictationSubmit, handleDictationStatusChange } = useMemo(
    () =>
      createVoiceDictationHandlers({
        userId,
        setCurrentMessage,
        setDictationStatus,
        textareaRef,
        toast,
      }),
    [userId, toast],
  );

  const {
    handleFileUpload,
    handlePaste,
    removeAttachment,
    isImageFile,
    getImageUrl,
    handleFileDownload,
  } = useMemo(
    () =>
      createAttachmentHandlers({
        attachments,
        setAttachments,
        toast,
        userId,
        currentConversation,
      }),
    [attachments, toast, userId, currentConversation],
  );

  const {
    containerRef: composerContainerRef,
    emptyWrapperStyle,
    textareaMaxHeight,
  } = useCenteredComposerLayout({
    isMessagesEmpty,
    textareaRef,
    currentMessage,
    attachmentsCount: attachments.length,
  });

  /** Fill the draft from a starter chip and put the caret in it. */
  const applyDraft = useCallback((text: string) => {
    setCurrentMessage(text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  return {
    currentMessage,
    setCurrentMessage,
    attachments,
    setAttachments,
    isSendingMessage,
    setIsSendingMessage,
    isBusy,
    isMessagesEmpty,
    applyDraft,
    // refs
    fileInputRef,
    textareaRef,
    composerContainerRef,
    // layout
    emptyWrapperStyle,
    textareaMaxHeight,
    // dictation
    dictationStatus,
    dictationRequestSignal,
    dictationCancelSignal,
    startDictation,
    cancelDictation,
    handleDictationSubmit,
    handleDictationStatusChange,
    // input affordances
    focusComposer,
    openAttachments,
    handleFileUpload,
    handlePaste,
    removeAttachment,
    isImageFile,
    getImageUrl,
    handleFileDownload,
  };
}
