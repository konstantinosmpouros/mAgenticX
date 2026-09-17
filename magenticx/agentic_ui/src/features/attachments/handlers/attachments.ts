import { validateAdd } from "@/shared/lib/uploadGuards";
import { downloadAttachment } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type { ConversationDetail, MessageOut } from "@/shared/lib/types";

// Attachment handlers centralize the file lifecycle for the composer:
// validate pending files, derive previews, and fetch persisted blobs.
type AttachmentsCtx = {
  attachments: File[];
  setAttachments: (updater: (prev: File[]) => File[]) => void;
  toast: (opts: {
    title: string;
    description?: string;
    variant?: string;
    duration?: number;
  }) => void;
  userId?: string | null;
  currentConversation?: ConversationDetail | null;
};

export function createAttachmentHandlers(ctx: AttachmentsCtx) {
  const { attachments, setAttachments, toast } = ctx;

  const isImageFile = (file: File | any): boolean => {
    // Pending uploads, persisted attachments, and raw urls each expose different fields.
    if (file?.mime) return file.mime.startsWith("image/");
    if (file?.type) return file.type.startsWith("image/");
    if (file?.url) return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.url);
    if (typeof file === "string") return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file);
    return false;
  };

  const getImageUrl = (file: File | any): string => {
    // Return the best preview source without forcing the caller to care about attachment shape.
    if (file?.data && file?.mime) return `data:${file.mime};base64,${file.data}`;
    if (file?.url) return file.url;
    if (file instanceof File) return URL.createObjectURL(file);
    if (typeof file === "string") return file;
    return "";
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target as HTMLInputElement;
    const files: File[] = input.files ? Array.from(input.files) : [];
    // Reset the native input when nothing is selected so choosing the same file still works later.
    if (files.length === 0) {
      if (input) input.value = "";
      return;
    }

    const MAX_FILES = 5;
    const remainingSlots = Math.max(0, MAX_FILES - attachments.length);
    let filesToAdd: File[] = [];
    let extraFiles = 0;

    if (files.length > remainingSlots) {
      // Clip the selection before validation so the error/toast reflects what can actually fit.
      filesToAdd = files.slice(0, remainingSlots);
      extraFiles = files.length - filesToAdd.length;

      const sizeErr = validateAdd(attachments, filesToAdd);
      if (sizeErr) {
        toast({
          title: "Attachment too large",
          description: sizeErr,
          variant: "destructive",
          duration: 3000,
        });
        if (input) input.value = "";
        return;
      }

      setAttachments((prev) => [...prev, ...filesToAdd]);
      toast({
        title: "Some files not added",
        description: `Only ${filesToAdd.length} files added. Maximum ${MAX_FILES} files allowed per message (${extraFiles} excluded).`,
        variant: "destructive",
        duration: 3000,
      });
    } else {
      filesToAdd = files;

      // Even within the slot limit we still enforce the aggregate upload size guard.
      const sizeErr = validateAdd(attachments, filesToAdd);
      if (sizeErr) {
        toast({
          title: "Attachment too large",
          description: sizeErr,
          variant: "destructive",
          duration: 3000,
        });
        if (input) input.value = "";
        return;
      }

      setAttachments((prev) => [...prev, ...filesToAdd]);
    }

    if (input) input.value = "";
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    // Only handle paste if there are file items present.
    // Pasting plain text should not trigger file limit toasts.
    const fileItems: DataTransferItem[] = Array.from(items).filter((it) => it.kind === "file");
    if (fileItems.length === 0) return;

    const MAX_FILES = 5;
    const remainingSlots = Math.max(0, MAX_FILES - attachments.length);

    if (remainingSlots <= 0) {
      toast({
        title: "Maximum files reached",
        description: `You can only attach up to ${MAX_FILES} files per message`,
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    const filesToAdd: File[] = [];
    const excludedFiles: { file: File; reason: string }[] = [];
    let totalFilesFound = 0;

    for (let i = 0; i < fileItems.length; i++) {
      const item = fileItems[i];
      const file = item.getAsFile();
      if (file) {
        totalFilesFound++;
        // Preserve only the files that fit in the remaining local attachment slots.
        if (filesToAdd.length >= remainingSlots) {
          excludedFiles.push({ file, reason: "slot limit" });
        } else {
          filesToAdd.push(file);
        }
      }
    }

    if (totalFilesFound === 0) return;

    if (filesToAdd.length > 0) {
      // Paste can inject many screenshots at once, so reuse the same size validation as uploads.
      const sizeErr = validateAdd(attachments, filesToAdd);
      if (sizeErr) {
        toast({
          title: "Files too large",
          description: sizeErr,
          variant: "destructive",
          duration: 3000,
        });
        return;
      }
    }

    if (filesToAdd.length > 0) {
      setAttachments((prev) => [...prev, ...filesToAdd]);
    }

    if (filesToAdd.length > 0 && excludedFiles.length === 0) {
      toast({
        title: "Files attached",
        description: `${filesToAdd.length} pasted file(s) added`,
        duration: 2000,
      });
    } else if (filesToAdd.length > 0 && excludedFiles.length > 0) {
      toast({
        title: "Some files attached",
        description: `${filesToAdd.length} file(s) added, ${excludedFiles.length} excluded (${excludedFiles[0].reason === "slot limit" ? "file limit reached" : "size limit"})`,
        duration: 3000,
      });
    } else if (excludedFiles.length > 0) {
      toast({
        title: "Files not attached",
        description: `${excludedFiles.length} file(s) couldn't be added (${excludedFiles[0].reason === "slot limit" ? "file limit reached" : "size limit"})`,
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  const removeAttachment = (index: number) => {
    // Pending attachments have no stable ids yet, so index removal is the simplest local contract.
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileDownload = async (attachment: any, message: MessageOut) => {
    const { userId, currentConversation } = ctx;
    // Downloads only work for persisted blobs tied to a real conversation/message.
    if (!userId || !currentConversation) {
      toast({
        title: "Download unavailable",
        description: "You must be signed in to download attachments",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    if (!attachment?.blobId) {
      toast({
        title: "Download unavailable",
        description: "This attachment cannot be downloaded",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    try {
      // Give immediate feedback because the real file save begins after the API fetches the blob.
      toast({
        title: "Download starting",
        description: `Preparing ${attachment.name}`,
        duration: 2000,
      });
      await downloadAttachment({
        userId,
        conversationId: currentConversation.id,
        messageId: message.id,
        blobId: attachment.blobId,
        filename: attachment.name,
      });
    } catch (error) {
      toastError(toast, "Download failed", error, {
        description: "Unable to download the file. Please try again.",
        duration: 3000,
      });
    }
  };

  return {
    handleFileUpload,
    handlePaste,
    removeAttachment,
    isImageFile,
    getImageUrl,
    handleFileDownload,
  };
}
