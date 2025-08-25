import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AttachmentIn, FileAttachment } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Convert File to base64 AttachmentIn format
export async function fileToAttachmentIn(file: File): Promise<AttachmentIn> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result as string;
      // Remove the data:mime;base64, prefix
      const dataB64 = base64String.split(',')[1];
      resolve({
        name: file.name,
        mime: file.type,
        dataB64,
        size: file.size
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Convert FileAttachment array to AttachmentIn array
export async function convertFileAttachments(fileAttachments: FileAttachment[]): Promise<AttachmentIn[]> {
  const attachmentPromises = fileAttachments.map(attachment => 
    fileToAttachmentIn(attachment.file)
  );
  return Promise.all(attachmentPromises);
}

