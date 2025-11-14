// Minimal IndexedDB-based persistence for large UI state (e.g., attachments)
// Stores a per-user snapshot plus blobs for pending attachments.

import { mapIcon } from '@/lib/consts';
import type { Agent, ConversationDetail, MessageOut, ThinkingState, ToolMetadata } from '@/lib/types';

const DB_NAME = 'mx_ui_state';
const STATE_STORE = 'state';
const BLOB_STORE = 'attachments';
const DB_VERSION = 1;

type SerializableDate = string;

type AttachmentRef = { key: string; name: string; type: string; size?: number };

type AgentSnapshot = {
  id: string;
  name: string;
  description: string;
  iconName?: string | null;
  version?: string;
  isActive: boolean;
};

type ConversationSnapshot = (Omit<ConversationDetail, 'created_at' | 'updated_at' | 'messages' | 'agent'> & {
  created_at: SerializableDate | null;
  updated_at: SerializableDate | null;
  agent: AgentSnapshot | null;
}) | null;

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
  availableTools?: ToolMetadata[];
  agents?: Agent[];

  // Conversation + messages (dates as ISO strings)
  currentConversation: (Omit<ConversationDetail, 'created_at' | 'updated_at' | 'messages'> & {
    created_at: SerializableDate | null;
    updated_at: SerializableDate | null;
  }) | null;
  messages: (Omit<MessageOut, 'created_at' | 'updated_at'> & { created_at: SerializableDate; updated_at: SerializableDate })[];

  // Attachment references stored in IDB blob store
  attachmentsRefs: AttachmentRef[];
};

type PersistedSnapshot = Omit<UISnapshotSerializable, 'currentConversation' | 'agents'> & {
  currentConversation: ConversationSnapshot;
  agents?: AgentSnapshot[];
};

const createFallbackAgent = (): Agent => ({
  id: "",
  name: "Unknown Agent",
  description: "",
  icon: mapIcon(null),
  iconName: null,
  isActive: true,
});

const serializeAgentForStorage = (agent?: Agent | null): AgentSnapshot | null => {
  if (!agent) return null;
  const iconName = agent.iconName ?? ((agent.icon as unknown as { name?: string })?.name ?? null);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    iconName,
    version: agent.version,
    isActive: agent.isActive,
  };
};

const deserializeAgentFromStorage = (agent?: AgentSnapshot | null): Agent => {
  if (!agent) {
    return createFallbackAgent();
  }
  return {
    ...agent,
    iconName: agent.iconName ?? null,
    icon: mapIcon(agent.iconName ?? undefined),
  };
};

const serializeConversationForStorage = (conversation: UISnapshotSerializable['currentConversation']): ConversationSnapshot => {
  if (!conversation) return null;
  const { agent, ...rest } = conversation;
  return {
    ...rest,
    agent: serializeAgentForStorage(agent),
  };
};

const deserializeConversationFromStorage = (conversation: ConversationSnapshot): UISnapshotSerializable['currentConversation'] => {
  if (!conversation) return null;
  const { agent, ...rest } = conversation;
  return {
    ...rest,
    agent: deserializeAgentFromStorage(agent),
  };
};

const serializeAgentsListForStorage = (agents?: Agent[] | null): AgentSnapshot[] | undefined => {
  if (!Array.isArray(agents) || agents.length === 0) return undefined;
  const serialized = agents
    .map((agent) => serializeAgentForStorage(agent))
    .filter((item): item is AgentSnapshot => Boolean(item));
  return serialized.length > 0 ? serialized : undefined;
};

const deserializeAgentsListFromStorage = (agents?: AgentSnapshot[] | null): Agent[] | undefined => {
  if (!Array.isArray(agents) || agents.length === 0) return undefined;
  return agents.map(deserializeAgentFromStorage);
};

const cloneSchema = (schema?: Record<string, any> | null): Record<string, any> => {
  if (!schema) return {};
  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, any>;
  } catch {
    return {};
  }
};

const serializeToolsForStorage = (tools?: ToolMetadata[]): ToolMetadata[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: cloneSchema(tool.inputSchema as Record<string, any> | undefined),
    outputSchema: tool.outputSchema ? cloneSchema(tool.outputSchema as Record<string, any> | undefined) : undefined,
  }));
};

const deserializeToolsFromStorage = (tools?: ToolMetadata[]): ToolMetadata[] => {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: cloneSchema(tool.inputSchema as Record<string, any> | undefined),
    outputSchema: tool.outputSchema ? cloneSchema(tool.outputSchema as Record<string, any> | undefined) : undefined,
  }));
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
  const previous: PersistedSnapshot | undefined = await idbGet(STATE_STORE, userId);
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

  const {
    currentConversation,
    attachmentsRefs: _ignoredRefs,
    availableTools: toolsSnapshot,
    agents: agentsSnapshot,
    ...rest
  } = data as UISnapshotSerializable & { attachmentsRefs: AttachmentRef[] };
  const payload: PersistedSnapshot = {
    ...(rest as Omit<UISnapshotSerializable, 'currentConversation' | 'attachmentsRefs' | 'availableTools' | 'agents'>),
    availableTools: serializeToolsForStorage(toolsSnapshot),
    agents: serializeAgentsListForStorage(agentsSnapshot),
    currentConversation: serializeConversationForStorage(currentConversation),
    attachmentsRefs,
    version: 1,
  };

  await idbPut(STATE_STORE, userId, payload);
}

export async function loadUISnapshot(userId: string): Promise<{ snapshot: UISnapshotSerializable; attachments: File[] } | null> {
  const saved: PersistedSnapshot | undefined = await idbGet(STATE_STORE, userId);
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

  const { currentConversation, availableTools: storedTools, agents: storedAgents, ...rest } = saved;
  const snapshot: UISnapshotSerializable = {
    ...(rest as Omit<UISnapshotSerializable, 'currentConversation' | 'availableTools' | 'agents'>),
    currentConversation: deserializeConversationFromStorage(currentConversation),
    availableTools: deserializeToolsFromStorage(storedTools),
    agents: deserializeAgentsListFromStorage(storedAgents),
  };

  return { snapshot, attachments };
}

// Helpers for converting Dates in messages/conversation when saving/restoring can be handled in caller.
