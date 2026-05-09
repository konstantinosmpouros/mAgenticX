import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AGUIEvent } from "@/lib/agui";
import type { AttachmentIn, AuthResponse, FileAttachment } from "./types";
import {
  DEFAULT_REALTIME_VOICE,
  DEFAULT_VOICE_MODE_LANGUAGE,
  REALTIME_VOICES,
  VOICE_MODE_LANGUAGES,
  withCredentials,
  type RealtimeVoice,
  type VoiceModeLanguage,
} from "./consts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function normalizeRealtimeVoice(value: unknown): RealtimeVoice {
  const voice = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REALTIME_VOICES.some((option) => option.id === voice)
    ? (voice as RealtimeVoice)
    : DEFAULT_REALTIME_VOICE;
}

export function normalizeVoiceModeLanguage(value: unknown): VoiceModeLanguage {
  const language = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VOICE_MODE_LANGUAGES.some((option) => option.id === language)
    ? (language as VoiceModeLanguage)
    : DEFAULT_VOICE_MODE_LANGUAGE;
}

const CSRF_COOKIE_CANDIDATES = ["__Host-mx_csrf", "mx_csrf"];

function getCookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function getCsrfToken(): string | null {
  for (const name of CSRF_COOKIE_CANDIDATES) {
    const value = getCookieValue(name);
    if (value) return value;
  }
  return null;
}

export function withSessionRequest(init: RequestInit = {}, opts: { csrf?: boolean } = {}): RequestInit {
  const headers = new Headers(init.headers ?? {});
  if (opts.csrf) {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  return withCredentials({
    ...init,
    headers,
  });
}

type AuthResponseUserRecord = {
  prefersAgenticChat?: unknown;
  prefers_agentic_chat?: unknown;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  lastLoginAt?: string | Date;
  [key: string]: unknown;
};

type AuthResponseRecord = {
  user?: AuthResponseUserRecord;
  [key: string]: unknown;
};

function isAuthResponseRecord(value: unknown): value is AuthResponseRecord {
  return typeof value === "object" && value !== null;
}

export function normalizeAuthResponse(data: unknown): AuthResponse {
  const normalized = isAuthResponseRecord(data) ? ({ ...data } as AuthResponseRecord) : data;
  if (isAuthResponseRecord(normalized) && normalized.user) {
    const { prefersAgenticChat: _prefersAgenticChat, prefers_agentic_chat: _ignored, ...rest } = normalized.user;
    normalized.user = {
      ...rest,
      createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
      updatedAt: rest.updatedAt ? new Date(rest.updatedAt) : new Date(),
      lastLoginAt: rest.lastLoginAt ? new Date(rest.lastLoginAt) : undefined,
    };
  }
  return normalized as AuthResponse;
}

const FALLBACK_MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/x-python",
  css: "text/css",
  sql: "application/sql",
  sh: "application/x-sh",
};

function resolveUploadMimeType(file: File): string {
  const browserMime = file.type?.trim();
  if (browserMime) return browserMime;

  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  if (extension && FALLBACK_MIME_BY_EXTENSION[extension]) {
    return FALLBACK_MIME_BY_EXTENSION[extension];
  }

  return "application/octet-stream";
}

// Convert File to base64 AttachmentIn format
async function fileToAttachmentIn(file: File): Promise<AttachmentIn> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result as string;
      // Remove the data:mime;base64, prefix
      const dataB64 = base64String.split(',')[1];
      resolve({
        name: file.name,
        mime: resolveUploadMimeType(file),
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
