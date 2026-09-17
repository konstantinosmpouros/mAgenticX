// ------------------------------------------------------
// Attachment Schemas
// ------------------------------------------------------
// `DocxPreviewTokenResponse` is inferred from its Zod schema (see `../schemas`).
export type { DocxPreviewTokenResponse } from "../schemas";

// Backend attachment type from API response
export type AttachmentOut = {
  id: string;
  name: string;
  mime: string;
  size?: number;
  timestamp: Date;
  blobId?: string;
  data?: string; // Base64 encoded data for images and public share downloads
  // Provenance + agent-supplied display metadata. "upload" (default) for
  // user-attached files, "generated" for a deliverable the agent presented
  // via present_artifact; title/summary are populated for generated only.
  origin?: "upload" | "generated";
  title?: string;
  summary?: string;
};

// Attachment input for API requests (base64 format)
export type AttachmentIn = {
  name: string;
  mime: string;
  dataB64: string;
  size?: number;
};

// Parameters required to download an attachment from the backend
export type DownloadAttachmentParams = {
  userId: string;
  conversationId: string;
  messageId: string;
  blobId: string;
  filename?: string;
};

// File upload attachment type for UI
export type FileAttachment = {
  file: File;
  url: string;
  name: string;
  type: string;
};
