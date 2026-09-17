/**
 * Attachment blob API — download to disk, fetch for in-browser preview, and
 * mint the short-lived DOCX preview token.
 */
import type { DocxPreviewTokenResponse, DownloadAttachmentParams } from "../types";
import { requestBlob, requestJson } from "../http";
import { triggerBrowserDownload } from "../download";
import { DocxPreviewTokenSchema } from "../schemas";
import { ATTACHMENTS_BASE_PATH } from "./paths";

// Download an attachment blob
export async function downloadAttachment({
  userId,
  conversationId,
  messageId,
  blobId,
  filename,
}: DownloadAttachmentParams): Promise<void> {
  const blob = await fetchAttachmentBlob({
    userId,
    conversationId,
    messageId,
    blobId,
  });
  triggerBrowserDownload(blob, filename);
}

// Fetch for preview an attachment blob from the backend
export async function fetchAttachmentBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  const url = `${ATTACHMENTS_BASE_PATH}/download/${userId}/${conversationId}/${messageId}/${blobId}`;
  return requestBlob(url, {
    accept: null,
    fallbackMessage: "Failed to download attachment",
  });
}

export function getAttachmentPreviewUrl({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): string {
  const segments = [userId, conversationId, messageId, blobId].map((value) =>
    encodeURIComponent(value),
  );
  return `${ATTACHMENTS_BASE_PATH}/preview/${segments.join("/")}`;
}

// Fetch a blob through the inline preview endpoint for in-browser renderers.
export async function fetchAttachmentPreviewBlob({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<Blob> {
  return requestBlob(getAttachmentPreviewUrl({ userId, conversationId, messageId, blobId }), {
    accept: null,
    fallbackMessage: "Failed to preview attachment",
  });
}

export async function fetchDocxPreviewToken({
  userId,
  conversationId,
  messageId,
  blobId,
}: Omit<DownloadAttachmentParams, "filename">): Promise<DocxPreviewTokenResponse> {
  const segments = [userId, conversationId, messageId, blobId].map(encodeURIComponent);
  return requestJson(`${ATTACHMENTS_BASE_PATH}/preview-token/${segments.join("/")}`, {
    schema: DocxPreviewTokenSchema,
    fallbackMessage: "Failed to obtain preview token",
  });
}
