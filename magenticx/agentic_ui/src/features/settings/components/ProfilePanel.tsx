import { useEffect, useMemo, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Bell, HardDrive, Puzzle, Shield, type LucideProps } from "lucide-react";

import { PanelHeaderContext, type PanelHeader } from "@/features/settings/panel-header-context";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import { usePanelMotion } from "@/shared/lib/motion/panels";
import { normalizeCustomInstructions } from "@/shared/lib/utils";
import {
  type PersonalityId,
  type RealtimeVoice,
  type VoiceModeLanguage,
} from "@/shared/lib/consts";
import {
  Agent,
  ConversationShareListItem,
  ConversationSummary,
  CustomInstructions,
  CustomSkillCreatePayload,
  ToolMetadata,
  UserAgentSkillSelection,
  UserPreferences,
  UserProfile,
  UserSkill,
  UserSkillDetail,
} from "@/shared/lib/types";
import ProfileSidebar from "./profile_parts/ProfileSidebar";
import { resolveSettingsTab } from "@/features/settings/lib/settingsTabs";
import AccountTab from "./profile_parts/AccountTab";
import GeneralTab from "./profile_parts/GeneralTab";
import PersonalizationTab from "./profile_parts/PersonalizationTab";
import VoiceTab from "./profile_parts/VoiceTab";
import SecurityTab from "./profile_parts/SecurityTab";
import DataControlsTab from "./profile_parts/DataControlsTab";
import McpServersTab from "./profile_parts/McpServersTab";
import SkillsTab from "./profile_parts/SkillsTab";
import UsageTab from "./profile_parts/UsageTab";
import { PanelHeaderAction } from "./PanelHeaderAction";
import ComingSoon from "./profile_parts/ComingSoon";
import CustomInstructionsDialog from "./profile_parts/CustomInstructionsDialog";
import { useUsageSummary } from "@/features/settings/hooks/useUsageSummary";

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
  skills: {
    title: "Skills",
    description: "Your pool and the shared catalog.",
  },
  mcp: {
    title: "MCP Servers",
    description: "Choose which MCP-powered tools stay available inside conversations.",
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
  // User pool ("My skills"): the user's personal registry — remote skills
  // added from the catalogue search + customs (user-authored). The catalogue
  // itself is a server-side search the Skills tab runs on its own.
  mySkills?: UserSkill[];
  loadingMySkills?: boolean;
  mySkillDetails?: Record<string, UserSkillDetail>;
  isMySkillDetailLoading?: (skillName: string) => boolean;
  onLoadMySkillDetail?: (skillName: string) => Promise<void>;
  onAddRemoteSkillToPool?: (sourceId: string, skillId: string) => Promise<boolean>;
  onCreateCustomSkill?: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
  onRemoveSkillFromPool?: (skillName: string) => Promise<void>;
  onRefreshMySkills?: () => Promise<void>;
  // Manage-per-agent skill selection. The Skills tab "Manage" sub-view
  // renders one card per deep agent; ``skillSelections`` is the per-agent
  // enabled set keyed by ``agentId``. The hook lazy-loads selection when
  // the user expands an agent card via ``onLoadAgentSkills``.
  agents?: Agent[];
  /** Usage's "Manage in Agents": closes Settings and opens the Agents section. */
  onManageAgents?: () => void;
  skillSelections?: UserAgentSkillSelection;
  onLoadAgentSkills?: (agentId: string) => Promise<void>;
  onToggleUserAgentSkill?: (agentId: string, skillName: string) => Promise<void>;
  isAgentSkillLoading?: (agentId: string) => boolean;
  isSkillToggling?: (agentId: string, skillName: string) => boolean;
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
  onToggleImproveModel?: () => void;
  onSelectPersonality?: (personality: PersonalityId) => void;
  /** Persists the custom-instructions document; resolves true on success. */
  onSaveCustomInstructions?: (value: CustomInstructions) => Promise<boolean>;
  onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
  onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
  preferencesSaving?: boolean;
  // Usage tab — the conversation open in the chat (null when none), for the
  // Overview's shortcut straight to its analysis; the data is fetched there.
  conversationId?: string | null;
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
  mySkills,
  loadingMySkills = false,
  mySkillDetails,
  isMySkillDetailLoading,
  onLoadMySkillDetail,
  onAddRemoteSkillToPool,
  onCreateCustomSkill,
  onRemoveSkillFromPool,
  onRefreshMySkills,
  onManageAgents,
  agents,
  skillSelections,
  onLoadAgentSkills,
  onToggleUserAgentSkill,
  isAgentSkillLoading,
  isSkillToggling,
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
  onToggleImproveModel,
  onSelectPersonality,
  onSaveCustomInstructions,
  onSelectVoiceModeVoice,
  onSelectVoiceModeLanguage,
  preferencesSaving = false,
  conversationId = null,
  conversationTitle = null,
}: ProfilePanelProps) {
  const { swap } = usePanelMotion();
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
  // A stored or linked tab id that is no longer a section (renamed, or Agents,
  // which left Settings) opens the section it became, or General.
  const normalizedActiveTab = resolveSettingsTab(activeTab);

  // Workspace usage rollup — fetched lazily the first time the Usage tab is
  // opened, cached (with a short TTL) across tab switches and panel closes.
  const usage = useUsageSummary(user?.id ?? null, open && normalizedActiveTab === "usage");

  // Fall back to the General section if a nav item ever lacks a meta entry,
  // so a missing key degrades gracefully instead of crashing the panel.
  const activeSection = SECTION_META[normalizedActiveTab] ?? SECTION_META.general;
  // A tab on an inner page publishes its own header; otherwise the section's
  // static metadata stands. One header either way — never two stacked.
  const [panelHeader, setPanelHeader] = useState<PanelHeader | null>(null);
  const panelHeaderStore = useMemo(() => ({ setHeader: setPanelHeader }), []);
  const headerTitle = panelHeader?.title ?? activeSection.title;
  const headerDescription = panelHeader ? panelHeader.description : activeSection.description;
  const headerEyebrow = panelHeader ? panelHeader.eyebrow : activeSection.eyebrow;
  // Bound once so the compiler can narrow it — `Boolean(x) && x.trim()` reads
  // fine but does not tell TypeScript that `x` is defined in the second operand.
  // Suppress an eyebrow that only restates the title — it reads as a stutter.
  const showHeaderEyebrow =
    Boolean(headerEyebrow?.trim()) &&
    headerEyebrow!.trim().toLowerCase() !== headerTitle.trim().toLowerCase();

  const stub = STUB_SECTIONS[normalizedActiveTab];

  // No early return when closed: the shell plays its exit with the last content.

  return (
    <>
      <PremiumModalShell
        open={open}
        onClose={onClose}
        closeLabel="Close profile panel"
        className="max-w-5xl"
      >
        <div className="flex h-[min(44rem,88vh)] w-full min-w-0 max-[639px]:flex-col">
          <ProfileSidebar normalizedActiveTab={normalizedActiveTab} setActiveTab={setActiveTab} />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="border-b border-white/10 px-6 py-5 pr-16 sm:px-8 sm:pr-16 max-[639px]:px-4 max-[639px]:py-3 max-[639px]:pr-12">
              {showHeaderEyebrow ? (
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45 max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.16em]">
                  {headerEyebrow}
                </p>
              ) : null}
              <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between max-[639px]:gap-2">
                {/* Keyed by the page, not just the tab, so stepping into an
                    inner screen re-runs the entrance the same way a tab switch
                    does — the header is the only thing that changes, so it has
                    to read as a change.

                    Wrapped in AnimatePresence because without it the outgoing
                    title is unmounted the instant the key changes: the old text
                    vanishes, then the new one fades in. `mode="wait"` gives it a
                    real exit, so one title hands over to the next. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={`${normalizedActiveTab}:${headerTitle}`}
                    {...swap}
                    className="min-w-0 space-y-1"
                  >
                    {panelHeader?.onBack ? (
                      <button
                        type="button"
                        onClick={panelHeader.onBack}
                        className="-ml-1.5 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-white/50 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                      >
                        <ArrowLeft size={13} aria-hidden />
                        {panelHeader.backLabel ?? activeSection.title}
                      </button>
                    ) : null}
                    <h2 className="text-2xl font-semibold leading-tight tracking-tight text-white md:text-[2rem] max-[639px]:text-xl">
                      {headerTitle}
                    </h2>
                    {headerDescription ? (
                      <p className="max-w-2xl text-sm text-white/55 max-[639px]:text-xs">
                        {headerDescription}
                      </p>
                    ) : null}
                  </motion.div>
                </AnimatePresence>

                {panelHeader?.action ? <PanelHeaderAction action={panelHeader.action} /> : null}
              </div>
            </div>

            <PanelHeaderContext.Provider value={panelHeaderStore}>
              <ScrollArea className="h-full w-full">
                {/* Animated section swap: outgoing content fades down-out,
                                    incoming rises in (mode="wait" keeps them sequential). */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={normalizedActiveTab}
                    {...swap}
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
                        // Memories moved to each agent's page (Agents → an agent → Memory).
                        onOpenMemories={onManageAgents ?? onClose}
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
                        improveModel={userPreferences?.improveModel === true}
                        onToggleImproveModel={onToggleImproveModel}
                        preferencesSaving={preferencesSaving}
                        userId={user?.id ?? null}
                      />
                    ) : null}

                    {normalizedActiveTab === "mcp" ? (
                      <McpServersTab availableTools={availableTools} />
                    ) : null}

                    {normalizedActiveTab === "skills" ? (
                      <SkillsTab
                        mySkills={mySkills}
                        loadingMySkills={loadingMySkills}
                        mySkillDetails={mySkillDetails}
                        isMySkillDetailLoading={isMySkillDetailLoading}
                        onLoadMySkillDetail={onLoadMySkillDetail}
                        onAddRemoteSkillToPool={onAddRemoteSkillToPool}
                        onCreateCustomSkill={onCreateCustomSkill}
                        onRemoveSkillFromPool={onRemoveSkillFromPool}
                        onRefreshMySkills={onRefreshMySkills ?? (async () => {})}
                        agents={agents}
                        skillSelections={skillSelections}
                        onLoadAgentSkills={onLoadAgentSkills}
                        onToggleUserAgentSkill={onToggleUserAgentSkill}
                        isAgentSkillLoading={isAgentSkillLoading}
                        isSkillToggling={isSkillToggling}
                      />
                    ) : null}

                    {normalizedActiveTab === "usage" ? (
                      <UsageTab
                        userId={user?.id ?? null}
                        summary={usage.summary}
                        loading={usage.loading}
                        error={usage.error}
                        onRefresh={usage.refresh}
                        openConversation={conversationId ? { id: conversationId, title: conversationTitle } : null}
                        agents={agents ?? []}
                        onClosePanel={onClose}
                        onManageAgents={onManageAgents ?? onClose}
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
            </PanelHeaderContext.Provider>
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
