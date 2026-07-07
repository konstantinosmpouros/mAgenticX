import { Download, Eye, FileText } from "lucide-react";
import type { AttachmentIn, FileAttachment, MessageOut } from "@/shared/lib/types";
import { classifyAttachmentPreview } from "@/components/chat/attachment_preview_parts";
import { useIsMobile } from "@/shared/hooks/use-mobile";

export type AttachmentLike =
  | AttachmentIn
  | FileAttachment
  | File
  | string
  | Record<string, unknown>;

type MessageAttachmentsProps = {
  message: MessageOut;
  isImageFile: (attachment: AttachmentLike) => boolean;
  onDownloadAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onPreviewAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onImageClick: (imageUrl: string) => void;
};

type AttachmentItem = {
  attachment: AttachmentLike;
  isImage: boolean;
  imageUrl: string;
  fileName: string;
  typeLabel: string;
  isPreviewable: boolean;
};

type AttachmentRecord = {
  data?: string;
  file?: File;
  file_name?: string;
  mime?: string;
  mime_type?: string;
  name?: string;
  size?: number;
  size_bytes?: number;
  url?: string;
};

const asAttachmentRecord = (attachment: AttachmentLike): AttachmentRecord =>
  typeof attachment === "object" && attachment !== null ? (attachment as AttachmentRecord) : {};

const normalizeAttachment = (
  attachment: AttachmentLike,
  isImageFile: (attachment: AttachmentLike) => boolean
): AttachmentItem => {
  const isImage = isImageFile(attachment);
  let imageUrl = "";
  let fileName = "";
  const isStructuredAttachment = typeof attachment === "object" && attachment !== null;
  const record = asAttachmentRecord(attachment);

  if (typeof attachment === "string") {
    imageUrl = attachment;
    fileName = attachment;
  } else if (attachment instanceof File) {
    imageUrl = URL.createObjectURL(attachment);
    fileName = attachment.name;
  } else if (record.data) {
    imageUrl = `data:${record.mime};base64,${record.data}`;
    fileName = record.name ?? record.file_name ?? "Unknown file";
  } else if (record.url) {
    imageUrl = record.url;
    fileName = record.name ?? record.file_name ?? "Unknown file";
  } else if (record.file) {
    imageUrl = URL.createObjectURL(record.file);
    fileName = record.name ?? record.file.name;
  } else {
    imageUrl = "";
    fileName =
      isStructuredAttachment && record.name ? record.name : record.file_name ?? "Unknown file";
  }

  const mimeValue: string =
    attachment instanceof File ? attachment.type : (isStructuredAttachment && (record.mime || record.mime_type)) || "";

  const typeLabel = mimeValue || (isImage ? "Image" : "File");

  const sizeValue =
    attachment instanceof File
      ? attachment.size
      : isStructuredAttachment && typeof record.size === "number"
      ? record.size
      : isStructuredAttachment && typeof record.size_bytes === "number"
        ? record.size_bytes
        : undefined;
  const isPreviewable = classifyAttachmentPreview({
    name: fileName,
    mime: mimeValue,
    size: sizeValue,
  }).previewable;

  return { attachment, isImage, imageUrl, fileName, typeLabel, isPreviewable };
};

export function MessageAttachments({
  message,
  isImageFile,
  onDownloadAttachment,
  onPreviewAttachment,
  onImageClick,
}: MessageAttachmentsProps) {
  const isMobile = useIsMobile();

  if (!message.attachments?.length) {
    return null;
  }

  const items = message.attachments.map((attachment) =>
    normalizeAttachment(attachment as AttachmentLike, isImageFile)
  );
  const images = items.filter((item) => item.isImage);
  const files = items.filter((item) => !item.isImage);

  return (
    <div className={`${message.sender === "user" ? "flex justify-end" : ""}`}>
      <div className="max-w-[85%] md:max-w-[85%]">
        <div className="flex flex-col items-end space-y-3">
          {files.length > 0 && (
            <div className="flex flex-col gap-2 w-fit self-end">
              {files.map((fileItem, index) => (
                <div key={`file-${index}`} className="text-xs self-end">
                  <div
                    role="button"
                    tabIndex={0}
                    className="group relative cursor-pointer bg-muted/20 hover:bg-muted/30 border border-border/30 rounded-2xl px-3 py-3 transition-all duration-200 hover:shadow-md w-64 md:w-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    onClick={() =>
                      !isMobile && fileItem.isPreviewable
                        ? onPreviewAttachment(fileItem.attachment, message)
                        : onDownloadAttachment(fileItem.attachment, message)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (!isMobile && fileItem.isPreviewable) {
                          onPreviewAttachment(fileItem.attachment, message);
                        } else {
                          onDownloadAttachment(fileItem.attachment, message);
                        }
                      }
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-primary/90 text-primary-foreground flex items-center justify-center">
                        <FileText size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground/90 truncate w-full">
                          {fileItem.fileName}
                        </div>
                        <div className="text-muted-foreground/70 truncate w-full">
                          {fileItem.typeLabel}
                        </div>
                      </div>
                    </div>
                    {!isMobile && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                        {fileItem.isPreviewable ? (
                          <button
                            type="button"
                            aria-label={`Preview ${fileItem.fileName}`}
                            className="rounded-full border border-border/50 bg-background/95 p-2 text-primary shadow-md transition-all hover:scale-105 hover:bg-background"
                            onClick={(event) => {
                              event.stopPropagation();
                              onPreviewAttachment(fileItem.attachment, message);
                            }}
                          >
                            <Eye size={16} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Download ${fileItem.fileName}`}
                          className="rounded-full border border-border/50 bg-background/95 p-2 text-foreground shadow-md transition-all hover:scale-105 hover:bg-background"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDownloadAttachment(fileItem.attachment, message);
                          }}
                        >
                          <Download size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-3 self-end">
              {images.map((img, idx) => (
                <div
                  key={`img-${idx}`}
                  className={`${images.length % 2 === 1 && idx === images.length - 1 ? "col-span-2" : ""}`}
                >
                  <div className="relative group cursor-pointer" onClick={() => onImageClick(img.imageUrl)}>
                    <img
                      src={img.imageUrl}
                      alt="Image"
                      className="w-full h-28 md:h-32 object-cover rounded-xl border border-0 transition-all hover:scale-[1.02] hover:shadow-lg"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
                      <Eye size={16} className="text-white" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
