import { create } from "zustand";

import { loadSession } from "@/shared/lib/authStorage";
import { CONV_FIRST_PAGE_INDEX } from "@/shared/lib/consts";
import type {
  Agent,
  ConversationDetail,
  ConversationShareListItem,
  ConversationSummary,
  Skill,
  ToolMetadata,
  UserPreferences,
  UserProfile,
  UserSkill,
} from "@/shared/lib/types";

/**
 * Workspace store — the shared, cross-view client state for the chat workspace.
 *
 * Holds the data the persistent shell (sidebar/header) AND the route views
 * (ChatView/TasksView) both read: auth/user, catalogs (agents/tools/skills),
 * preferences, the conversation lists + the open conversation, and a few
 * shell-level UI flags. View-local state (composer draft, attachments, editing,
 * dictation, voice transition, etc.) deliberately stays in the views.
 *
 * Every setter is **setState-compatible** — it accepts either a value or an
 * updater `(prev) => next`, exactly like React's `Dispatch<SetStateAction<T>>`.
 * That lets the existing hooks (`useInferenceRuns`, session effects, …) and the
 * `create*Handlers` factories be reused verbatim: we only change where the
 * setter comes from, never how they call it. Consumers subscribe with selectors
 * (`useWorkspaceStore(s => s.conversations)`) so updates re-render only readers
 * of that slice.
 */

type SetStateArg<T> = T | ((prev: T) => T);
const resolve = <T>(arg: SetStateArg<T>, prev: T): T =>
  typeof arg === "function" ? (arg as (p: T) => T)(prev) : arg;

export type WorkspaceState = {
  // Auth / user
  userId: string | null;
  isLoggedIn: boolean;
  authResolved: boolean;
  userProfile: UserProfile | null;

  // Catalogs + preferences
  agents: Agent[];
  availableTools: ToolMetadata[];
  availableSkills: Skill[];
  myRegistrySkills: UserSkill[];
  userPreferences: UserPreferences | null;
  isSavingPreferences: boolean;

  // Active selection
  selectedAgent: string;
  isPrivateMode: boolean;
  inactiveAgentFallback: Agent | null;
  currentConversation: ConversationDetail | null;
  loadingConversation: boolean;

  // Conversation lists (+ pagination)
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  convPage: number;
  convHasMore: boolean;
  convIsLoadingMore: boolean;
  archivedConversations: ConversationSummary[];
  archivedConvPage: number;
  archivedConvHasMore: boolean;
  archivedConvIsLoading: boolean;
  sharedConversations: ConversationShareListItem[];
  sharedConvPage: number;
  sharedConvHasMore: boolean;
  sharedConvIsLoading: boolean;

  // Misc shared UI
  starterSuggestions: string[];
  sidebarOpen: boolean;
  activeProfileTab: string;

  // Setters (setState-compatible)
  setUserId: (v: SetStateArg<string | null>) => void;
  /** Clear every per-user slice before switching accounts. */
  resetForAccountSwitch: () => void;
  setIsLoggedIn: (v: SetStateArg<boolean>) => void;
  setAuthResolved: (v: SetStateArg<boolean>) => void;
  setUserProfile: (v: SetStateArg<UserProfile | null>) => void;
  setAgents: (v: SetStateArg<Agent[]>) => void;
  setAvailableTools: (v: SetStateArg<ToolMetadata[]>) => void;
  setAvailableSkills: (v: SetStateArg<Skill[]>) => void;
  setMyRegistrySkills: (v: SetStateArg<UserSkill[]>) => void;
  setUserPreferences: (v: SetStateArg<UserPreferences | null>) => void;
  setIsSavingPreferences: (v: SetStateArg<boolean>) => void;
  setSelectedAgent: (v: SetStateArg<string>) => void;
  setIsPrivateMode: (v: SetStateArg<boolean>) => void;
  setInactiveAgentFallback: (v: SetStateArg<Agent | null>) => void;
  setCurrentConversation: (v: SetStateArg<ConversationDetail | null>) => void;
  setLoadingConversation: (v: SetStateArg<boolean>) => void;
  setConversations: (v: SetStateArg<ConversationSummary[]>) => void;
  setConversationsLoading: (v: SetStateArg<boolean>) => void;
  setConvPage: (v: SetStateArg<number>) => void;
  setConvHasMore: (v: SetStateArg<boolean>) => void;
  setConvIsLoadingMore: (v: SetStateArg<boolean>) => void;
  setArchivedConversations: (v: SetStateArg<ConversationSummary[]>) => void;
  setArchivedConvPage: (v: SetStateArg<number>) => void;
  setArchivedConvHasMore: (v: SetStateArg<boolean>) => void;
  setArchivedConvIsLoading: (v: SetStateArg<boolean>) => void;
  setSharedConversations: (v: SetStateArg<ConversationShareListItem[]>) => void;
  setSharedConvPage: (v: SetStateArg<number>) => void;
  setSharedConvHasMore: (v: SetStateArg<boolean>) => void;
  setSharedConvIsLoading: (v: SetStateArg<boolean>) => void;
  setStarterSuggestions: (v: SetStateArg<string[]>) => void;
  setSidebarOpen: (v: SetStateArg<boolean>) => void;
  setActiveProfileTab: (v: SetStateArg<string>) => void;
};

// Self-seed auth/user from the persisted session (mirrors the old
// useInitialSessionState: userId + profile from localStorage, logged-in stays
// false until the rehydrate effect confirms the session).
const initialSession = typeof window !== "undefined" ? loadSession() : null;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  userId: initialSession?.userId ?? null,
  isLoggedIn: false,
  authResolved: false,
  userProfile: initialSession?.user ?? null,

  agents: [],
  availableTools: [],
  availableSkills: [],
  myRegistrySkills: [],
  userPreferences: null,
  isSavingPreferences: false,

  selectedAgent: "",
  isPrivateMode: false,
  inactiveAgentFallback: null,
  currentConversation: null,
  loadingConversation: false,

  conversations: [],
  conversationsLoading: false,
  convPage: CONV_FIRST_PAGE_INDEX,
  convHasMore: true,
  convIsLoadingMore: false,
  archivedConversations: [],
  archivedConvPage: 1,
  archivedConvHasMore: true,
  archivedConvIsLoading: false,
  sharedConversations: [],
  sharedConvPage: 1,
  sharedConvHasMore: true,
  sharedConvIsLoading: false,

  starterSuggestions: [],
  sidebarOpen: false,
  activeProfileTab: "general",

  setUserId: (v) => set((s) => ({ userId: resolve(v, s.userId) })),
  /**
   * Wipe every per-user slice before another account becomes active.
   *
   * The login bootstrap only *replaces* what it fetches (agents, tools, skills,
   * preferences, conversations). Everything else here would otherwise survive a
   * switch and be shown under the new identity — the archived and shared
   * conversation lists most visibly, since they are lazily loaded and would keep
   * the previous account's titles until the user happened to reload them.
   *
   * Auth fields (`userId`, `userProfile`, `isLoggedIn`) are deliberately left
   * alone: the bootstrap sets them, and blanking them here would bounce the
   * router to /login mid-switch.
   */
  resetForAccountSwitch: () =>
    set(() => ({
      agents: [],
      availableTools: [],
      availableSkills: [],
      myRegistrySkills: [],
      userPreferences: null,
      isSavingPreferences: false,
      selectedAgent: "",
      isPrivateMode: false,
      inactiveAgentFallback: null,
      currentConversation: null,
      loadingConversation: false,
      conversations: [],
      conversationsLoading: false,
      convPage: CONV_FIRST_PAGE_INDEX,
      convHasMore: true,
      convIsLoadingMore: false,
      archivedConversations: [],
      archivedConvPage: 1,
      archivedConvHasMore: true,
      archivedConvIsLoading: false,
      sharedConversations: [],
      sharedConvPage: 1,
      sharedConvHasMore: true,
      sharedConvIsLoading: false,
      starterSuggestions: [],
    })),

  setIsLoggedIn: (v) => set((s) => ({ isLoggedIn: resolve(v, s.isLoggedIn) })),
  setAuthResolved: (v) => set((s) => ({ authResolved: resolve(v, s.authResolved) })),
  setUserProfile: (v) => set((s) => ({ userProfile: resolve(v, s.userProfile) })),
  setAgents: (v) => set((s) => ({ agents: resolve(v, s.agents) })),
  setAvailableTools: (v) => set((s) => ({ availableTools: resolve(v, s.availableTools) })),
  setAvailableSkills: (v) => set((s) => ({ availableSkills: resolve(v, s.availableSkills) })),
  setMyRegistrySkills: (v) => set((s) => ({ myRegistrySkills: resolve(v, s.myRegistrySkills) })),
  setUserPreferences: (v) => set((s) => ({ userPreferences: resolve(v, s.userPreferences) })),
  setIsSavingPreferences: (v) =>
    set((s) => ({ isSavingPreferences: resolve(v, s.isSavingPreferences) })),
  setSelectedAgent: (v) => set((s) => ({ selectedAgent: resolve(v, s.selectedAgent) })),
  setIsPrivateMode: (v) => set((s) => ({ isPrivateMode: resolve(v, s.isPrivateMode) })),
  setInactiveAgentFallback: (v) =>
    set((s) => ({ inactiveAgentFallback: resolve(v, s.inactiveAgentFallback) })),
  setCurrentConversation: (v) =>
    set((s) => ({ currentConversation: resolve(v, s.currentConversation) })),
  setLoadingConversation: (v) =>
    set((s) => ({ loadingConversation: resolve(v, s.loadingConversation) })),
  setConversations: (v) => set((s) => ({ conversations: resolve(v, s.conversations) })),
  setConversationsLoading: (v) =>
    set((s) => ({ conversationsLoading: resolve(v, s.conversationsLoading) })),
  setConvPage: (v) => set((s) => ({ convPage: resolve(v, s.convPage) })),
  setConvHasMore: (v) => set((s) => ({ convHasMore: resolve(v, s.convHasMore) })),
  setConvIsLoadingMore: (v) => set((s) => ({ convIsLoadingMore: resolve(v, s.convIsLoadingMore) })),
  setArchivedConversations: (v) =>
    set((s) => ({ archivedConversations: resolve(v, s.archivedConversations) })),
  setArchivedConvPage: (v) => set((s) => ({ archivedConvPage: resolve(v, s.archivedConvPage) })),
  setArchivedConvHasMore: (v) =>
    set((s) => ({ archivedConvHasMore: resolve(v, s.archivedConvHasMore) })),
  setArchivedConvIsLoading: (v) =>
    set((s) => ({ archivedConvIsLoading: resolve(v, s.archivedConvIsLoading) })),
  setSharedConversations: (v) =>
    set((s) => ({ sharedConversations: resolve(v, s.sharedConversations) })),
  setSharedConvPage: (v) => set((s) => ({ sharedConvPage: resolve(v, s.sharedConvPage) })),
  setSharedConvHasMore: (v) => set((s) => ({ sharedConvHasMore: resolve(v, s.sharedConvHasMore) })),
  setSharedConvIsLoading: (v) =>
    set((s) => ({ sharedConvIsLoading: resolve(v, s.sharedConvIsLoading) })),
  setStarterSuggestions: (v) =>
    set((s) => ({ starterSuggestions: resolve(v, s.starterSuggestions) })),
  setSidebarOpen: (v) => set((s) => ({ sidebarOpen: resolve(v, s.sidebarOpen) })),
  setActiveProfileTab: (v) => set((s) => ({ activeProfileTab: resolve(v, s.activeProfileTab) })),
}));

// The workspace-bundle context used to live here. It moved to
// `app/workspaceContext.ts` because it is typed by the bundle, and importing
// that type into `shared/` inverted the one-way `pages → features → shared`
// dependency rule. This store now knows nothing about the bundle.
