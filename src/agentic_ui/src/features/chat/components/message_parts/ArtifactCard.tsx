import { Download, Eye, FileText, Loader2, Sparkles } from "lucide-react";
import type { ArtifactBlock, AttachmentOut, MessageOut } from "@/shared/lib/types";
import { classifyAttachmentPreview } from "@/features/attachments/components/attachment_preview_parts";
import { useIsMobile } from "@/shared/hooks/use-mobile";

type ArtifactCardProps = {
  block: ArtifactBlock;
  // The owning assistant message + attachment handlers, threaded from
  // ChatMessage. Absent in read-only contexts (e.g. a public share render),
  // where the card shows metadata without download/preview actions.
  message?: MessageOut;
  onDownload?: (attachment: AttachmentOut, message: MessageOut) => void;
  onPreview?: (attachment: AttachmentOut, message: MessageOut) => void;
};

// Renders a deliverable the agent presented via present_artifact, inline at its
// position in the run timeline. The downloadable bytes live on the message's
// matching generated attachment (persisted at run finalize); we reconcile to it
// by filename. Until it exists (mid-stream, before finalize), the card shows a
// "Preparing…" state instead of dead actions.
export function ArtifactCard({ block, message, onDownload, onPreview }: ArtifactCardProps) {
  const isMobile = useIsMobile();

  const attachment = message?.attachments?.find(
    (a) => a.origin === "generated" && a.name === block.filename
  ) as AttachmentOut | undefined;

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
  // Tapping the card is the fallback affordance (esp. mobile, where the hover
  // actions don't exist): preview on desktop when possible, else download.
  const activate = () => (canPreview ? preview() : download());

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
