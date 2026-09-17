import { useCallback, useState } from "react";

import type { AttachmentPreviewTarget } from "@/features/attachments/components/AttachmentPreviewPanel";

/**
 * The two attachment preview overlays: the full-bleed image lightbox and the
 * side panel used for everything else (PDF, DOCX, text).
 *
 * They are one hook because they are mutually exclusive in practice and are
 * dismissed by the same Escape/click-away cascade, which has to know about both
 * to decide which is topmost.
 */
export function useAttachmentPreview() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedFilePreview, setSelectedFilePreview] = useState<AttachmentPreviewTarget | null>(
    null,
  );

  const openFilePreview = useCallback(
    (
      attachment: AttachmentPreviewTarget["attachment"],
      message: AttachmentPreviewTarget["message"],
    ) => setSelectedFilePreview({ attachment, message }),
    [],
  );

  const closeFilePreview = useCallback(() => setSelectedFilePreview(null), []);

  return {
    selectedImage,
    selectedFilePreview,
    openFilePreview,
    closeFilePreview,
    /**
     * The image lightbox is opened and closed by `createUIHandlers`, which also
     * owns the copy-to-clipboard flash and therefore cannot move in here.
     */
    setSelectedImage,
  };
}
