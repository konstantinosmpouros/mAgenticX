import { type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation, useOutlet } from "react-router-dom";

import { useChatWorkspace, type ChatWorkspaceOptions } from "@/app/useChatWorkspace";
import { useIncognitoCard } from "@/app/useIncognitoCard";
import { ChatWorkspaceProvider } from "@/app/workspaceContext";

import SwitchingAccounts from "@/features/auth/components/SwitchingAccounts";
import AccountLimitDialog from "@/features/auth/components/AccountLimitDialog";
import AttachmentPreviewPanel from "@/features/attachments/components/AttachmentPreviewPanel";
import ChatSidebar from "@/features/chat/components/ChatSidebar";
import { useSidebarInteractionEffect } from "@/features/chat/hooks/useChatEffects";
import { useChatKeyboardShortcuts } from "@/features/chat/hooks/useKeyboardShortcuts";
import { HitlProvider } from "@/features/inference";
import ReportConversationDialog from "@/features/reporting/components/ReportPanel";
import SearchPanel from "@/features/search/components/SearchPanel";
import EditProfileDialog from "@/features/settings/components/EditProfileDialog";
import HelpPanel from "@/features/settings/components/HelpPanel";
import { PendingDeletionScreen } from "@/features/settings/components/PendingDeletionScreen";
import ProfilePanel from "@/features/settings/components/ProfilePanel";
import ShortcutsPanel from "@/features/settings/components/ShortcutsPanel";
import ShareConversationDialog from "@/features/sharing/components/SharePanel";

import { AGENTS_PATH, isAgentsPath } from "@/features/agents/lib/routes";

import ChatView from "@/pages/ChatView";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";

import { OVERLAY_HOST_ID } from "@/shared/lib/overlay-host";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { Loader } from "@/shared/ui/shadcn-io/loader";
import { SidebarProvider, SidebarInset } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

type WorkspaceShellProps = ChatWorkspaceOptions & { children?: ReactNode };

/** How long the leaving view stays for the swap: the chat holds under the
 *  Schedules or Agents page until it has fully faded in (their PAGE). */
const ROUTE_SWAP_HOLD_S = 0.42;

/**
 * The persistent workspace shell — sidebar, search, profile/dialog modals, and
 * the chrome around the routed views. Builds the workspace once via
 * useChatWorkspace and provides it; renders `children` (the direct
 * shared-conversation path) or `<Outlet/>` (the layout-route children
 * ChatView/TasksView/AgentsView) in the content slot.
 */
export function WorkspaceShell({ children, ...props }: WorkspaceShellProps = {}) {
  const ws = useChatWorkspace(props);
  // The bundle reaches the route views through ChatWorkspaceProvider at the
  // content slot below. It used to be published into the Zustand store here,
  // during render — zustand notifies synchronously, so that force-updated
  // ChatView/TasksView from inside this component's render pass (React's
  // "Cannot update a component while rendering a different component"), and the
  // deferred re-render cost a second commit on every keystroke.
  const {
    authResolved,
    isLoggedIn,
    userId,
    sidebarOpen,
    handleSidebarOpenChange,
    canTogglePrivateMode,
    handleOpenSearch,
    composer,
    triggerVoiceMode,
    openAgentPicker,
    handleTogglePrivateMode,
    openProfilePanel,
    closeProfilePanel,
    openShortcutsPanel,
    handleNewChat,
    dismissActiveUi,
    conversations,
    handleConversationSelect,
    handleDeleteConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleToggleConversationPin,
    handleReportConversationFromSidebar,
    handleLoadMoreConversations,
    handleTitleClick,
    navigate,
    scheduledTasks,
    userProfile,
    settingsPanels,
    attachmentPreview,
    overlayMenus,
    sharePanel,
    reportPanel,
    convIsLoadingMore,
    conversationsLoading,
    convHasMore,
    isSearchOpen,
    searchQuery,
    searchResults,
    defaultSearchResults,
    searchLoading,
    searchError,
    setSearchQuery,
    closeSearchPanel,
    handleSearchResultSelect,
    resumeInferenceRunHandler,
    isDecisionInFlight,
    activeProfileTab,
    handleSetActiveProfileTab,
    handleLogout,
    availableTools,
    mySkills,
    loadingMySkills,
    mySkillDetails,
    loadingSkillDetail,
    ensureSkillDetail,
    handleAddRemoteSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
    refreshMySkills,
    skillSelections,
    loadAgentSkills,
    toggleUserAgentSkill,
    isAgentSkillLoading,
    isSkillToggling,
    memoryInspector,
    resolvedPreferences,
    archivedConversations,
    archivedConvIsLoading,
    archivedConvHasMore,
    handleLoadMoreArchivedConversations,
    handleOpenArchivedConversation,
    handleUnarchiveConversation,
    sharedConversations,
    sharedConvIsLoading,
    sharedConvHasMore,
    handleLoadMoreSharedConversations,
    handleOpenSharedConversation,
    handleRevokeSharedConversation,
    handleToggleSuggestionsEnabled,
    handleToggleShowMessageTokenUsage,
    handleToggleSearchPastConvs,
    handleToggleUseMemory,
    handleToggleImproveModel,
    handleSelectPersonality,
    handleSaveCustomInstructions,
    handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage,
    isSavingPreferences,
    closeReportDialog,
    accountSwitching,
    handleSubmitConversationReport,
    handleShareModeChange,
    handleShareExpiresAtChange,
    closeShareDialog,
    copyShareDialogUrl,
    handleCreateShareLink,
    handleDownloadSharePdf,
    handleFileDownload,
    handleCloseImagePreview,
  } = ws;

  // Store-backed, read directly rather than through the bundle.
  const agents = useWorkspaceStore((s) => s.agents);
  const currentConversation = useWorkspaceStore((s) => s.currentConversation);
  const pendingDeletion = useWorkspaceStore((s) => s.pendingDeletion);
  // A private chat (open, or being written) turns the card incognito — on the
  // chat routes only: the private flag can outlive a visit to a page.
  const isPrivateMode = useWorkspaceStore((s) => s.isPrivateMode);
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const isTasksPage = pathname.startsWith("/tasks");
  const isAgentsPage = isAgentsPath(pathname);
  const incognitoClass = useIncognitoCard(isPrivateMode && !isTasksPage && !isAgentsPage);
  // The route view's surface: the chat, or one of the pages over it. Moving
  // within a surface (chat to chat, agent to agent) never remounts it.
  const surfaceKey = isTasksPage ? "tasks" : isAgentsPage ? "agents" : "chat";
  // Main Chat Interface
  if (!authResolved) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Loader />
      </div>
    );
  }
  if (!isLoggedIn || !userId) {
    return null;
  }
  // The account awaits deletion (plan 32): its session is frozen, so render only
  // the pending screen — no workspace is mounted, and nothing in it can call out.
  if (pendingDeletion) {
    return (
      <PendingDeletionScreen userId={userId} pending={pendingDeletion} onLogout={handleLogout} />
    );
  }
  // Swapping the active account: render ONLY the interstitial. Returning here
  // unmounts the entire workspace tree, which is the real safety mechanism —
  // with nothing mounted, a late response from the account being left has
  // nowhere to land and cannot be painted under the new identity.
  const { accountSwitch } = accountSwitching;
  if (accountSwitch?.active) {
    return (
      <SwitchingAccounts
        detail={accountSwitch.detail}
        error={accountSwitch.error}
        onRetry={accountSwitch.error ? () => navigate("/login", { replace: true }) : undefined}
      />
    );
  }
  return (
    // Main chat interface: the sidebar sits on a tinted frame, and the
    // conversation area floats beside it as a rounded card (full-bleed on mobile).
    <div className="min-h-svh max-h-svh bg-muted/70 dark:bg-black/60">
      <SidebarProvider
        className="min-h-svh"
        open={sidebarOpen}
        onOpenChange={handleSidebarOpenChange}
        enableKeyboardShortcut={false}
        keyboardShortcutsHook={useChatKeyboardShortcuts}
        chatKeyboardShortcuts={{
          canTogglePrivateMode,
          openSearch: handleOpenSearch,
          focusComposer: composer.focusComposer,
          openAttachments: composer.openAttachments,
          startDictation: composer.startDictation,
          triggerVoiceMode,
          openAgentPicker,
          togglePrivateMode: handleTogglePrivateMode,
          openProfilePanel,
          openShortcutsPanel,
          startNewChat: handleNewChat,
          dismissActiveUi,
        }}
      >
        <ChatSidebar
          accounts={accountSwitching.accounts}
          canAddAccount={accountSwitching.accountsMeta.canAddAccount}
          maxAccounts={accountSwitching.accountsMeta.maxAccounts}
          busyAccountId={accountSwitching.busyAccountId}
          onSelectAccount={accountSwitching.onSelectAccount}
          onAddAccount={accountSwitching.onAddAccount}
          onLogoutAccount={accountSwitching.onLogoutAccount}
          onLogoutAllAccounts={accountSwitching.onLogoutAllAccounts}
          conversations={conversations}
          currentConversationId={currentConversation?.id || null}
          onSelectConversation={handleConversationSelect}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onArchiveConversation={handleArchiveConversation}
          onTogglePinConversation={(conversation) => void handleToggleConversationPin(conversation)}
          onReportConversation={handleReportConversationFromSidebar}
          onLoadMore={handleLoadMoreConversations}
          onTitleClick={handleTitleClick}
          onNewChat={handleNewChat}
          onOpenSearch={handleOpenSearch}
          onVoiceMode={triggerVoiceMode}
          onOpenScheduledTasks={() => navigate("/tasks")}
          scheduledTasksRunningCount={scheduledTasks.runningCount}
          onOpenAgents={() => navigate(AGENTS_PATH)}
          activePage={isAgentsPage ? "agents" : isTasksPage ? "schedules" : null}
          onOpenSettings={(tab) => openProfilePanel(tab)}
          onEditProfile={settingsPanels.openEditProfile}
          onOpenShortcuts={openShortcutsPanel}
          onOpenHelp={settingsPanels.openHelpPanel}
          onLogout={handleLogout}
          userProfile={userProfile}
          dismissFloatingUiSignal={overlayMenus.sidebarDismissFloatingUiSignal}
          onFloatingUiStateChange={overlayMenus.setIsSidebarFloatingUiOpen}
          isLoadingMore={convIsLoadingMore}
          isInitialLoading={conversationsLoading}
          hasMore={convHasMore}
          sidebarInteractionHook={useSidebarInteractionEffect}
        />
        <SearchPanel
          open={isSearchOpen}
          query={searchQuery}
          results={searchResults}
          defaultResults={defaultSearchResults}
          loading={searchLoading}
          error={searchError}
          onQueryChange={setSearchQuery}
          onClose={closeSearchPanel}
          onSelectResult={handleSearchResultSelect}
        />
        <SidebarInset
          data-testid="chat-card"
          className={`overflow-hidden bg-background md:my-3 md:mr-3 md:h-[calc(100svh-1.5rem)] md:rounded-[1.75rem] md:border md:border-border/60 md:shadow-[0_12px_40px_-16px_rgba(0,0,0,0.35)] ${incognitoClass}`}
        >
          {/* The incognito card's breathing edge light (styles/private.css). */}
          <div aria-hidden="true" className="private-card-glow" />
          <TooltipProvider>
            <HitlProvider value={{ resumeRun: resumeInferenceRunHandler, isDecisionInFlight }}>
              {/* Fills the card on desktop (md:h-full) and the screen on mobile;
                  the overlays mounted here stay inside the card's rounded edge. */}
              <div
                id={OVERLAY_HOST_ID}
                className="animate-fade-in relative flex h-svh flex-col overflow-hidden transition-slow md:h-full"
              >
                {/* The routed view: ChatView ("/", "/c/:id"), TasksView ("/tasks")
                  or AgentsView ("/agents…"), or `children` when ChatShell is used
                  directly (shared conversation). */}
                <ChatWorkspaceProvider value={ws}>
                  {children ?? (
                    // Chat <-> Schedules <-> Agents: the view that leaves stays
                    // mounted for its exit (the page's own; the chat simply holds
                    // under a page sliding in), keyed by surface so moving between
                    // chats, or between Agents pages, never remounts. `contents`:
                    // the wrapper adds no box.
                    <AnimatePresence initial={false}>
                      <motion.div
                        key={surfaceKey}
                        className="contents"
                        exit={{ opacity: 1, transition: { duration: ROUTE_SWAP_HOLD_S } }}
                      >
                        {outlet}
                      </motion.div>
                    </AnimatePresence>
                  )}
                </ChatWorkspaceProvider>

                <AccountLimitDialog
                  open={accountSwitching.accountLimitOpen}
                  accounts={accountSwitching.accounts}
                  submitting={Boolean(accountSwitching.busyAccountId)}
                  onCancel={() => accountSwitching.setAccountLimitOpen(false)}
                  onConfirm={(account) => void accountSwitching.onConfirmAccountLimit(account)}
                />

                {/* User Profile Modal */}
                <ProfilePanel
                  open={settingsPanels.showUserProfile}
                  onClose={closeProfilePanel}
                  activeTab={activeProfileTab}
                  setActiveTab={handleSetActiveProfileTab}
                  onLogout={handleLogout}
                  user={userProfile}
                  availableTools={availableTools}
                  mySkills={mySkills}
                  loadingMySkills={loadingMySkills}
                  mySkillDetails={mySkillDetails}
                  isMySkillDetailLoading={loadingSkillDetail}
                  onLoadMySkillDetail={ensureSkillDetail}
                  onAddRemoteSkillToPool={handleAddRemoteSkill}
                  onCreateCustomSkill={handleCreateCustomSkill}
                  onRemoveSkillFromPool={handleRemoveSkillFromPool}
                  onRefreshMySkills={refreshMySkills}
                  onManageAgents={() => {
                    closeProfilePanel();
                    navigate(AGENTS_PATH);
                  }}
                  agents={agents}
                  skillSelections={skillSelections}
                  onLoadAgentSkills={loadAgentSkills}
                  onToggleUserAgentSkill={toggleUserAgentSkill}
                  isAgentSkillLoading={isAgentSkillLoading}
                  isSkillToggling={isSkillToggling}
                  memoryInspector={memoryInspector}
                  userPreferences={resolvedPreferences}
                  archivedConversations={archivedConversations}
                  archivedConversationsLoading={archivedConvIsLoading}
                  archivedConversationsHasMore={archivedConvHasMore}
                  onLoadMoreArchivedConversations={handleLoadMoreArchivedConversations}
                  onSelectArchivedConversation={handleOpenArchivedConversation}
                  onUnarchiveConversation={(conversation) =>
                    void handleUnarchiveConversation(conversation.id)
                  }
                  sharedConversations={sharedConversations}
                  sharedConversationsLoading={sharedConvIsLoading}
                  sharedConversationsHasMore={sharedConvHasMore}
                  onLoadMoreSharedConversations={handleLoadMoreSharedConversations}
                  onSelectSharedConversation={handleOpenSharedConversation}
                  onRevokeSharedConversation={handleRevokeSharedConversation}
                  onToggleSuggestionsEnabled={handleToggleSuggestionsEnabled}
                  onToggleMessageTokenUsage={handleToggleShowMessageTokenUsage}
                  onToggleSearchPastConvs={handleToggleSearchPastConvs}
                  onToggleUseMemory={handleToggleUseMemory}
                  onToggleImproveModel={handleToggleImproveModel}
                  onSelectPersonality={handleSelectPersonality}
                  onSaveCustomInstructions={handleSaveCustomInstructions}
                  onSelectVoiceModeVoice={handleSelectVoiceModeVoice}
                  onSelectVoiceModeLanguage={handleSelectVoiceModeLanguage}
                  preferencesSaving={isSavingPreferences}
                  conversationId={currentConversation?.id ?? null}
                  conversationTitle={currentConversation?.title ?? null}
                />

                {/* Edit profile — the small identity card from the profile menu */}
                <EditProfileDialog
                  open={settingsPanels.showEditProfile}
                  onClose={settingsPanels.closeEditProfile}
                  user={userProfile}
                />

                {/* Dedicated reference panels from the profile menu's Help submenu */}
                <ShortcutsPanel
                  open={settingsPanels.showShortcutsPanel}
                  onClose={settingsPanels.closeShortcutsPanel}
                />
                <HelpPanel
                  open={settingsPanels.showHelpPanel}
                  onClose={settingsPanels.closeHelpPanel}
                  archivedConversations={archivedConversations}
                  availableTools={availableTools}
                />

                <ReportConversationDialog
                  open={reportPanel.isReportDialogOpen}
                  onClose={closeReportDialog}
                  onSubmit={handleSubmitConversationReport}
                  submitting={reportPanel.isSubmittingReport}
                  messageId={reportPanel.reportTargetMessageId}
                  messagePreview={reportPanel.reportTargetMessagePreview}
                  conversationTitle={reportPanel.reportConversationTitle}
                />

                <ShareConversationDialog
                  open={Boolean(sharePanel.shareTargetMessage)}
                  title={currentConversation?.title}
                  message={sharePanel.shareTargetMessage}
                  creating={sharePanel.isCreatingShareLink}
                  exportingPdf={sharePanel.isExportingSharePdf}
                  linkCreated={Boolean(sharePanel.shareDialogUrl)}
                  copied={sharePanel.isShareCopyPulse}
                  shareMode={sharePanel.shareMode}
                  forceFullConversation={sharePanel.shareForceFullConversation}
                  expiresAt={sharePanel.shareExpiresAt}
                  onShareModeChange={handleShareModeChange}
                  onExpiresAtChange={handleShareExpiresAtChange}
                  onClose={closeShareDialog}
                  onCreateLink={
                    sharePanel.shareDialogUrl ? copyShareDialogUrl : handleCreateShareLink
                  }
                  onDownloadPdf={handleDownloadSharePdf}
                />

                <AttachmentPreviewPanel
                  preview={attachmentPreview.selectedFilePreview}
                  userId={userId}
                  conversationId={currentConversation?.id ?? null}
                  onClose={attachmentPreview.closeFilePreview}
                  onDownload={handleFileDownload}
                />

                <ImageLightbox
                  src={attachmentPreview.selectedImage}
                  onClose={handleCloseImagePreview}
                />
              </div>
            </HitlProvider>
          </TooltipProvider>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

/**
 * Full standalone workspace = the shell wrapping ChatView directly (no router
 * Outlet). Used by SharedConvPage to render a full shared conversation as a
 * single component with props. The routed app uses WorkspaceShell + <Outlet/>
 * instead.
 */
export function StandaloneWorkspace(props: ChatWorkspaceOptions = {}) {
  return (
    <WorkspaceShell {...props}>
      <ChatView />
    </WorkspaceShell>
  );
}
