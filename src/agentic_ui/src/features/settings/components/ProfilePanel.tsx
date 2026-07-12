import { X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { safeText } from "@/shared/lib/utils";
import { NA, type RealtimeVoice, type VoiceModeLanguage } from "@/shared/lib/consts";
import { Agent, ConversationShareListItem, ConversationSummary, CustomSkillCreatePayload, Skill, ToolMetadata, UserAgentSkillSelection, UserPreferences, UserProfile, UserSkill, UserSkillDetail } from "@/shared/lib/types";
import ProfileSidebar, { NAV_ITEMS } from "./profile_parts/ProfileSidebar";
import AccountTab from "./profile_parts/AccountTab";
import PersonalizationTab from "./profile_parts/PersonalizationTab";
import DataControlsTab from "./profile_parts/DataControlsTab";
import McpServersTab from "./profile_parts/McpServersTab";
import SkillsTab from "./profile_parts/SkillsTab";
import MemoriesTab from "./profile_parts/MemoriesTab";
import ShortcutsTab from "./profile_parts/ShortcutsTab";
import HelpTab from "./profile_parts/HelpTab";
import type { MemoriesHandlers } from "@/features/settings/hooks/useMemories";

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
    onToggleToolPreference?: (tool: ToolMetadata) => void;
    onToggleSuggestionsEnabled?: () => void;
    onToggleMessageTokenUsage?: () => void;
    onToggleSearchPastConvs?: () => void;
    onToggleUseMemory?: () => void;
    onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
    onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
    preferencesSaving?: boolean;
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
    onToggleToolPreference,
    onToggleSuggestionsEnabled,
    onToggleMessageTokenUsage,
    onToggleSearchPastConvs,
    onToggleUseMemory,
    onSelectVoiceModeVoice,
    onSelectVoiceModeLanguage,
    preferencesSaving = false,
}: ProfilePanelProps) {
    const displayName =
        safeText(user?.displayName) !== NA
            ? safeText(user?.displayName)
            : safeText(user?.fullName) !== NA
              ? safeText(user?.fullName)
              : safeText(user?.username);
    const normalizedActiveTab = NAV_ITEMS.some((item) => item.id === activeTab) ? activeTab : "profile";

    const sectionMeta: Record<string, { eyebrow?: string; title: string; description: string }> = {
        profile: {
            title: "Account",
            description: "Review your identity, workspace role, and recent account activity.",
        },
        appearance: {
            title: "Personalization",
            description: "Adjust how the workspace feels and which default experience is visible to you.",
        },
        archived: {
            title: "Data Controls",
            description: "Manage archived conversations and understand how history behaves in the workspace.",
        },
        mcp: {
            title: "MCP Servers",
            description: "Choose which MCP-powered tools stay available inside conversations.",
        },
        skills: {
            title: "Skills",
            description: "Your pool and the shared catalog.",
        },
        memories: {
            title: "Memories",
            description: "Review and delete what each deep agent remembers about you.",
        },
        shortcuts: {
            title: "Keyboard Shortcuts",
            description: "Browse the same shortcut registry the UI runtime uses.",
        },
        help: {
            title: "Help & Resources",
            description: "Open product documentation and support entry points.",
        },
    };

    // Fall back to the profile section if a nav item ever lacks a meta entry,
    // so a missing key degrades gracefully instead of crashing the panel.
    const activeSection = sectionMeta[normalizedActiveTab] ?? sectionMeta.profile;
    const showActiveSectionEyebrow =
        Boolean(activeSection.eyebrow)
        && activeSection.eyebrow.trim().toLowerCase() !== activeSection.title.trim().toLowerCase();

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center px-4 py-6">
            <div
                className="absolute inset-0 bg-black/65 backdrop-blur-sm animate-in fade-in-0 duration-200"
                onClick={onClose}
            />

            <div className="relative z-10 w-full max-w-5xl animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
                <Card className="relative flex h-[min(44rem,88vh)] w-full overflow-hidden rounded-[30px] border border-border/60 bg-card/95 text-foreground shadow-[0_32px_90px_-36px_rgba(15,23,42,0.65)] backdrop-blur-xl">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Close profile panel"
                        onClick={onClose}
                        className="absolute right-4 top-4 z-20 h-9 w-9 rounded-full text-muted-foreground transition hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0 focus-visible:outline-none"
                    >
                        <X size={18} />
                    </Button>

                    <div className="flex h-full w-full min-w-0 max-[639px]:flex-col">
                        <ProfileSidebar
                            normalizedActiveTab={normalizedActiveTab}
                            setActiveTab={setActiveTab}
                            onLogout={onLogout}
                        />

                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            <div className="border-b border-border/60 px-6 py-5 sm:px-8 max-[639px]:px-4 max-[639px]:py-3">
                                {showActiveSectionEyebrow ? (
                                    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.18em]">
                                        {activeSection.eyebrow}
                                    </p>
                                ) : null}
                                <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between max-[639px]:gap-2">
                                    <div className="space-y-1">
                                        <h2 className="text-2xl font-semibold tracking-tight text-foreground max-[639px]:text-xl">
                                            {activeSection.title}
                                        </h2>
                                        <p className="max-w-2xl text-sm text-muted-foreground max-[639px]:text-xs">
                                            {activeSection.description}
                                        </p>
                                    </div>
                                    <div className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-full border border-emerald-500/20 bg-background/70 px-2.5 py-1 text-xs font-medium text-muted-foreground sm:max-w-xs max-[639px]:gap-1.5 max-[639px]:px-2 max-[639px]:py-0.5 max-[639px]:text-[0.68rem]">
                                        <span className="flex h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)] max-[639px]:h-1.5 max-[639px]:w-1.5" aria-hidden="true" />
                                        <span className="min-w-0 truncate">
                                            <span className="text-emerald-600 dark:text-emerald-400">Signed in</span>
                                            <span className="text-muted-foreground"> as </span>
                                            <span className="font-medium text-foreground">{displayName}</span>
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <ScrollArea className="h-full w-full">
                                <div className="space-y-6 px-6 py-6 sm:px-8">
                                    {normalizedActiveTab === "profile" ? (
                                        <AccountTab user={user} userPreferences={userPreferences} />
                                    ) : null}

                                    {normalizedActiveTab === "appearance" ? (
                                        <PersonalizationTab
                                            user={user}
                                            userPreferences={userPreferences}
                                            preferencesSaving={preferencesSaving}
                                            onToggleSuggestionsEnabled={onToggleSuggestionsEnabled}
                                            onToggleMessageTokenUsage={onToggleMessageTokenUsage}
                                            onToggleSearchPastConvs={onToggleSearchPastConvs}
                                            onToggleUseMemory={onToggleUseMemory}
                                            onSelectVoiceModeVoice={onSelectVoiceModeVoice}
                                            onSelectVoiceModeLanguage={onSelectVoiceModeLanguage}
                                        />
                                    ) : null}

                                    {normalizedActiveTab === "archived" ? (
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
                                        <McpServersTab
                                            availableTools={availableTools}
                                            userPreferences={userPreferences}
                                            preferencesSaving={preferencesSaving}
                                            onToggleToolPreference={onToggleToolPreference}
                                        />
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

                                    {normalizedActiveTab === "shortcuts" ? <ShortcutsTab /> : null}

                                    {normalizedActiveTab === "help" ? (
                                        <HelpTab
                                            archivedConversations={archivedConversations}
                                            availableTools={availableTools}
                                            userPreferences={userPreferences}
                                        />
                                    ) : null}
                                </div>
                            </ScrollArea>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
