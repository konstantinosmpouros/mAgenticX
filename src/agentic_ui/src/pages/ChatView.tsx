import { Textarea } from "@/shared/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import ChatHeader from "@/features/chat/components/ChatHeader";
import { ChatInputBar } from "@/features/chat/components/ChatInputBar";
import { PlanCard } from "@/features/chat/components/message_parts/PlanningContainer";
import { HitlInputTakeover } from "@/features/chat/components/HitlInputTakeover";
import { Loader } from "@/shared/ui/shadcn-io/loader";

import { useChatWorkspaceContext } from "@/app/workspaceContext";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * The conversation surface for routes "/" and "/c/:conversationId": header,
 * the voice/chat body transition shell, the composer, and the load overlay.
 * Pure presentation — all state/handlers come from the workspace context built
 * by ChatShell. Rendered via <Outlet/> (or directly as ChatShell children for
 * the shared-conversation path).
 */
export default function ChatView() {
  const {
    handleAgentChange,
    agentTriggerRef,
    overlayMenus,
    handleTogglePrivateMode,
    headerHasDivider,
    handleArchiveCurrentConversation,
    handleUnarchiveCurrentConversation,
    handleReportCurrentConversation,
    handleDeleteCurrentConversation,
    openFullConversationShareDialog,
    canShareFullConversation,
    handleNewChat,
    isCurrentConversationBusy,
    bodyTransition,
    renderConversationBody,
    voiceSession,
    voiceBarReady,
    chatBarReady,
    settledVoiceActive,
    thinkingState,
    composer,
    handleSendMessage,
    handleStopStreaming,
    handleImageClick,
    triggerVoiceMode,
    toast,
    inputBarAgent,
    isPlanExpanded,
    setIsPlanExpanded,
    activePlan,
    showPlanningCard,
    activeHitlInterrupt,
    activeConversationRun,
    pendingRunInterrupts,
    resumeInferenceRunHandler,
    canShowStarterSuggestions,
    handleStarterSuggestionSelect,
  } = useChatWorkspaceContext();

  // Read straight from the store rather than through the workspace bundle.
  // The bundle is one object rebuilt every render, so taking these from it
  // re-rendered this whole view on every keystroke and every streamed token.
  // A selector per value re-renders only when that value actually changes.
  const agents = useWorkspaceStore((s) => s.agents);
  const currentConversation = useWorkspaceStore((s) => s.currentConversation);
  const inactiveAgentFallback = useWorkspaceStore((s) => s.inactiveAgentFallback);
  const isPrivateMode = useWorkspaceStore((s) => s.isPrivateMode);
  const loadingConversation = useWorkspaceStore((s) => s.loadingConversation);
  const selectedAgent = useWorkspaceStore((s) => s.selectedAgent);
  const starterSuggestions = useWorkspaceStore((s) => s.starterSuggestions);

  return (
    <>
      {/* Header */}
      <ChatHeader
        agents={agents}
        inactiveAgent={inactiveAgentFallback}
        selectedAgent={selectedAgent}
        onAgentChange={handleAgentChange}
        agentTriggerRef={agentTriggerRef}
        agentPickerOpen={overlayMenus.isAgentPickerOpen}
        onAgentPickerOpenChange={overlayMenus.setIsAgentPickerOpen}
        showPrivateToggle={(currentConversation?.messages?.length ?? 0) === 0 || isPrivateMode}
        isPrivateMode={isPrivateMode}
        onTogglePrivate={handleTogglePrivateMode}
        showBottomBorder={headerHasDivider}
        showConversationActions={Boolean(currentConversation?.id)}
        isConversationArchived={Boolean(currentConversation?.isArchived)}
        isConversationReported={Boolean(currentConversation?.isReported)}
        conversationActionsOpen={overlayMenus.isHeaderActionMenuOpen}
        onConversationActionsOpenChange={overlayMenus.setIsHeaderActionMenuOpen}
        onArchiveConversation={handleArchiveCurrentConversation}
        onUnarchiveConversation={handleUnarchiveCurrentConversation}
        onReportConversation={handleReportCurrentConversation}
        onDeleteConversation={handleDeleteCurrentConversation}
        onShareConversation={openFullConversationShareDialog}
        canShareConversation={canShareFullConversation}
        onNewChat={handleNewChat}
        isStreaming={isCurrentConversationBusy}
      />

      {/* Region below the header — the positioning context (and flex column) for
          the body + composer. Making THIS the containing block for the absolutely
          positioned empty-state composer (instead of the whole shell, which
          includes the header) is what makes it structurally impossible for the
          centered greeting/composer to overlap the header and steal its clicks. */}
      <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* Chat Messages Container*/}
        <div className="voice-chat-transition-shell relative flex flex-1 min-h-0 overflow-hidden">
          {bodyTransition.exiting ? (
            <div
              className={`voice-chat-panel voice-chat-panel-${bodyTransition.exiting} voice-chat-panel-exit`}
              aria-hidden="true"
            >
              {renderConversationBody(bodyTransition.exiting)}
            </div>
          ) : null}
          <div
            className={`voice-chat-panel voice-chat-panel-${bodyTransition.current} voice-chat-panel-enter`}
          >
            {renderConversationBody(bodyTransition.current)}
          </div>
        </div>

        {/* Input Area */}
        <ChatInputBar
          mode={voiceSession.isActive ? "voice" : "chat"}
          voiceBarVisible={voiceBarReady}
          chatBarVisible={chatBarReady}
          // Centered empty state
          isMessagesEmpty={composer.isMessagesEmpty}
          positionClass={
            settledVoiceActive
              ? "sticky bottom-0 left-0 right-0 z-30 p-6"
              : composer.isMessagesEmpty
                ? "absolute left-1/2 top-[35%] z-40 w-full p-6"
                : "sticky bottom-0 left-0 right-0 z-30 p-6"
          }

          // pass through your existing state/handlers/refs
          attachments={composer.attachments}
          isPrivateMode={isPrivateMode}
          thinkingActive={isCurrentConversationBusy && thinkingState?.isActive}
          isStreaming={isCurrentConversationBusy}
          currentMessage={composer.currentMessage}
          setCurrentMessage={composer.setCurrentMessage}
          handlePaste={composer.handlePaste}
          handleSendMessage={handleSendMessage}
          handleStopStreaming={handleStopStreaming}
          isImageFile={composer.isImageFile}
          getImageUrl={composer.getImageUrl}
          handleImageClick={handleImageClick}
          removeAttachment={composer.removeAttachment}
          handleFileUpload={composer.handleFileUpload}
          fileInputRef={composer.fileInputRef}
          textareaRef={composer.textareaRef}
          containerRef={composer.composerContainerRef}
          emptyWrapperStyle={settledVoiceActive ? undefined : composer.emptyWrapperStyle}
          textareaMaxHeight={composer.textareaMaxHeight}
          onDictationSubmit={composer.handleDictationSubmit}
          onDictationStatusChange={composer.handleDictationStatusChange}
          dictationStatus={composer.dictationStatus}
          dictationRequestSignal={composer.dictationRequestSignal}
          dictationCancelSignal={composer.dictationCancelSignal}
          onVoiceMode={triggerVoiceMode}
          voiceStatus={voiceSession.status}
          voiceMuted={voiceSession.muted}
          onCloseVoiceMode={voiceSession.close}
          onToggleVoiceMute={voiceSession.toggleMute}
          onVoiceTextSubmit={voiceSession.sendText}

          // UI deps
          Tooltip={Tooltip}
          TooltipTrigger={TooltipTrigger}
          TooltipContent={TooltipContent}
          toast={toast}
          currentAgent={inputBarAgent ?? undefined}
          Textarea={Textarea}
          topAccessory={
            showPlanningCard && activePlan ? (
              <PlanCard
                plan={activePlan}
                expanded={isPlanExpanded}
                onToggle={() => setIsPlanExpanded((prev) => !prev)}
                title="Deep agent execution plan"
                className="absolute bottom-[calc(100%-1px)] left-1/2 z-10 w-[min(100%,39rem)] -translate-x-1/2"
              />
            ) : null
          }
          hitlTakeover={
            activeHitlInterrupt && activeConversationRun ? (
              <HitlInputTakeover
                interrupt={{
                  interruptId: activeHitlInterrupt.id,
                  threadId: activeHitlInterrupt.threadId,
                  content: activeHitlInterrupt.content,
                }}
                pendingCount={pendingRunInterrupts.length}
                onResolve={(decisions) =>
                  resumeInferenceRunHandler(activeConversationRun.id, {
                    interruptId: activeHitlInterrupt.id,
                    threadId: activeHitlInterrupt.threadId,
                    // Overall decision (legacy/back-compat field): approve
                    // unless every action was rejected. Per-action outcomes
                    // ride in `decisions`.
                    decision: decisions.some((d) => d.decision === "approve")
                      ? "approve"
                      : "reject",
                    reason: decisions.find((d) => d.decision === "reject" && d.reason)?.reason,
                    decisions,
                  })
                }
              />
            ) : null
          }
          starterSuggestions={canShowStarterSuggestions ? starterSuggestions : []}
          onStarterSuggestionSelect={handleStarterSuggestionSelect}
        />
      </div>

      {loadingConversation && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-md transition-opacity duration-200 animate-fade-in">
          <Loader size={36} className="text-white/90" />
        </div>
      )}
    </>
  );
}
