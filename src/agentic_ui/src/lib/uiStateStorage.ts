// IndexedDB-backed persistence for lightweight UI state (agents/tools/preferences lists).
// Only metadata and IDs are stored; conversations are rehydrated from the backend on refresh.

import { z } from 'zod';

import { mapIcon } from '@/lib/consts';
import type { Agent, ConversationSummary, Skill, ToolMetadata, UserPreferences, UserSkill } from '@/lib/types';


const DB_NAME = 'mx_ui_state';
const STATE_STORE = 'state';
const DB_VERSION = 2;


type AgentSnapshot = {
  id: string;
  name: string;
  description: string;
  iconName?: string | null;
  version?: string;
  type?: string;
  isActive: boolean;
};


type ConversationSummarySnapshot = Omit<ConversationSummary, 'agent'> & {
  agent: AgentSnapshot;
};


// v4 adds the per-user skill pool snapshot alongside availableSkills (the
// global catalog). Both are paint accelerators on refresh; the always-fetch
// path in useAuthRehydrateEffect overwrites both with fresh server responses.
export type UISnapshotSerializable = {
  version: 4;
  selectedAgent: string;
  isPrivateMode: boolean;
  activeProfileTab: string;
  sidebarOpen: boolean;
  lastConversationId: string | null;
  availableTools?: ToolMetadata[];
  availableSkills?: Skill[];
  myRegistrySkills?: UserSkill[];
  agents?: Agent[];
  conversations?: ConversationSummary[];
  userPreferences?: UserPreferences | null;
  selectedImage?: string | null;
};


type PersistedSnapshot = Omit<
  UISnapshotSerializable,
  'agents' | 'conversations' | 'userPreferences' | 'availableSkills' | 'myRegistrySkills'
> & {
  agents?: AgentSnapshot[];
  conversations?: ConversationSummarySnapshot[];
  userPreferences?: UserPreferences | null;
  availableSkills?: Skill[];
  myRegistrySkills?: UserSkill[];
};


// IndexedDB is attacker-writable under an XSS scenario, so a persisted snapshot
// is untrusted input. Before any of it is spread into app state we validate the
// top-level shape and reject prototype-pollution keys; on any failure the whole
// snapshot is discarded (the bootstrap fetch repopulates from the backend)
// rather than partially applied. Nested collections are validated as arrays of
// plain objects only — the per-item deserializers below reconstruct fields
// defensively, and `types.ts` stays the single source of truth for their shape.
const FORBIDDEN_SNAPSHOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value !== null && typeof value === 'object') {
    const keys = Object.getOwnPropertyNames(value);
    if (keys.some((key) => FORBIDDEN_SNAPSHOT_KEYS.has(key))) return true;
    return keys.some((key) => hasForbiddenKey((value as Record<string, unknown>)[key]));
  }
  return false;
}

const looseObject = z.object({}).passthrough();

const snapshotSchema = z
  .object({
    version: z.literal(4),
    selectedAgent: z.string(),
    isPrivateMode: z.boolean(),
    activeProfileTab: z.string(),
    sidebarOpen: z.boolean(),
    lastConversationId: z.string().nullable(),
    availableTools: z.array(looseObject).optional(),
    availableSkills: z.array(looseObject).optional(),
    myRegistrySkills: z.array(looseObject).optional(),
    agents: z.array(looseObject).optional(),
    conversations: z.array(looseObject).optional(),
    userPreferences: looseObject.nullable().optional(),
    selectedImage: z.string().nullable().optional(),
  })
  .strict();


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
    type: agent.type,
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


const serializeConversationSummaries = (
  conversations?: ConversationSummary[],
): ConversationSummarySnapshot[] | undefined => {
  if (!Array.isArray(conversations) || conversations.length === 0) return undefined;
  return conversations.map((conversation) => ({
    ...conversation,
    activeRunId: null,
    isStreaming: false,
    agent: serializeAgentForStorage(conversation.agent) ?? {
      id: '',
      name: conversation.agent.name,
      description: conversation.agent.description,
      version: conversation.agent.version,
      isActive: conversation.agent.isActive,
      iconName: conversation.agent.iconName ?? null,
    },
  }));
};


const deserializeConversationSummaries = (
  conversations?: ConversationSummarySnapshot[] | null,
): ConversationSummary[] | undefined => {
  if (!Array.isArray(conversations) || conversations.length === 0) return undefined;
  return conversations.map((conversation) => ({
    ...conversation,
    activeRunId: null,
    isStreaming: false,
    agent: deserializeAgentFromStorage(conversation.agent),
  }));
};


const serializeToolsForStorage = (tools?: ToolMetadata[]): ToolMetadata[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    serverId: tool.serverId ?? "",
    toolName: tool.toolName,
    description: tool.description ?? "",
    parameterCount: typeof tool.parameterCount === 'number' ? tool.parameterCount : 0,
  }));
};


const deserializeToolsFromStorage = (tools?: ToolMetadata[]): ToolMetadata[] => {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    serverId: tool.serverId ?? "",
    toolName: tool.toolName,
    description: tool.description ?? "",
    parameterCount: typeof tool.parameterCount === 'number' ? tool.parameterCount : 0,
  }));
};


function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
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


export async function saveUISnapshot(userId: string, data: UISnapshotSerializable): Promise<void> {
  const { selectedImage: _ignoredImage, ...rest } = data;
  const payload: PersistedSnapshot = {
    ...rest,
    availableTools: serializeToolsForStorage(data.availableTools),
    availableSkills: data.availableSkills ?? [],
    myRegistrySkills: data.myRegistrySkills ?? [],
    agents: serializeAgentsListForStorage(data.agents),
    conversations: serializeConversationSummaries(data.conversations),
    userPreferences: data.userPreferences ?? null,
    version: 4,
  };
  await idbPut(STATE_STORE, userId, payload);
}


export async function loadUISnapshot(userId: string): Promise<UISnapshotSerializable | null> {
  const saved: PersistedSnapshot | undefined = await idbGet(STATE_STORE, userId);
  if (!saved) return null;
  // Discard the snapshot wholesale on any integrity failure — wrong/old schema
  // (enforced by the `version` literal), unexpected shape, or prototype-
  // pollution keys — instead of spreading untrusted bytes into app state. The
  // bootstrap fetch repopulates from the backend either way.
  if (hasForbiddenKey(saved) || !snapshotSchema.safeParse(saved).success) return null;
  const {
    availableTools,
    availableSkills,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
    selectedImage: _ignoredImage,
    ...rest
  } = saved as PersistedSnapshot & { selectedImage?: string | null };
  return {
    ...(rest as Omit<
      UISnapshotSerializable,
      'availableTools' | 'availableSkills' | 'myRegistrySkills' | 'agents' | 'conversations' | 'userPreferences'
    >),
    availableTools: deserializeToolsFromStorage(availableTools),
    availableSkills: Array.isArray(availableSkills) ? availableSkills : [],
    myRegistrySkills: Array.isArray(myRegistrySkills) ? myRegistrySkills : [],
    agents: deserializeAgentsListFromStorage(agents),
    conversations: deserializeConversationSummaries(conversations),
    userPreferences: userPreferences ?? null,
  };
}


export async function clearUISnapshot(userId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readwrite');
    const store = tx.objectStore(STATE_STORE);
    const req = store.delete(userId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
