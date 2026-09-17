export type AttachmentPreviewKind =
  "pdf" | "docx" | "xlsx" | "pptx" | "markdown" | "json" | "csv" | "code" | "text" | "unsupported";

export type AttachmentPreviewMeta = {
  name: string;
  mime: string;
  size?: number;
  blobId?: string;
  file?: File;
};

export type AttachmentPreviewDescriptor = {
  kind: AttachmentPreviewKind;
  previewable: boolean;
  label: string;
  language?: string;
  reason?: string;
  requiresBlob: boolean;
};

export const TEXT_PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024;
export const OFFICE_PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;

const extensionOf = (name: string) => {
  const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
  return match ? match[1] : "";
};

const codeLanguages: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dockerfile: "dockerfile",
  go: "go",
  h: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const textExtensions = new Set(["log", "text", "txt"]);
const markdownExtensions = new Set(["markdown", "md", "mdx"]);

function tooLarge(
  meta: AttachmentPreviewMeta,
  limit: number,
  label: string,
): AttachmentPreviewDescriptor | null {
  if (typeof meta.size !== "number" || meta.size <= limit) {
    return null;
  }

  return {
    kind: "unsupported",
    previewable: false,
    label,
    reason: `Preview is disabled for files larger than ${Math.round(limit / 1024 / 1024)} MB.`,
    requiresBlob: false,
  };
}

export function classifyAttachmentPreview(
  meta: AttachmentPreviewMeta,
): AttachmentPreviewDescriptor {
  const mime = meta.mime.trim().toLowerCase();
  const ext = extensionOf(meta.name);

  if (mime.startsWith("image/")) {
    return {
      kind: "unsupported",
      previewable: false,
      label: "Image",
      reason: "Images use the chat image viewer.",
      requiresBlob: false,
    };
  }

  if (mime === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", previewable: true, label: "PDF", requiresBlob: false };
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return (
      tooLarge(meta, OFFICE_PREVIEW_LIMIT_BYTES, "Word document") ?? {
        kind: "docx",
        previewable: true,
        label: "Word document",
        requiresBlob: false,
      }
    );
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    ext === "xlsx" ||
    ext === "xlsm"
  ) {
    return (
      tooLarge(meta, OFFICE_PREVIEW_LIMIT_BYTES, "Excel workbook") ?? {
        kind: "xlsx",
        previewable: true,
        label: "Excel workbook",
        requiresBlob: false,
      }
    );
  }

  if (
    mime === "application/vnd.ms-powerpoint" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    ext === "ppt" ||
    ext === "pptx"
  ) {
    return (
      tooLarge(meta, OFFICE_PREVIEW_LIMIT_BYTES, "PowerPoint deck") ?? {
        kind: "pptx",
        previewable: true,
        label: "PowerPoint deck",
        requiresBlob: false,
      }
    );
  }

  if (["doc", "xls"].includes(ext)) {
    return {
      kind: "unsupported",
      previewable: false,
      label: "Legacy Office file",
      reason: "This legacy Office format cannot be previewed reliably in the browser.",
      requiresBlob: false,
    };
  }

  if (mime === "text/csv" || ext === "csv") {
    return (
      tooLarge(meta, TEXT_PREVIEW_LIMIT_BYTES, "CSV") ?? {
        kind: "csv",
        previewable: true,
        label: "CSV",
        requiresBlob: true,
      }
    );
  }

  if (mime === "application/json" || ext === "json") {
    return (
      tooLarge(meta, TEXT_PREVIEW_LIMIT_BYTES, "JSON") ?? {
        kind: "json",
        previewable: true,
        label: "JSON",
        language: "json",
        requiresBlob: true,
      }
    );
  }

  if (markdownExtensions.has(ext) || mime === "text/markdown") {
    return (
      tooLarge(meta, TEXT_PREVIEW_LIMIT_BYTES, "Markdown") ?? {
        kind: "markdown",
        previewable: true,
        label: "Markdown",
        language: "markdown",
        requiresBlob: true,
      }
    );
  }

  if (codeLanguages[ext]) {
    return (
      tooLarge(meta, TEXT_PREVIEW_LIMIT_BYTES, "Code") ?? {
        kind: "code",
        previewable: true,
        label: "Code",
        language: codeLanguages[ext],
        requiresBlob: true,
      }
    );
  }

  if (mime.startsWith("text/") || textExtensions.has(ext)) {
    return (
      tooLarge(meta, TEXT_PREVIEW_LIMIT_BYTES, "Text") ?? {
        kind: "text",
        previewable: true,
        label: "Text",
        requiresBlob: true,
      }
    );
  }

  return {
    kind: "unsupported",
    previewable: false,
    label: "File",
    reason: "Preview is not available for this file type.",
    requiresBlob: false,
  };
}

export function isAttachmentPreviewable(meta: AttachmentPreviewMeta): boolean {
  return classifyAttachmentPreview(meta).previewable;
}

export function formatBytes(size?: number) {
  if (typeof size !== "number" || Number.isNaN(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
