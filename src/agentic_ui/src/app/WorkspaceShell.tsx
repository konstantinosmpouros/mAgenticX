import { type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { X } from "lucide-react";

import { useChatWorkspace, type ChatWorkspaceOptions } from "@/app/useChatWorkspace";
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
import ProfilePanel from "@/features/settings/components/ProfilePanel";
import ShortcutsPanel from "@/features/settings/components/ShortcutsPanel";
import ShareConversationDialog from "@/features/sharing/components/SharePanel";

import ChatView from "@/pages/ChatView";

import { OVERLAY_HOST_ID } from "@/shared/lib/overlay-host";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { Loader } from "@/shared/ui/shadcn-io/loader";
import { SidebarProvider, SidebarInset } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

type WorkspaceShellProps = ChatWorkspaceOptions & { children?: ReactNode };

/**
 * The persistent workspace shell — sidebar, search, profile/dialog modals, and
 * the chrome around the routed views. Builds the workspace once via
 * useChatWorkspace and provides it; renders `children` (the direct
 * shared-conversation path) or `<Outlet/>` (the layout-route children
 * ChatView/TasksView) in the content slot.
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
    isInterruptResolved,
    activeProfileTab,
    handleSetActiveProfileTab,
    handleLogout,
    availableTools,
    availableSkills,
    mySkills,
    loadingMySkills,
    mySkillDetails,
    loadingSkillDetail,
    ensureSkillDetail,
    handleAddGlobalSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
    myAgents,
    busyAgentId,
    getAgentDefinition,
    validateAgent,
    handleCreateAgent,
    handleUpdateAgent,
    handleDeleteAgent,
    skillSelections,
    loadAgentSkills,
    toggleUserAgentSkill,
    isAgentSkillLoading,
    isSkillToggling,
    memoryInspector,
    conversationUsage,
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
    // Main chat interface with sidebar, header, conversation container, and input area
    <div className="min-h-svh max-h-svh bg-background dark:bg-gradient-to-br dark:from-slate-950/20 dark:via-slate-700/30 dark:to-slate-950/20">
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
          onReportConversation={handleReportConversationFromSidebar}
          onLoadMore={handleLoadMoreConversations}
          onTitleClick={handleTitleClick}
          onNewChat={handleNewChat}
          onOpenSearch={handleOpenSearch}
          onVoiceMode={triggerVoiceMode}
          onOpenScheduledTasks={() => navigate("/tasks")}
          scheduledTasksRunningCount={scheduledTasks.runningCount}
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
        <SidebarInset className="bg-transparent">
          <TooltipProvider>
            <HitlProvider value={{ resumeRun: resumeInferenceRunHandler, isInterruptResolved }}>
              <div
                id={OVERLAY_HOST_ID}
                className="animate-fade-in flex min-h-svh max-h-svh flex-col relative overflow-hidden transition-slow"
              >
                {/* The routed view: ChatView ("/", "/c/:id") or TasksView ("/tasks"),
                  or `children` when ChatShell is used directly (shared conversation).
                  The chat surface + tasks page now live in pages/ChatView and
                  pages/TasksView. */}
                <ChatWorkspaceProvider value={ws}>{children ?? <Outlet />}</ChatWorkspaceProvider>

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
                  availableSkills={availableSkills}
                  mySkills={mySkills}
                  loadingMySkills={loadingMySkills}
                  mySkillDetails={mySkillDetails}
                  isMySkillDetailLoading={loadingSkillDetail}
                  onLoadMySkillDetail={ensureSkillDetail}
                  onAddGlobalSkillToPool={handleAddGlobalSkill}
                  onCreateCustomSkill={handleCreateCustomSkill}
                  onRemoveSkillFromPool={handleRemoveSkillFromPool}
                  myAgents={myAgents}
                  busyAgentId={busyAgentId}
                  onCreateAgent={handleCreateAgent}
                  onUpdateAgent={handleUpdateAgent}
                  onDeleteAgent={handleDeleteAgent}
                  onValidateAgent={validateAgent}
                  onLoadAgentDefinition={getAgentDefinition}
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
                  onSelectPersonality={handleSelectPersonality}
                  onSaveCustomInstructions={handleSaveCustomInstructions}
                  onSelectVoiceModeVoice={handleSelectVoiceModeVoice}
                  onSelectVoiceModeLanguage={handleSelectVoiceModeLanguage}
                  preferencesSaving={isSavingPreferences}
                  conversationUsage={currentConversation ? conversationUsage : null}
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

                {/* Image Preview Modal */}
                {attachmentPreview.selectedImage && (
                  <div
                    className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={handleCloseImagePreview}
                  >
                    <div className="relative w-full h-full flex items-center justify-center">
                      <button
                        onClick={handleCloseImagePreview}
                        className="absolute top-4 right-4 z-10 text-white hover:text-gray-300 transition-colors bg-black/50 rounded-full p-2"
                      >
                        <X size={24} />
                      </button>
                      <img
                        src={attachmentPreview.selectedImage}
                        alt="Full preview"
                        className="max-w-[95vw] max-h-[95vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                )}
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
