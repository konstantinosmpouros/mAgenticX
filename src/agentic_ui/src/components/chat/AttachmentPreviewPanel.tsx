import * as React from "react";
import { Download, FileType2, Loader2, X, XCircle } from "lucide-react";

import { getAttachmentPreviewUrl } from "@/lib/api";
import type { AttachmentOut, DownloadAttachmentParams, MessageOut } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

type PreviewKind = "pdf" | "unsupported";

type PreviewState =
  | { status: "idle"; kind: PreviewKind; name: string; mime: string; previewUrl?: string }
  | { status: "loading"; kind: PreviewKind; name: string; mime: string; previewUrl?: string }
  | { status: "error"; kind: PreviewKind; name: string; mime: string; error: string; previewUrl?: string }
  | { status: "ready"; kind: PreviewKind; name: string; mime: string; previewUrl?: string };

function extractAttachmentMeta(attachment: AttachmentLike) {
  if (typeof attachment === "string") {
    return {
      name: attachment,
      mime: "",
      blobId: undefined,
    };
  }

  if (attachment instanceof File) {
    return {
      name: attachment.name,
      mime: attachment.type ?? "",
      blobId: undefined,
    };
  }

  const candidate = attachment as {
    name?: string;
    file_name?: string;
    mime?: string;
    mime_type?: string;
    blobId?: string;
    blob_id?: string;
  };

  return {
    name: candidate.name ?? candidate.file_name ?? "Unknown file",
    mime: candidate.mime ?? candidate.mime_type ?? "",
    blobId: candidate.blobId ?? candidate.blob_id,
  };
}

function inferPreviewKind(name: string, mime: string): PreviewKind {
  const loweredName = name.toLowerCase();
  const loweredMime = mime.toLowerCase();
  return loweredMime === "application/pdf" || loweredName.endsWith(".pdf") ? "pdf" : "unsupported";
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
  const previewKind = React.useMemo(
    () => inferPreviewKind(meta?.name ?? "", meta?.mime ?? ""),
    [meta?.mime, meta?.name]
  );
  const [state, setState] = React.useState<PreviewState>({
    status: "idle",
    kind: "unsupported",
    name: "",
    mime: "",
  });
  const [iframeLoaded, setIframeLoaded] = React.useState(false);

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
      setState({
        status: "idle",
        kind: "unsupported",
        name: "",
        mime: "",
      });
      return;
    }

    const nextBase = {
      kind: previewKind,
      name: meta.name,
      mime: meta.mime,
    } as const;

    if (previewKind === "unsupported") {
      setState({
        status: "ready",
        ...nextBase,
      });
      return;
    }

    if (!userId || !conversationId || !meta.blobId) {
      setState({
        status: "error",
        ...nextBase,
        error: "Preview is unavailable for this attachment.",
      });
      return;
    }

    const previewUrl = getAttachmentPreviewUrl({
      userId,
      conversationId,
      messageId: preview.message.id,
      blobId: meta.blobId,
    });

    setState({
      status: "loading",
      ...nextBase,
      previewUrl,
    });

    const frameId = window.requestAnimationFrame(() => {
      setState({
        status: "ready",
        ...nextBase,
        previewUrl,
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [conversationId, meta, preview, previewKind, userId]);

  React.useEffect(() => {
    setIframeLoaded(false);
  }, [state.previewUrl]);

  if (!open) {
    return null;
  }

  const canRenderPdf = state.status !== "error" && state.kind === "pdf" && Boolean(state.previewUrl);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-3 backdrop-blur-sm sm:p-5"
      onClick={onClose}
    >
      <div
        className="flex h-[min(94vh,64rem)] w-[min(96vw,76rem)] flex-col overflow-hidden rounded-[1.85rem] border border-white/10 bg-[#252525] text-white shadow-[0_28px_100px_-32px_rgba(0,0,0,0.92)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-white sm:text-[1.2rem]">{meta?.name ?? "Preview"}</h2>
          </div>
          <button
            type="button"
            aria-label="Close preview"
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/8 hover:text-white"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 bg-[#1f1f1f] p-3 sm:p-4">
          {state.status === "error" ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-lg rounded-[1.5rem] border border-white/10 bg-[#262626] px-6 py-7 text-center shadow-sm">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                  <XCircle className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">Preview unavailable</h3>
                <p className="mt-2 text-sm text-white/60">{state.error}</p>
                {preview ? (
                  <Button
                    type="button"
                    className="mt-5 gap-2"
                    onClick={() => onDownload(preview.attachment, preview.message)}
                  >
                    <Download className="h-4 w-4" />
                    Download original file
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {canRenderPdf ? (
            <div className="relative h-full overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#2d2d2d]">
              {!iframeLoaded ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#222]/70 backdrop-blur-sm">
                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <span className="text-sm text-white">Opening PDF preview...</span>
                  </div>
                </div>
              ) : null}

              <iframe
                key={state.previewUrl}
                title={meta?.name ?? "PDF preview"}
                src={state.previewUrl}
                className={cn("h-full w-full border-0 bg-[#2d2d2d]", !iframeLoaded && "opacity-0")}
                onLoad={() => setIframeLoaded(true)}
              />
            </div>
          ) : null}

          {state.status === "ready" && state.kind === "unsupported" ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-lg rounded-[1.5rem] border border-white/10 bg-[#262626] px-6 py-7 text-center shadow-sm">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-white/75">
                  <FileType2 className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">Preview is available only for PDFs</h3>
                <p className="mt-2 text-sm text-white/60">
                  This file stays unchanged. Download it to open it in its native application.
                </p>
                {preview ? (
                  <Button
                    type="button"
                    className="mt-5 gap-2"
                    onClick={() => onDownload(preview.attachment, preview.message)}
                  >
                    <Download className="h-4 w-4" />
                    Download original file
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
