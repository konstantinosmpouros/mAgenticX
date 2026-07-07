import * as React from "react";
import { Download, X } from "lucide-react";

import {
  fetchAttachmentPreviewBlob,
  fetchDocxPreviewToken,
} from "@/shared/lib/api";
import type { AttachmentOut, MessageOut } from "@/shared/lib/types";
import { Button } from "@/shared/ui/button";
import {
  classifyAttachmentPreview,
  CodeTextPreview,
  CsvPreview,
  DocxPreview,
  formatBytes,
  JsonPreview,
  MarkdownPreview,
  PdfPreview,
  PreviewLoading,
  PreviewMessage,
  type AttachmentPreviewDescriptor,
  type AttachmentPreviewMeta,
} from "@/features/attachments/components/attachment_preview_parts";

type AttachmentLike = AttachmentOut | Record<string, unknown> | File | string;

export type AttachmentPreviewTarget = {
  attachment: AttachmentLike;
  message: MessageOut;
};

type AttachmentPreviewPanelProps = {
  preview: AttachmentPreviewTarget | null;
  userId?: string | null;
  conversationId?: string | null;
  onClose: () => void;
  onDownload: (attachment: AttachmentLike, message: MessageOut) => void;
};

type PreviewState =
  | { status: "idle"; meta: AttachmentPreviewMeta; descriptor: AttachmentPreviewDescriptor }
  | { status: "loading"; meta: AttachmentPreviewMeta; descriptor: AttachmentPreviewDescriptor; previewUrl?: string }
  | { status: "error"; meta: AttachmentPreviewMeta; descriptor: AttachmentPreviewDescriptor; error: string }
  | {
      status: "ready";
      meta: AttachmentPreviewMeta;
      descriptor: AttachmentPreviewDescriptor;
      previewUrl?: string;
      blob?: Blob;
      text?: string;
    };

function extractAttachmentMeta(attachment: AttachmentLike): AttachmentPreviewMeta {
  if (typeof attachment === "string") {
    return { name: attachment, mime: "" };
  }

  if (attachment instanceof File) {
    return {
      name: attachment.name,
      mime: attachment.type ?? "",
      size: attachment.size,
      file: attachment,
    };
  }

  const candidate = attachment as {
    name?: string;
    file_name?: string;
    mime?: string;
    mime_type?: string;
    blobId?: string;
    blob_id?: string;
    size?: number;
    size_bytes?: number;
    file?: File;
  };

  return {
    name: candidate.name ?? candidate.file_name ?? candidate.file?.name ?? "Unknown file",
    mime: candidate.mime ?? candidate.mime_type ?? candidate.file?.type ?? "",
    blobId: candidate.blobId ?? candidate.blob_id,
    size: candidate.size ?? candidate.size_bytes ?? candidate.file?.size,
    file: candidate.file,
  };
}

function shouldReadText(descriptor: AttachmentPreviewDescriptor) {
  return ["markdown", "json", "csv", "code", "text"].includes(descriptor.kind);
}

function renderReadyState(state: Extract<PreviewState, { status: "ready" }>) {
  const { descriptor, meta, previewUrl, blob, text } = state;

  if (!descriptor.previewable) {
    return null;
  }

  if (descriptor.kind === "pdf" && previewUrl) {
    return <PdfPreview name={meta.name} url={previewUrl} />;
  }

  if (
    (descriptor.kind === "docx" || descriptor.kind === "xlsx" || descriptor.kind === "pptx") &&
    previewUrl
  ) {
    return <DocxPreview name={meta.name} viewerUrl={previewUrl} />;
  }

  if (descriptor.kind === "markdown" && text != null) {
    return <MarkdownPreview content={text} />;
  }

  if (descriptor.kind === "json" && text != null) {
    return <JsonPreview content={text} />;
  }

  if (descriptor.kind === "csv" && text != null) {
    return <CsvPreview content={text} />;
  }

  if ((descriptor.kind === "code" || descriptor.kind === "text") && text != null) {
    return <CodeTextPreview content={text} language={descriptor.language} />;
  }

  return null;
}

export default function AttachmentPreviewPanel({
  preview,
  userId,
  conversationId,
  onClose,
  onDownload,
}: AttachmentPreviewPanelProps) {
  const open = Boolean(preview);
  const meta = React.useMemo(
    () => (preview ? extractAttachmentMeta(preview.attachment) : null),
    [preview]
  );
  const descriptor = React.useMemo(
    () => classifyAttachmentPreview(meta ?? { name: "", mime: "" }),
    [meta]
  );
  const [state, setState] = React.useState<PreviewState>({
    status: "idle",
    meta: { name: "", mime: "" },
    descriptor,
  });

  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!preview || !meta) {
      setState({ status: "idle", meta: { name: "", mime: "" }, descriptor });
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;

    const loadPreview = async () => {
      if (!descriptor.previewable) {
        setState({ status: "ready", meta, descriptor });
        return;
      }

      if (descriptor.kind === "pdf") {
        if (meta.file) {
          objectUrl = URL.createObjectURL(meta.file);
          setState({ status: "ready", meta, descriptor, previewUrl: objectUrl });
          return;
        }

        if (!userId || !conversationId || !meta.blobId) {
          setState({
            status: "error",
            meta,
            descriptor,
            error: "Preview is unavailable for this attachment.",
          });
          return;
        }

        setState({ status: "loading", meta, descriptor });
        try {
          const pdfBytes = await fetchAttachmentPreviewBlob({
            userId,
            conversationId,
            messageId: preview.message.id,
            blobId: meta.blobId,
          });
          if (cancelled) return;
          // Force the object-URL MIME to application/pdf so the iframe always
          // renders through the browser's PDF viewer and can never execute a
          // blob whose stored bytes are HTML/SVG — a same-origin stored-XSS guard.
          objectUrl = URL.createObjectURL(new Blob([pdfBytes], { type: "application/pdf" }));
          setState({ status: "ready", meta, descriptor, previewUrl: objectUrl });
        } catch (error) {
          if (!cancelled) {
            setState({
              status: "error",
              meta,
              descriptor,
              error: error instanceof Error ? error.message : "Preview failed.",
            });
          }
        }
        return;
      }

      if (
        descriptor.kind === "docx" ||
        descriptor.kind === "xlsx" ||
        descriptor.kind === "pptx"
      ) {
        if (meta.file) {
          setState({
            status: "error",
            meta,
            descriptor,
            error: `${descriptor.label} preview is unavailable for local files until they are uploaded.`,
          });
          return;
        }

        if (!userId || !conversationId || !meta.blobId) {
          setState({ status: "error", meta, descriptor, error: "Preview is unavailable for this attachment." });
          return;
        }

        setState({ status: "loading", meta, descriptor });
        try {
          const { token } = await fetchDocxPreviewToken({
            userId,
            conversationId,
            messageId: preview.message.id,
            blobId: meta.blobId,
          });
          const publicDocUrl = `${window.location.origin}/api/v1/attachments/public/${token}`;
          const viewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicDocUrl)}`;
          if (!cancelled) {
            setState({ status: "ready", meta, descriptor, previewUrl: viewerUrl });
          }
        } catch (error) {
          if (!cancelled) {
            setState({
              status: "error",
              meta,
              descriptor,
              error: error instanceof Error ? error.message : "Preview failed.",
            });
          }
        }
        return;
      }

      setState({ status: "loading", meta, descriptor });

      try {
        if (!meta.file && (!userId || !conversationId || !meta.blobId)) {
          throw new Error("Preview is unavailable for this attachment.");
        }
        const blob = meta.file ?? await fetchAttachmentPreviewBlob({
          userId: userId as string,
          conversationId: conversationId as string,
          messageId: preview.message.id,
          blobId: meta.blobId as string,
        });
        const text = shouldReadText(descriptor) ? await blob.text() : undefined;
        if (!cancelled) {
          setState({ status: "ready", meta, descriptor, blob, text });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            meta,
            descriptor,
            error: error instanceof Error ? error.message : "Preview failed.",
          });
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, descriptor, meta, preview, userId]);

  if (!open || !preview || !meta) {
    return null;
  }

  const handleDownload = () => onDownload(preview.attachment, preview.message);
  const readyContent = state.status === "ready" ? renderReadyState(state) : null;
  const subtitle = [descriptor.label, meta.mime, formatBytes(meta.size)].filter(Boolean).join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-3 backdrop-blur-sm sm:p-5 animate-in fade-in-0 duration-200"
      onClick={onClose}
    >
      <div
        className="flex h-[min(94vh,64rem)] w-[min(96vw,76rem)] flex-col overflow-hidden rounded-[1.85rem] border border-white/10 bg-[#252525] text-white shadow-[0_28px_100px_-32px_rgba(0,0,0,0.92)] animate-in fade-in-0 zoom-in-95 duration-200 ease-out"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-white sm:text-[1.2rem]">{meta.name}</h2>
            {subtitle ? <p className="mt-1 truncate text-xs text-white/45">{subtitle}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-9 gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-white/70 hover:bg-white/[0.08] hover:text-white"
              onClick={handleDownload}
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
            <button
              type="button"
              aria-label="Close preview"
              className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/8 hover:text-white"
              onClick={onClose}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-[#1f1f1f] p-3 sm:p-4">
          {state.status === "loading" ? <PreviewLoading /> : null}

          {state.status === "error" ? (
            <PreviewMessage
              title="Preview unavailable"
              description={state.error}
              tone="error"
              onDownload={handleDownload}
            />
          ) : null}

          {state.status === "ready" && !descriptor.previewable ? (
            <PreviewMessage
              title="Preview unavailable"
              description={descriptor.reason ?? "Download this file to open it in its native application."}
              onDownload={handleDownload}
            />
          ) : null}

          {state.status === "ready" && descriptor.previewable && !readyContent ? (
            <PreviewMessage
              title="Preview unavailable"
              description="This file could not be rendered in the browser."
              tone="error"
              onDownload={handleDownload}
            />
          ) : null}

          {readyContent}
        </div>
      </div>
    </div>
  );
}
