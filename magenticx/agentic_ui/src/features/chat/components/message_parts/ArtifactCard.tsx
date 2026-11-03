import { useState } from "react";
import { Download, Eye, FileText, Loader2, Sparkles } from "lucide-react";
import type { ArtifactBlock, AttachmentOut, MessageOut } from "@/shared/lib/types";
import { classifyAttachmentPreview } from "@/features/attachments/components/attachment_preview_parts";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { useAttachmentObjectUrl } from "@/features/chat/hooks/useAttachmentObjectUrl";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";

type ArtifactCardProps = {
  block: ArtifactBlock;
  // The owning assistant message + attachment handlers, threaded from
  // ChatMessage. Absent in read-only contexts (e.g. a public share render),
  // where the card shows metadata without download/preview actions.
  message?: MessageOut;
  onDownload?: (attachment: AttachmentOut, message: MessageOut) => void;
  onPreview?: (attachment: AttachmentOut, message: MessageOut) => void;
  /** Fetches the bytes: an image is then shown in place of the card. */
  onLoad?: (attachment: AttachmentOut, message: MessageOut) => Promise<Blob>;
};

// Renders a deliverable the agent presented via present_artifact, inline at its
// position in the run timeline. The downloadable bytes live on the message's
// matching generated attachment (persisted at run finalize); we reconcile to it
// by filename. Until it exists (mid-stream, before finalize), the card shows a
// "Preparing…" state instead of dead actions.
export function ArtifactCard({ block, message, onDownload, onPreview, onLoad }: ArtifactCardProps) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);

  // Every file the agent wrote is stored now, so two can share a name (a/x.md,
  // b/x.md): prefer the one it presented.
  const named = (message?.attachments ?? []).filter(
    (a) => a.origin === "generated" && a.name === block.filename,
  ) as AttachmentOut[];
  const attachment = named.find((a) => a.presented) ?? named[0];

  const ready = Boolean(attachment?.blobId);
  const primary = block.title || block.filename;
  const secondary = block.summary || block.mime || "Document";
  const previewable = classifyAttachmentPreview({
    name: block.filename,
    mime: block.mime ?? "",
    size: attachment?.size,
  }).previewable;
  const canPreview = previewable && !isMobile && Boolean(onPreview);

  const download = () => {
    if (attachment && message) onDownload?.(attachment, message);
  };
  const preview = () => {
    if (attachment && message) onPreview?.(attachment, message);
  };
  // A presented image is shown as the image itself; until it loads (or if it
  // can't), the card below stands in.
  const mime = block.mime || attachment?.mime || "";
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(block.filename);
  const imageUrl = useAttachmentObjectUrl(
    isImage && ready && attachment && message && onLoad ? () => onLoad(attachment, message) : null,
    isImage && ready ? (attachment?.blobId ?? null) : null,
  );

  // Tapping the card is the fallback affordance (esp. mobile, where the hover
  // actions don't exist): preview on desktop when possible, else download.
  const activate = () => (canPreview ? preview() : download());

  if (imageUrl) {
    return (
      <>
        <figure className="w-fit max-w-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
          {/* The frame hugs the image, so the download sits on its own corner
            whatever its shape (a portrait photo is narrower than the column). */}
          <div className="group/artifact relative w-fit max-w-full">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label={`View ${primary} larger`}
              className="block cursor-zoom-in rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <img
                src={imageUrl}
                alt={block.summary || primary}
                className="block max-h-[28rem] w-auto max-w-full rounded-2xl border border-border/50 bg-muted/20 object-contain shadow-sm transition-transform duration-200 group-hover/artifact:scale-[1.01] sm:max-w-md"
              />
            </button>
            <button
              type="button"
              aria-label={`Download ${primary}`}
              onClick={download}
              className="absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-background/90 text-foreground opacity-0 shadow-sm backdrop-blur-sm transition hover:scale-105 hover:text-primary focus-visible:opacity-100 group-hover/artifact:opacity-100"
            >
              <Download size={14} />
            </button>
          </div>
          <figcaption className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Sparkles size={11} className="shrink-0 text-primary/70" aria-hidden="true" />
            <span className="truncate">{primary}</span>
          </figcaption>
        </figure>
        <ImageLightbox
          src={expanded ? imageUrl : null}
          filename={block.filename}
          alt={block.summary || primary}
          onClose={() => setExpanded(false)}
        />
      </>
    );
  }

  return (
    <div className="w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
      <div
        role={ready ? "button" : undefined}
        tabIndex={ready ? 0 : undefined}
        onClick={ready ? activate : undefined}
        onKeyDown={
          ready
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }
            : undefined
        }
        className={`group/artifact relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-muted/40 to-muted/5 p-3.5 transition-all duration-200 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
          ready ? "cursor-pointer" : ""
        }`}
      >
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary/70">
          <Sparkles size={11} aria-hidden="true" />
          <span>Generated document</span>
        </div>

        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm">
            <FileText size={18} />
          </div>
          <div className="min-w-0 flex-1 pr-1">
            <div className="truncate text-sm font-semibold text-foreground">{primary}</div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
              {secondary}
            </div>
            {!ready && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                <span>Preparing…</span>
              </div>
            )}
          </div>
        </div>

        {ready && attachment && message ? (
          <div className="pointer-events-none absolute right-2.5 top-2.5 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/artifact:pointer-events-auto group-hover/artifact:opacity-100 group-focus-within/artifact:pointer-events-auto group-focus-within/artifact:opacity-100">
            {canPreview ? (
              <button
                type="button"
                aria-label={`Preview ${primary}`}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-border/50 bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition hover:scale-105 hover:text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  preview();
                }}
              >
                <Eye size={14} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Download ${primary}`}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-border/50 bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition hover:scale-105 hover:text-primary"
              onClick={(e) => {
                e.stopPropagation();
                download();
              }}
            >
              <Download size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
