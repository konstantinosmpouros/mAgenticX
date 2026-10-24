import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import { Textarea } from "@/shared/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import ChatHeader from "@/features/chat/components/ChatHeader";
import { ChatInputBar } from "@/features/chat/components/ChatInputBar";
import { ChatDisclaimer } from "@/features/chat/components/ChatDisclaimer";
import { PlanCard } from "@/features/chat/components/message_parts/PlanningContainer";
import { HitlInputTakeover } from "@/features/chat/components/HitlInputTakeover";
import { AskUserTakeover } from "@/features/chat/components/AskUserTakeover";
import { isAskUserInterrupt } from "@/features/inference";
import { AgentMapButton } from "@/features/chat/components/agent_map/AgentMapButton";
import { createCommandActions } from "@/features/chat/handlers/commandActions";
import { useSlashCommands } from "@/features/chat/hooks/useSlashCommands";
import { Loader } from "@/shared/ui/shadcn-io/loader";

import { useChatWorkspaceContext } from "@/app/workspaceContext";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

// The chat <-> voice body swap. Both surfaces stay mounted for the exit beat
// (useVoiceBodyTransition), stacked: the leaving one fades and slides away
// while the arriving one comes in — the chat body as a whole, a beat late, the
// voice body item by item (VoiceModeBody's variants: orb first, then its text).
// The composer swaps alongside in ChatInputBar with the same easing. Exits end
// well inside the hook's 560ms beat. Reduced motion: a quick crossfade.
const SWAP_EASE = [0.22, 1, 0.36, 1] as const;
const CHAT_PANEL: Variants = {
  hidden: { opacity: 0, y: 12 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.34, ease: SWAP_EASE, delay: 0.08 } },
  exit: { opacity: 0, y: 10, transition: { duration: 0.2, ease: "easeIn" } },
};
const VOICE_PANEL: Variants = {
  hidden: {},
  shown: { transition: { delayChildren: 0.1 } },
  exit: {},
};
const FADE_PANEL: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};
const BODY_MODES = ["chat", "voice"] as const;

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
    handleSaveCurrentConversation,
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
    conversationContext,
    conversationStats,
    conversationCompaction,
    agentMap,
    agentMapAgentName,
    userId,
    openProfilePanel,
    handleRenameConversation,
    exportConversationPdf,
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
  const reduceMotion = useReducedMotion() ?? false;
  const activeHitlIsQuestion = activeHitlInterrupt
    ? isAskUserInterrupt(activeHitlInterrupt.content)
    : false;

  // Slash commands (plan 35): the agent the next message goes to decides the
  // menu; each action calls what its button calls.
  const runCommandAction = useMemo(
    () =>
      createCommandActions({
        conversationId: currentConversation?.id || null,
        compaction: conversationCompaction,
        handleNewChat,
        openProfilePanel,
        handleRenameConversation,
        openFullConversationShareDialog,
        exportConversationPdf,
        notify: (title, description) => toast({ title, description, variant: "destructive" }),
      }),
    [
      currentConversation?.id,
      conversationCompaction,
      handleNewChat,
      openProfilePanel,
      handleRenameConversation,
      openFullConversationShareDialog,
      exportConversationPdf,
      toast,
    ],
  );
  const slash = useSlashCommands({
    userId,
    agentId: selectedAgent || currentConversation?.agent?.id || null,
    draft: composer.currentMessage,
    setDraft: composer.setCurrentMessage,
    setPendingCommand: composer.setPendingCommand,
    runAction: runCommandAction,
    notify: (title, description) => toast({ title, description }),
    textareaRef: composer.textareaRef,
  });

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
        // Private mode is chosen before the first message; a stored private
        // chat offers "Save chat" instead (one-way: it becomes a normal chat).
        showPrivateToggle={(currentConversation?.messages?.length ?? 0) === 0}
        isPrivateMode={isPrivateMode}
        onTogglePrivate={handleTogglePrivateMode}
        onSaveConversation={
          currentConversation?.id && currentConversation.isPrivate
            ? handleSaveCurrentConversation
            : undefined
        }
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

      {/* Region below the header — the flex column for the body + composer, and
          the area the empty-state lift is measured against (useChatEffects).
          Measuring THIS box (instead of the whole shell, which includes the
          header) and clipping to it is what makes it structurally impossible
          for the lifted greeting/composer to overlap the header and steal its
          clicks. */}
      <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* Chat Messages Container*/}
        <div className="voice-chat-transition-shell relative flex flex-1 min-h-0 overflow-hidden">
          {/* Keyed by surface in a fixed order, so the chat body that is leaving
              is the same element that was showing — it keeps its scroll
              position while it fades out instead of remounting at the top. */}
          {BODY_MODES.filter(
            (mode) => mode === bodyTransition.current || mode === bodyTransition.exiting,
          ).map((mode) => {
            const leaving = mode === bodyTransition.exiting;
            return (
              <motion.div
                key={mode}
                className={`voice-chat-panel ${leaving ? "voice-chat-panel-exit" : "voice-chat-panel-enter"}`}
                aria-hidden={leaving || undefined}
                variants={reduceMotion ? FADE_PANEL : mode === "chat" ? CHAT_PANEL : VOICE_PANEL}
                // The first chat body is simply there; a surface arriving later
                // enters.
                initial={mode === "chat" && !bodyTransition.exiting ? false : "hidden"}
                animate={leaving ? "exit" : "shown"}
              >
                {renderConversationBody(mode)}
              </motion.div>
            );
          })}
        </div>

        {/* Input Area */}
        <ChatInputBar
          mode={voiceSession.isActive ? "voice" : "chat"}
          voiceBarVisible={voiceBarReady}
          chatBarVisible={chatBarReady}
          // Always at the bottom; the empty screen lifts it to the middle, so
          // it stays mounted and glides between a conversation and a new chat.
          // Voice mode keeps it at the bottom once the bar has settled there.
          isMessagesEmpty={composer.isMessagesEmpty}
          positionClass="sticky bottom-0 left-0 right-0 z-40 px-6 pt-6"
          liftY={settledVoiceActive ? null : composer.liftY}

          // pass through your existing state/handlers/refs
          attachments={composer.attachments}
          isPrivateMode={isPrivateMode}
          thinkingActive={isCurrentConversationBusy && thinkingState?.isActive}
          isStreaming={isCurrentConversationBusy}
          contextUsage={conversationContext}
          conversationStats={conversationStats}
          compaction={conversationCompaction}
          slash={voiceSession.isActive ? null : slash}
          agentMapControl={
            <AgentMapButton
              map={agentMap}
              agentName={agentMapAgentName}
              visible={!composer.isMessagesEmpty}
            />
          }
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
          hitlTakeoverThemed={activeHitlIsQuestion}
          hitlTakeover={
            activeHitlInterrupt && activeConversationRun && activeHitlIsQuestion ? (
              // The agent's clarifying questions: answered (or skipped) through
              // the same resume, the answers riding in `value`.
              <AskUserTakeover
                key={activeHitlInterrupt.id}
                interrupt={{
                  interruptId: activeHitlInterrupt.id,
                  threadId: activeHitlInterrupt.threadId,
                  content: activeHitlInterrupt.content,
                }}
                agentName={inputBarAgent?.name}
                onResolve={(resolution) =>
                  resumeInferenceRunHandler(activeConversationRun.id, {
                    interruptId: activeHitlInterrupt.id,
                    threadId: activeHitlInterrupt.threadId,
                    ...resolution,
                  })
                }
              />
            ) : activeHitlInterrupt && activeConversationRun ? (
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

        {/* The card's footer: under the composer in a conversation, at the
            bottom edge while the empty screen lifts the composer. */}
        <ChatDisclaimer />
      </div>

      {loadingConversation && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-md transition-opacity duration-200 animate-fade-in">
          <Loader size={36} className="text-white/90" />
        </div>
      )}
    </>
  );
}
