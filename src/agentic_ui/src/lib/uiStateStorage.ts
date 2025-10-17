// Minimal IndexedDB-based persistence for large UI state (e.g., attachments)
// Stores a per-user snapshot plus blobs for pending attachments.

import type { ConversationDetail, MessageOut, ThinkingState } from '@/lib/types';

const DB_NAME = 'mx_ui_state';
const STATE_STORE = 'state';
const BLOB_STORE = 'attachments';
const DB_VERSION = 1;

type SerializableDate = string;

type AttachmentRef = { key: string; name: string; type: string; size?: number };

export type UISnapshotSerializable = {
  version: 1;
  // Chat-centric state
  selectedAgent: string;
  isPrivateMode: boolean;
  currentMessage: string;
  expandedThinking: Record<string, boolean>;
  thinkingState: ThinkingState | null;
  sidebarOpen: boolean;
  activeProfileTab: string;
  selectedImage: string | null;

  // Conversation + messages (dates as ISO strings)
  currentConversation: (Omit<ConversationDetail, 'created_at' | 'updated_at' | 'messages'> & {
    created_at: SerializableDate | null;
    updated_at: SerializableDate | null;
  }) | null;
  messages: (Omit<MessageOut, 'created_at' | 'updated_at'> & { created_at: SerializableDate; updated_at: SerializableDate })[];

  // Attachment references stored in IDB blob store
  attachmentsRefs: AttachmentRef[];
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const req = s.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store: string, key: IDBValidKey, value: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const req = s.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const req = s.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveUISnapshot(userId: string, data: UISnapshotSerializable, attachments: File[]): Promise<void> {
  // Clean up previous attachment blobs for this user if present
  const previous: UISnapshotSerializable | undefined = await idbGet(STATE_STORE, userId);
  if (previous?.attachmentsRefs) {
    await Promise.all(previous.attachmentsRefs.map(ref => idbDelete(BLOB_STORE, ref.key).catch(() => {})));
  }

  // Store attachments as blobs
  const now = Date.now();
  const attachmentsRefs: AttachmentRef[] = [];
  await Promise.all(
    attachments.map(async (file, idx) => {
      const key = `att:${userId}:${now}:${idx}:${file.name}`;
      await idbPut(BLOB_STORE, key, file);
      attachmentsRefs.push({ key, name: file.name, type: file.type, size: (file as any).size });
    })
  );

  // Save snapshot JSON
  const payload: UISnapshotSerializable = { ...data, attachmentsRefs, version: 1 } as any;
  await idbPut(STATE_STORE, userId, payload);
}

export async function loadUISnapshot(userId: string): Promise<{ snapshot: UISnapshotSerializable; attachments: File[] } | null> {
  const saved: UISnapshotSerializable | undefined = await idbGet(STATE_STORE, userId);
  if (!saved) return null;

  // Reconstruct Files from blobs
  const attachments: File[] = [];
  for (const ref of saved.attachmentsRefs || []) {
    try {
      const blob = await idbGet<Blob>(BLOB_STORE, ref.key);
      if (blob) attachments.push(new File([blob], ref.name, { type: ref.type }));
    } catch {
      // ignore missing blobs
    }
  }
  return { snapshot: saved, attachments };
}

// Helpers for converting Dates in messages/conversation when saving/restoring can be handled in caller.
