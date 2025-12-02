// IndexedDB-backed persistence for lightweight UI state (agents/tools/preferences lists).
// Only metadata and IDs are stored; conversations are rehydrated from the backend on refresh.

import { mapIcon } from '@/lib/consts';
import type { Agent, ConversationSummary, ToolMetadata, UserPreferences } from '@/lib/types';

const DB_NAME = 'mx_ui_state';
const STATE_STORE = 'state';
const DB_VERSION = 2;

type AgentSnapshot = {
  id: string;
  name: string;
  description: string;
  iconName?: string | null;
  version?: string;
  isActive: boolean;
};

type ConversationSummarySnapshot = Omit<ConversationSummary, 'agent'> & {
  agent: AgentSnapshot;
};

export type UISnapshotSerializable = {
  version: 2;
  selectedAgent: string;
  isPrivateMode: boolean;
  activeProfileTab: string;
  sidebarOpen: boolean;
  lastConversationId: string | null;
  availableTools?: ToolMetadata[];
  agents?: Agent[];
  conversations?: ConversationSummary[];
  userPreferences?: UserPreferences | null;
};

type PersistedSnapshot = Omit<
  UISnapshotSerializable,
  'agents' | 'conversations' | 'userPreferences'
> & {
  agents?: AgentSnapshot[];
  conversations?: ConversationSummarySnapshot[];
  userPreferences?: UserPreferences | null;
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
  const payload: PersistedSnapshot = {
    ...data,
    availableTools: serializeToolsForStorage(data.availableTools),
    agents: serializeAgentsListForStorage(data.agents),
    conversations: serializeConversationSummaries(data.conversations),
    userPreferences: data.userPreferences ?? null,
    version: 2,
  };
  await idbPut(STATE_STORE, userId, payload);
}

export async function loadUISnapshot(userId: string): Promise<UISnapshotSerializable | null> {
  const saved: PersistedSnapshot | undefined = await idbGet(STATE_STORE, userId);
  if (!saved) return null;
  const { availableTools, agents, conversations, userPreferences, ...rest } = saved;
  return {
    ...(rest as Omit<UISnapshotSerializable, 'availableTools' | 'agents' | 'conversations' | 'userPreferences'>),
    availableTools: deserializeToolsFromStorage(availableTools),
    agents: deserializeAgentsListFromStorage(agents),
    conversations: deserializeConversationSummaries(conversations),
    userPreferences: userPreferences ?? null,
  };
}
