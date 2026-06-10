import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AttachmentIn, AuthResponse, FileAttachment, SkillTreeNode } from "./types";
import {
  DEFAULT_REALTIME_VOICE,
  DEFAULT_VOICE_MODE_LANGUAGE,
  NA,
  REALTIME_VOICES,
  VOICE_MODE_LANGUAGES,
  withCredentials,
  type RealtimeVoice,
  type VoiceModeLanguage,
} from "./consts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Build a nested folder tree from a flat list of "/"-separated skill file
// paths. Folders are inferred from path segments. Sort order: folders before
// files, "SKILL.md" pinned first among files, then alphabetical — the same
// ordering the builder and the read-only viewer both want.
export function buildSkillFileTree(paths: string[], folderPaths: string[] = []): SkillTreeNode[] {
  const root: SkillTreeNode = { name: "", path: "", isDir: true, children: [] };
  const addPath = (raw: string, asDir: boolean) => {
    const parts = raw.split("/").filter(Boolean);
    let cursor = root;
    parts.forEach((segment, index) => {
      const isLast = index === parts.length - 1;
      const fullPath = parts.slice(0, index + 1).join("/");
      const dir = !isLast || asDir;
      let child = cursor.children.find((node) => node.name === segment);
      if (!child) {
        child = { name: segment, path: fullPath, isDir: dir, children: [] };
        cursor.children.push(child);
      } else if (dir) {
        child.isDir = true;
      }
      cursor = child;
    });
  };
  // Seed explicit (possibly empty) folders first, then files — so a folder the
  // user created with no files yet still shows up as a drop target.
  for (const folder of folderPaths) addPath(folder, true);
  for (const raw of paths) addPath(raw, false);
  sortSkillTree(root);
  return root.children;
}

function sortSkillTree(node: SkillTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.name === "SKILL.md") return -1;
    if (b.name === "SKILL.md") return 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortSkillTree);
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

// Profile panel display formatters — pure, fall back to the NA sentinel.
export const safeText = (value?: string | null) =>
  value && String(value).trim().length > 0 ? String(value).trim() : NA;

export const fmtDateTime = (value?: Date | string | null) => {
  if (!value) return NA;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? NA : date.toLocaleString();
};

export const fmtDate = (value?: Date | string | null) => {
  if (!value) return NA;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? NA : date.toLocaleDateString();
};

export const fmtBoolean = (value?: boolean) => {
  if (typeof value !== "boolean") return NA;
  return value ? "Enabled" : "Disabled";
};

// Skill search is intentionally simple: tokenize on whitespace, normalize away
// separators (-, _, ., /) so "gws admin" matches "gws-admin-reports", and
// require every token to appear somewhere in name/description/category.
export const tokenizeSkillQuery = (query: string): string[] =>
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((tok) => tok.replace(/[-_./]/g, ""))
    .filter(Boolean);

export const skillMatchesTokens = (
  s: { name: string; description: string; category: string },
  tokens: string[],
): boolean => {
  if (tokens.length === 0) return true;
  const haystack = `${s.name} ${s.description} ${s.category}`
    .toLowerCase()
    .replace(/[-_./]/g, "");
  return tokens.every((tok) => haystack.includes(tok));
};
