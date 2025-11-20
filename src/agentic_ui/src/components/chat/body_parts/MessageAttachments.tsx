import React from "react";
import { Download, FileText } from "lucide-react";
import { VscEye } from "react-icons/vsc";
import type { AttachmentIn, FileAttachment, MessageOut } from "@/lib/types";

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
  onImageClick: (imageUrl: string) => void;
};

type AttachmentItem = {
  attachment: AttachmentLike;
  isImage: boolean;
  imageUrl: string;
  fileName: string;
  typeLabel: string;
};

const normalizeAttachment = (
  attachment: AttachmentLike,
  isImageFile: (attachment: AttachmentLike) => boolean
): AttachmentItem => {
  const isImage = isImageFile(attachment);
  let imageUrl = "";
  let fileName = "";
  const isStructuredAttachment = typeof attachment === "object" && attachment !== null;

  if (typeof attachment === "string") {
    imageUrl = attachment;
    fileName = attachment;
  } else if (isStructuredAttachment && "data" in attachment && (attachment as any).data) {
    imageUrl = `data:${attachment.mime};base64,${attachment.data}`;
    fileName = (attachment as any).name;
  } else if (isStructuredAttachment && "url" in attachment && (attachment as any).url) {
    imageUrl = (attachment as any).url;
    fileName = (attachment as any).name;
  } else if (isStructuredAttachment && "file" in attachment && (attachment as any).file) {
    imageUrl = URL.createObjectURL((attachment as any).file);
    fileName = (attachment as any).name;
  } else {
    imageUrl = "";
    fileName =
      isStructuredAttachment && "name" in attachment ? (attachment as any).name : "Unknown file";
  }

  const typeLabel =
    isStructuredAttachment && "mime" in attachment && (attachment as any).mime
      ? (attachment as any).mime
      : isImage
        ? "Image"
        : "File";

  return { attachment, isImage, imageUrl, fileName, typeLabel };
};

export function MessageAttachments({
  message,
  isImageFile,
  onDownloadAttachment,
  onImageClick,
}: MessageAttachmentsProps) {
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
                    className="group relative cursor-pointer bg-muted/20 hover:bg-muted/30 border border-border/30 rounded-2xl px-3 py-3 transition-all duration-200 hover:shadow-md w-64 md:w-80"
                    onClick={() => onDownloadAttachment(fileItem.attachment, message)}
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
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      <div className="bg-primary/90 text-primary-foreground rounded-full p-2 shadow-lg">
                        <Download size={16} />
                      </div>
                    </div>
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
                      <VscEye size={16} className="text-white" />
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
