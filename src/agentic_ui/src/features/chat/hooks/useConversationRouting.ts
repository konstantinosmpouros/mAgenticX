import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";

import { getConversationDetail } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type {
  Agent,
  ConversationDetail,
  SharedConversationDetail,
  ThinkingState,
} from "@/shared/lib/types";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

/** Store setters accept a value or an updater, like `useState`. */
type SetStateArg<T> = T | ((prev: T) => T);

type UseConversationRoutingOptions = {
  // ── route ──
  /** `:conversationId`; undefined on "/" and "/tasks". */
  conversationId: string | undefined;
  isTasksRoute: boolean;
  navigate: NavigateFunction;

  // ── identity gate ──
  authResolved: boolean;
  isLoggedIn: boolean;
  userId: string | null;

  // ── shared-conversation mode (read-only, token instead of an id) ──
  sharedConversationToken?: string;
  initialSharedConversation?: SharedConversationDetail | null;

  // ── workspace state this fills ──
  currentConversation: ConversationDetail | null;
  agents: Agent[];
  selectedAgent: string;
  setCurrentConversation: (v: SetStateArg<ConversationDetail | null>) => void;
  setSelectedAgent: (v: SetStateArg<string>) => void;
  setIsPrivateMode: (v: SetStateArg<boolean>) => void;
  setInactiveAgentFallback: (v: SetStateArg<Agent | null>) => void;
  setLoadingConversation: (v: SetStateArg<boolean>) => void;

  // ── conversation-scoped state this erases on leaving ──
  setThinkingState: Dispatch<SetStateAction<ThinkingState | null>>;
  setExpandedThinking: Dispatch<SetStateAction<{ [key: string]: boolean }>>;
  setAttachments: Dispatch<SetStateAction<File[]>>;
  setCurrentMessage: Dispatch<SetStateAction<string>>;
  setBranchSelections: Dispatch<SetStateAction<Record<string, number>>>;

  // ── collaborators ──
  closeVoiceSession: () => void;
  deriveBranchSelectionsForActiveRun: (detail: ConversationDetail) => Record<string, number> | null;
  requestPersist: () => void;
  toast: ToastFn;
};

/**
 * The URL is the single source of truth for which conversation is on screen, and
 * this hook is everything that follows from that.
 *
 * It replaced several older load paths (a click-handler setTimeout choreography
 * and a separate "hydrate the last conversation" effect) that fought each other.
 * Consolidating them here is what makes conversation switching safe mid-stream
 * and mid-animation, so the effects below are deliberately kept together rather
 * than filed next to the state each one happens to touch.
 *
 * Read the two guards before changing anything here — both encode a bug that
 * shipped:
 *
 *  - **The generation counter, NOT a `loading` flag.** Every run bumps `gen`, and
 *    a resolved fetch drops its own result if a newer navigation has started.
 *    An `if (loading) return` guard was tried and reverted: it blocks switching
 *    while a load or animation is in flight, which is exactly the freeze users hit.
 *  - **`null -> id` promotion only.** Clicking "New chat" on `/c/:id` navigates to
 *    "/", but on that render `currentConversation` is still the old one (the reset
 *    commits next render). Without the previous-id check, the promotion effect
 *    would see that stale id with no `:conversationId` and bounce straight back.
 */
export function useConversationRouting({
  conversationId,
  isTasksRoute,
  navigate,
  authResolved,
  isLoggedIn,
  userId,
  sharedConversationToken,
  initialSharedConversation,
  currentConversation,
  agents,
  selectedAgent,
  setCurrentConversation,
  setSelectedAgent,
  setIsPrivateMode,
  setInactiveAgentFallback,
  setLoadingConversation,
  setThinkingState,
  setExpandedThinking,
  setAttachments,
  setCurrentMessage,
  setBranchSelections,
  closeVoiceSession,
  deriveBranchSelectionsForActiveRun,
  requestPersist,
  toast,
}: UseConversationRoutingOptions) {
  // Bumped by every load; a resolved fetch compares against it to decide whether
  // it is still the newest navigation.
  const loadGenRef = useRef(0);

  // A shared conversation arrives fully-formed as a prop (no id, no fetch), so it
  // is hydrated into the workspace once per token rather than loaded by route.
  const hydratedSharedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !sharedConversationToken ||
      !initialSharedConversation ||
      !authResolved ||
      !isLoggedIn ||
      !userId
    )
      return;
    if (hydratedSharedTokenRef.current === sharedConversationToken) return;

    hydratedSharedTokenRef.current = sharedConversationToken;
    setSelectedAgent(initialSharedConversation.agent.id);
    setIsPrivateMode(false);
    setCurrentConversation({
      id: `shared:${sharedConversationToken}`,
      agent: initialSharedConversation.agent,
      title: initialSharedConversation.title || "Shared conversation",
      isPrivate: false,
      created_at: initialSharedConversation.createdAt,
      updated_at: initialSharedConversation.createdAt,
      messages: initialSharedConversation.messages,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable
  }, [authResolved, initialSharedConversation, isLoggedIn, sharedConversationToken, userId]);

  // ── URL-driven conversation loading ────────────────────────────────────
  // `currentConversation` is read but deliberately omitted from the deps, so
  // navigating does not retrigger on every streamed message.
  useEffect(() => {
    if (!authResolved || !isLoggedIn || !userId || sharedConversationToken) return;
    const gen = ++loadGenRef.current;
    // Voice never survives a navigation between conversations/pages.
    closeVoiceSession();

    if (!conversationId) {
      // "/" or "/tasks" → erase conversation-scoped state synchronously.
      setThinkingState(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage("");
      setInactiveAgentFallback(null);
      setCurrentConversation(null);
      setIsPrivateMode(false);
      setLoadingConversation(false);
      return;
    }

    // Already showing this conversation (e.g. just created / forked) → no refetch.
    if (currentConversation?.id === conversationId) return;

    setLoadingConversation(true);
    getConversationDetail(userId, conversationId)
      .then((detail) => {
        if (gen !== loadGenRef.current) return; // superseded by a newer navigation
        // Pin branch selections to the active run's path so a streaming /
        // HITL-paused message isn't hidden on a sibling branch.
        const activeRunBranchSelections = deriveBranchSelectionsForActiveRun(detail);
        setSelectedAgent(detail.agent?.id || "");
        if (activeRunBranchSelections) setBranchSelections(activeRunBranchSelections);
        setCurrentConversation(detail);
        setIsPrivateMode(detail.isPrivate || false);
        setInactiveAgentFallback(null);
        requestPersist();
      })
      .catch((error) => {
        if (gen !== loadGenRef.current) return;
        toastError(toast, "Failed to load conversation", error, {
          description: "There was an error loading the conversation. Please try again.",
          duration: 3000,
        });
      })
      .finally(() => {
        if (gen === loadGenRef.current) setLoadingConversation(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, authResolved, isLoggedIn, userId, sharedConversationToken]);

  // Promote a conversation created from the empty "/" state (first message sent)
  // into the URL so it is linkable and survives refresh. See the `null -> id`
  // note in the hook docblock for why the previous-id check is load-bearing.
  const lastConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = currentConversation?.id ?? null;
    // "" is the optimistic conversation shell of an in-flight first send — it
    // counts as empty so the shell→real-id transition still promotes the URL
    // (and `if (id && …)` below keeps the shell itself from being navigated to).
    const wasEmpty = !lastConversationIdRef.current;
    lastConversationIdRef.current = id;
    if (id && wasEmpty && !id.startsWith("shared:") && !conversationId && !isTasksRoute) {
      navigate("/c/" + id, { replace: true });
    }
  }, [currentConversation?.id, conversationId, isTasksRoute, navigate]);

  // Entering the tasks page tears down any live voice session. The load effect
  // only fires on :conversationId changes, and "/" ↔ "/tasks" keeps it null,
  // so voice is closed here for that transition.
  useEffect(() => {
    if (isTasksRoute) closeVoiceSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTasksRoute]);

  // With no conversation open, the picker's selection must name an agent that is
  // actually in the catalog. An open conversation may legitimately point at one
  // that isn't (its own inactive/removed agent, merged into the list for display),
  // but once that conversation is gone the id is unusable: it would leave the
  // trigger blank and send inference against an agent that no longer exists.
  // Guarded on the route param too, so this never races an in-flight load that is
  // about to set the selection from the conversation itself — which is why it
  // lives here rather than beside the rest of the agent-catalog code.
  useEffect(() => {
    if (conversationId || currentConversation || agents.length === 0) return;
    if (agents.some((agent) => agent.id === selectedAgent)) return;
    const nextAgent = agents.find((agent) => agent.isActive) ?? agents[0];
    setSelectedAgent(nextAgent?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable
  }, [conversationId, currentConversation, agents, selectedAgent]);
}
