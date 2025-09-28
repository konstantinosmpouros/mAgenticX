import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AttachmentIn, FileAttachment, } from "./types";

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

// Sort helpers
type WithUpdatedAt = { updated_at: string | Date };

export function sortByUpdatedAtDesc<T extends WithUpdatedAt>(items: T[]): T[] {
  // Defensive copy + robust parsing for string or Date
  return [...items].sort((a, b) => {
    const ta = typeof a.updated_at === 'string' ? new Date(a.updated_at).getTime() : a.updated_at.getTime();
    const tb = typeof b.updated_at === 'string' ? new Date(b.updated_at).getTime() : b.updated_at.getTime();
    return tb - ta; // newest first
  });
}

// Utility to parse SSE text incrementally and emit events ASAP.
export function parseSSE(buffer: string, onEvent: (e: AGUIEvent) => void): string {
  // Find the last newline to ensure we only process complete lines
  const lastNewline = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
  if (lastNewline === -1) return buffer; // no complete lines yet

  const chunk = buffer.slice(0, lastNewline + 1);
  const rest = buffer.slice(lastNewline + 1);

  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === 'object' && obj.type) onEvent(obj as AGUIEvent);
    } catch {
      // ignore non-JSON frames
    }
  }
  return rest;
}
