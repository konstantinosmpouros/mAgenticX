import { useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
    Bell,
    HardDrive,
    Puzzle,
    Shield,
    type LucideProps,
} from "lucide-react";

import { ScrollArea } from "@/shared/ui/scroll-area";
import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import { normalizeCustomInstructions, safeText } from "@/shared/lib/utils";
import { NA, type PersonalityId, type RealtimeVoice, type VoiceModeLanguage } from "@/shared/lib/consts";
import { Agent, ConversationShareListItem, ConversationSummary, ConversationUsage, CustomInstructions, CustomSkillCreatePayload, Skill, ToolMetadata, UserAgentSkillSelection, UserPreferences, UserProfile, UserSkill, UserSkillDetail } from "@/shared/lib/types";
import ProfileSidebar, { NAV_ITEMS } from "./profile_parts/ProfileSidebar";
import AccountTab from "./profile_parts/AccountTab";
import GeneralTab from "./profile_parts/GeneralTab";
import PersonalizationTab from "./profile_parts/PersonalizationTab";
import VoiceTab from "./profile_parts/VoiceTab";
import SecurityTab from "./profile_parts/SecurityTab";
import DataControlsTab from "./profile_parts/DataControlsTab";
import McpServersTab from "./profile_parts/McpServersTab";
import AgentsTab from "./profile_parts/AgentsTab";
import SkillsTab from "./profile_parts/SkillsTab";
import MemoriesTab from "./profile_parts/MemoriesTab";
import UsageTab from "./profile_parts/UsageTab";
import ComingSoon from "./profile_parts/ComingSoon";
import CustomInstructionsDialog from "./profile_parts/CustomInstructionsDialog";
import type { MemoriesHandlers } from "@/features/settings/hooks/useMemories";
import { useUsageSummary } from "@/features/settings/hooks/useUsageSummary";

/** Pre-taxonomy tab ids (persisted in UI snapshots) → their new section. */
const LEGACY_TAB_MAP: Record<string, string> = {
    profile: "account",
    appearance: "personalization",
    archived: "data-controls",
};

const VALID_SECTION_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id));

/** Header copy per section — title + one-line description under it. */
const SECTION_META: Record<string, { eyebrow?: string; title: string; description: string }> = {
    general: {
        title: "General",
        description: "Theme, chat experience, and the workspace-wide basics.",
    },
    notifications: {
        title: "Notifications",
        description: "How and where the workspace notifies you about finished work.",
    },
    personalization: {
        title: "Personalization",
        description: "Control what agents remember about you and how they adapt.",
    },
    plugins: {
        title: "Plugins",
        description: "Third-party plugins that extend what agents can do.",
    },
    voice: {
        title: "Voice",
        description: "The voice agents speak with and the default spoken language.",
    },
    usage: {
        title: "Usage",
        description: "Workspace-wide token and run usage.",
    },
    "data-controls": {
        title: "Data controls",
        description: "Manage archived conversations, shared links, and how history behaves.",
    },
    storage: {
        title: "Storage",
        description: "Attachment and artifact storage across the workspace.",
    },
    safety: {
        title: "Safety",
        description: "Content safety controls and moderation preferences.",
    },
    security: {
        title: "Security",
        description: "Session lifetime, sign-out, and account protection.",
    },
    account: {
        title: "Account",
        description: "Review your identity, workspace role, and recent account activity.",
    },
    agents: {
        title: "Agents",
        description: "Give each agent the tools it should use — your choices apply per agent.",
    },
    skills: {
        title: "Skills",
        description: "Your pool and the shared catalog.",
    },
    mcp: {
        title: "MCP Servers",
        description: "Choose which MCP-powered tools stay available inside conversations.",
    },
    memories: {
        title: "Memory",
        description: "Review and delete what each deep agent remembers about you.",
    },
};

/** Sections mirrored from the ChatGPT taxonomy that are not implemented yet. */
const STUB_SECTIONS: Record<
    string,
    { icon: ComponentType<LucideProps>; title: string; description: string; notes?: string[] }
> = {
    notifications: {
        icon: Bell,
        title: "Notifications",
        description:
            "Web push, email, and an in-app inbox for run completions, scheduled-task results, and approval requests.",
        notes: ["Scheduled-task results currently surface inside the app while it is open."],
    },
    plugins: {
        icon: Puzzle,
        title: "Plugins",
        description: "Connect third-party plugins and OAuth-based app connectors to your workspace.",
        notes: ["MCP-powered tools are already available under Workspace → MCP Servers."],
    },
    storage: {
        icon: HardDrive,
        title: "Storage",
        description: "Quotas and cleanup for attachments, generated artifacts, and agent files.",
    },
    safety: {
        icon: Shield,
        title: "Safety",
        description: "Content safety controls and moderation preferences for agent responses.",
    },
};

type ProfilePanelProps = {
    open: boolean;
    onClose: () => void;
    activeTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
    user: UserProfile | null;
    availableTools: (ToolMetadata & { enabled?: boolean })[];
    // Global catalog — admin-curated, read-only at runtime. Surface searched
    // from the My skills view via the "+ Add" path when the user wants to
    // pull a global into their personal pool.
    availableSkills: Skill[];
    onRefreshSkills?: () => Promise<void>;
    // User pool ("My skills"): the user's personal registry. Mixed globals
    // (references) + customs (user-authored). Mutation handlers below.
    mySkills?: UserSkill[];
    loadingMySkills?: boolean;
    mySkillDetails?: Record<string, UserSkillDetail>;
    isMySkillDetailLoading?: (skillName: string) => boolean;
    onLoadMySkillDetail?: (skillName: string) => Promise<void>;
    onRefreshMySkills?: () => Promise<void>;
    onAddGlobalSkillToPool?: (skillName: string) => Promise<void>;
    onCreateCustomSkill?: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
    onRemoveSkillFromPool?: (skillName: string) => Promise<void>;
    // Manage-per-agent skill selection. The Skills tab "Manage" sub-view
    // renders one card per deep agent; ``skillSelections`` is the per-agent
    // enabled set keyed by ``agentId``. The hook lazy-loads selection when
    // the user expands an agent card via ``onLoadAgentSkills``.
    agents?: Agent[];
    skillSelections?: UserAgentSkillSelection;
    onLoadAgentSkills?: (agentId: string) => Promise<void>;
    onToggleUserAgentSkill?: (agentId: string, skillName: string) => Promise<void>;
    isAgentSkillLoading?: (agentId: string) => boolean;
    isSkillToggling?: (agentId: string, skillName: string) => boolean;
    // Per-(user, agent) long-term memory inspector (useMemories output). The
    // Memories tab drills into a deep agent and lists/previews/deletes the
    // memories it has saved about the user.
    memoryInspector?: MemoriesHandlers;
    userPreferences: UserPreferences;
    archivedConversations: ConversationSummary[];
    archivedConversationsLoading?: boolean;
    archivedConversationsHasMore?: boolean;
    onLoadMoreArchivedConversations?: () => void;
    onSelectArchivedConversation?: (conversation: ConversationSummary) => void;
    onUnarchiveConversation?: (conversation: ConversationSummary) => void;
    sharedConversations?: ConversationShareListItem[];
    sharedConversationsLoading?: boolean;
    sharedConversationsHasMore?: boolean;
    onLoadMoreSharedConversations?: () => void;
    onSelectSharedConversation?: (share: ConversationShareListItem) => void;
    onRevokeSharedConversation?: (share: ConversationShareListItem) => void;
    onToggleSuggestionsEnabled?: () => void;
    onToggleMessageTokenUsage?: () => void;
    onToggleSearchPastConvs?: () => void;
    onToggleUseMemory?: () => void;
    onSelectPersonality?: (personality: PersonalityId) => void;
    /** Persists the custom-instructions document; resolves true on success. */
    onSaveCustomInstructions?: (value: CustomInstructions) => Promise<boolean>;
    onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
    onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
    preferencesSaving?: boolean;
    // Usage tab — per-conversation stats computed client-side by the shell
    // (null when no conversation is open); workspace rollup is fetched here.
    conversationUsage?: ConversationUsage | null;
    conversationTitle?: string | null;
};

export default function ProfilePanel({
    open,
    onClose,
    activeTab,
    setActiveTab,
    onLogout,
    user,
    availableTools,
    availableSkills,
    onRefreshSkills,
    mySkills,
    loadingMySkills = false,
    mySkillDetails,
    isMySkillDetailLoading,
    onLoadMySkillDetail,
    onRefreshMySkills,
    onAddGlobalSkillToPool,
    onCreateCustomSkill,
    onRemoveSkillFromPool,
    agents,
    skillSelections,
    onLoadAgentSkills,
    onToggleUserAgentSkill,
    isAgentSkillLoading,
    isSkillToggling,
    memoryInspector,
    userPreferences,
    archivedConversations,
    archivedConversationsLoading = false,
    archivedConversationsHasMore = false,
    onLoadMoreArchivedConversations,
    onSelectArchivedConversation,
    onUnarchiveConversation,
    sharedConversations = [],
    sharedConversationsLoading = false,
    sharedConversationsHasMore = false,
    onLoadMoreSharedConversations,
    onSelectSharedConversation,
    onRevokeSharedConversation,
    onToggleSuggestionsEnabled,
    onToggleMessageTokenUsage,
    onToggleSearchPastConvs,
    onToggleUseMemory,
    onSelectPersonality,
    onSaveCustomInstructions,
    onSelectVoiceModeVoice,
    onSelectVoiceModeLanguage,
    preferencesSaving = false,
    conversationUsage = null,
    conversationTitle = null,
}: ProfilePanelProps) {
    const reduceMotion = useReducedMotion();
    // The custom-instructions editor is owned here (not by the tab) so it can
    // render as a SIBLING of the settings shell — PremiumModalShell doesn't
    // portal, and nesting one shell inside another traps the overlay in the
    // panel's stacking/animation context.
    const [showCustomInstructions, setShowCustomInstructions] = useState(false);

    // Closing the whole panel (Esc, backdrop, X) must also drop the editor —
    // otherwise it would still be flagged open the next time the panel mounts.
    useEffect(() => {
        if (!open) setShowCustomInstructions(false);
    }, [open]);
    const displayName =
        safeText(user?.displayName) !== NA
            ? safeText(user?.displayName)
            : safeText(user?.fullName) !== NA
              ? safeText(user?.fullName)
              : safeText(user?.username);
    // Persisted tab ids from before the ChatGPT-taxonomy rename keep working:
    // remap them to their new section, then validate against the nav registry
    // (plus the hidden sections reachable via the Help submenu / shortcuts).
    const remappedTab = LEGACY_TAB_MAP[activeTab] ?? activeTab;
    const normalizedActiveTab = VALID_SECTION_IDS.has(remappedTab) ? remappedTab : "general";

    // Workspace usage rollup — fetched lazily the first time the Usage tab is
    // opened, cached (with a short TTL) across tab switches and panel closes.
    const usage = useUsageSummary(user?.id ?? null, open && normalizedActiveTab === "usage");

    // Fall back to the General section if a nav item ever lacks a meta entry,
    // so a missing key degrades gracefully instead of crashing the panel.
    const activeSection = SECTION_META[normalizedActiveTab] ?? SECTION_META.general;
    const showActiveSectionEyebrow =
        Boolean(activeSection.eyebrow)
        && activeSection.eyebrow.trim().toLowerCase() !== activeSection.title.trim().toLowerCase();

    const stub = STUB_SECTIONS[normalizedActiveTab];

    if (!open) return null;

    return (
        <>
        <PremiumModalShell open={open} onClose={onClose} closeLabel="Close profile panel" className="max-w-5xl">
            <div className="flex h-[min(44rem,88vh)] w-full min-w-0 max-[639px]:flex-col">
                <ProfileSidebar
                    normalizedActiveTab={normalizedActiveTab}
                    setActiveTab={setActiveTab}
                />

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="border-b border-white/10 px-6 py-5 pr-16 sm:px-8 sm:pr-16 max-[639px]:px-4 max-[639px]:py-3 max-[639px]:pr-12">
                        {showActiveSectionEyebrow ? (
                            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45 max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.16em]">
                                {activeSection.eyebrow}
                            </p>
                        ) : null}
                        <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between max-[639px]:gap-2">
                            {/* Keyed by section so a tab switch re-runs the entrance. */}
                            <motion.div
                                key={normalizedActiveTab}
                                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.22, ease: "easeOut" }}
                                className="min-w-0 space-y-1"
                            >
                                <h2 className="text-2xl font-semibold leading-tight tracking-tight text-white md:text-[2rem] max-[639px]:text-xl">
                                    {activeSection.title}
                                </h2>
                                <p className="max-w-2xl text-sm text-white/55 max-[639px]:text-xs">
                                    {activeSection.description}
                                </p>
                            </motion.div>
                            <div className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-full border border-white/[0.12] bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/60 sm:max-w-xs max-[639px]:gap-1.5 max-[639px]:px-2 max-[639px]:py-0.5 max-[639px]:text-[0.68rem]">
                                <span className="flex h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)] max-[639px]:h-1.5 max-[639px]:w-1.5" aria-hidden="true" />
                                <span className="min-w-0 truncate">
                                    <span className="text-emerald-400">Signed in</span>
                                    <span className="text-white/55"> as </span>
                                    <span className="font-medium text-white">{displayName}</span>
                                </span>
                            </div>
                        </div>
                    </div>

                            <ScrollArea className="h-full w-full">
                                {/* Animated section swap: outgoing content fades down-out,
                                    incoming rises in (mode="wait" keeps them sequential). */}
                                <AnimatePresence mode="wait" initial={false}>
                                    <motion.div
                                        key={normalizedActiveTab}
                                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
                                        animate={{
                                            opacity: 1,
                                            y: 0,
                                            transition: { duration: 0.22, ease: "easeOut" },
                                        }}
                                        exit={
                                            reduceMotion
                                                ? { opacity: 0, transition: { duration: 0.1 } }
                                                : { opacity: 0, y: -6, transition: { duration: 0.14, ease: "easeIn" } }
                                        }
                                        className="space-y-6 px-6 py-6 sm:px-8"
                                    >
                                    {normalizedActiveTab === "general" ? (
                                        <GeneralTab
                                            userPreferences={userPreferences}
                                            preferencesSaving={preferencesSaving}
                                            onToggleSuggestionsEnabled={onToggleSuggestionsEnabled}
                                            onToggleMessageTokenUsage={onToggleMessageTokenUsage}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "personalization" ? (
                                        <PersonalizationTab
                                            userPreferences={userPreferences}
                                            preferencesSaving={preferencesSaving}
                                            onToggleSearchPastConvs={onToggleSearchPastConvs}
                                            onToggleUseMemory={onToggleUseMemory}
                                            onOpenMemories={() => setActiveTab("memories")}
                                            onOpenCustomInstructions={() => setShowCustomInstructions(true)}
                                            onSelectPersonality={onSelectPersonality}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "voice" ? (
                                        <VoiceTab
                                            user={user}
                                            userPreferences={userPreferences}
                                            preferencesSaving={preferencesSaving}
                                            onSelectVoiceModeVoice={onSelectVoiceModeVoice}
                                            onSelectVoiceModeLanguage={onSelectVoiceModeLanguage}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "security" ? (
                                        <SecurityTab onLogout={onLogout} />
                                    ) : null}

                                    {normalizedActiveTab === "account" ? (
                                        <AccountTab user={user} userPreferences={userPreferences} />
                                    ) : null}

                                    {normalizedActiveTab === "data-controls" ? (
                                        <DataControlsTab
                                            archivedConversations={archivedConversations}
                                            archivedConversationsLoading={archivedConversationsLoading}
                                            archivedConversationsHasMore={archivedConversationsHasMore}
                                            onLoadMoreArchivedConversations={onLoadMoreArchivedConversations}
                                            onSelectArchivedConversation={onSelectArchivedConversation}
                                            onUnarchiveConversation={onUnarchiveConversation}
                                            sharedConversations={sharedConversations}
                                            sharedConversationsLoading={sharedConversationsLoading}
                                            sharedConversationsHasMore={sharedConversationsHasMore}
                                            onLoadMoreSharedConversations={onLoadMoreSharedConversations}
                                            onSelectSharedConversation={onSelectSharedConversation}
                                            onRevokeSharedConversation={onRevokeSharedConversation}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "mcp" ? (
                                        <McpServersTab availableTools={availableTools} />
                                    ) : null}

                                    {normalizedActiveTab === "agents" ? (
                                        <AgentsTab agents={agents} />
                                    ) : null}

                                    {normalizedActiveTab === "skills" ? (
                                        <SkillsTab
                                            availableSkills={availableSkills}
                                            mySkills={mySkills}
                                            loadingMySkills={loadingMySkills}
                                            mySkillDetails={mySkillDetails}
                                            isMySkillDetailLoading={isMySkillDetailLoading}
                                            onLoadMySkillDetail={onLoadMySkillDetail}
                                            onRefreshMySkills={onRefreshMySkills}
                                            onAddGlobalSkillToPool={onAddGlobalSkillToPool}
                                            onCreateCustomSkill={onCreateCustomSkill}
                                            onRemoveSkillFromPool={onRemoveSkillFromPool}
                                            agents={agents}
                                            skillSelections={skillSelections}
                                            onLoadAgentSkills={onLoadAgentSkills}
                                            onToggleUserAgentSkill={onToggleUserAgentSkill}
                                            isAgentSkillLoading={isAgentSkillLoading}
                                            isSkillToggling={isSkillToggling}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "memories" && memoryInspector ? (
                                        <MemoriesTab agents={agents} {...memoryInspector} />
                                    ) : null}

                                    {normalizedActiveTab === "usage" ? (
                                        <UsageTab
                                            summary={usage.summary}
                                            loading={usage.loading}
                                            error={usage.error}
                                            onRefresh={usage.refresh}
                                            conversationUsage={conversationUsage}
                                            conversationTitle={conversationTitle}
                                        />
                                    ) : null}

                                    {stub ? (
                                        <ComingSoon
                                            icon={stub.icon}
                                            title={stub.title}
                                            description={stub.description}
                                            notes={stub.notes}
                                        />
                                    ) : null}
                                    </motion.div>
                                </AnimatePresence>
                        </ScrollArea>
                    </div>
                </div>
        </PremiumModalShell>
        <CustomInstructionsDialog
            open={showCustomInstructions}
            onClose={() => setShowCustomInstructions(false)}
            value={normalizeCustomInstructions(userPreferences?.customInstructions)}
            saving={preferencesSaving}
            onSave={onSaveCustomInstructions}
        />
        </>
    );
}
