import * as React from "react";
import { GitCommitHorizontal, Loader2, RotateCcw, SendHorizontal, Square } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { MessageOut } from "@/shared/lib/types";
import { ChatMessage } from "@/features/chat/components/ChatMessage";
import { AiTransitionIndicator } from "@/features/chat/components/AiTransitionIndicator";
import { HitlInputTakeover } from "@/features/chat/components/HitlInputTakeover";
import { AskUserTakeover } from "@/features/chat/components/AskUserTakeover";
import type { AttachmentLike } from "@/features/chat/components/message_parts/MessageAttachments";
import { isAskUserInterrupt } from "@/features/inference";
import type { AgentTrial } from "@/features/agents/hooks/useAgentTrial";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/agents/lib/styles";
import { SidePanel } from "./SidePanel";

const COPIED_MS = 1200;
const noop = () => undefined;
const isImage = (attachment: AttachmentLike): boolean => {
  if (typeof attachment !== "object" || attachment === null) return false;
  const record = attachment as { mime?: unknown; mime_type?: unknown; contentType?: unknown };
  return String(record.mime ?? record.mime_type ?? record.contentType ?? "").startsWith("image/");
};

/**
 * "Try it" (plan 40): a chat beside the canvas with the agent as the builder
 * holds it now — uncommitted. Every message runs the latest draft, and a
 * "Draft changed" line marks the turns where the draft differed from the turn
 * before. The transcript is the main chat's own message rendering
 * (`ChatMessage`, the live timeline, the thinking orb), and approvals and
 * questions take over the composer as they do there. The composer is plain
 * text: no attachments, voice or slash commands.
 *
 * The run itself lives in `useAgentTrial`, owned by the builder, so closing
 * the panel keeps the chat; Reset or leaving the builder discards it.
 */
export function TryItPanel({
  open,
  onOpenChange,
  trial,
  existing,
  agentName,
  AgentIcon,
  note,
  onSend,
  onStop,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trial: AgentTrial;
  /** A saved agent: the trial uses its real memory. */
  existing: boolean;
  agentName: string;
  AgentIcon: LucideIcon;
  /** Why the last message did not go (a builder issue, the server's refusal). */
  note: string | null;
  /** Resolves true when the message went; the composer then clears. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onReset: () => void;
}) {
  const [text, setText] = React.useState("");
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = React.useState<Record<string, boolean>>({});
  const endRef = React.useRef<HTMLDivElement>(null);
  const { messages, run, active, sending, pendingInterrupts } = trial;
  const busy = sending || active;
  const streamingId = active ? (run?.assistantMessageId ?? null) : null;
  const interrupt = pendingInterrupts[0] ?? null;
  const agent = React.useMemo(() => ({ name: agentName, Icon: AgentIcon }), [agentName, AgentIcon]);

  // Keep the newest of the conversation in view as it grows.
  const timeline = run?.timeline;
  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, timeline, open]);

  const submit = async () => {
    const message = text.trim();
    if (!message || busy) return;
    if (await onSend(message)) setText("");
  };

  const copy = (content: string, messageId: string) => {
    void navigator.clipboard?.writeText(content);
    setCopiedId(messageId);
    window.setTimeout(() => setCopiedId(null), COPIED_MS);
  };

  const download = (attachment: AttachmentLike, message: MessageOut) => {
    if (typeof attachment !== "object" || attachment === null) return;
    void trial.download(attachment as { blobId?: string; name?: string }, message).catch(noop);
  };

  const takeover = !interrupt || !run ? null : isAskUserInterrupt(interrupt.content) ? (
    <AskUserTakeover
      key={interrupt.id}
      interrupt={{ interruptId: interrupt.id, threadId: interrupt.threadId, content: interrupt.content }}
      agentName={agentName}
      onResolve={(resolution) =>
        trial.resume({ interruptId: interrupt.id, threadId: interrupt.threadId, ...resolution })
      }
    />
  ) : (
    <HitlInputTakeover
      key={interrupt.id}
      interrupt={{ interruptId: interrupt.id, threadId: interrupt.threadId, content: interrupt.content }}
      pendingCount={pendingInterrupts.length}
      onResolve={(decisions) =>
        trial.resume({
          interruptId: interrupt.id,
          threadId: interrupt.threadId,
          // As the main chat sends it: approve unless every action was rejected.
          decision: decisions.some((d) => d.decision === "approve") ? "approve" : "reject",
          reason: decisions.find((d) => d.decision === "reject" && d.reason)?.reason,
          decisions,
        })
      }
    />
  );

  const composer = (
    <div className="space-y-2">
      {note ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {note}
        </p>
      ) : null}
      {takeover ?? (
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={`Message ${agentName}`}
            aria-label="Message the draft"
            className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
          />
          {active ? (
            <button
              type="button"
              onClick={onStop}
              disabled={run?.status === "cancelling"}
              className={cn(SECONDARY_BUTTON, "h-10 px-3 text-xs")}
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !text.trim()}
              aria-label="Send"
              className={cn(PRIMARY_BUTTON, "h-10 px-3")}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <SendHorizontal className="h-4 w-4" aria-hidden />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Try it"
      description={
        existing
          ? "Runs the uncommitted draft; nothing is committed. It uses the agent's real memory."
          : "Runs the uncommitted draft; nothing is committed or saved."
      }
      actions={
        <button
          type="button"
          onClick={onReset}
          disabled={!messages.length && !busy}
          className={cn(SECONDARY_BUTTON, "px-3 py-1.5 text-xs")}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </button>
      }
      footer={composer}
    >
      {messages.length === 0 ? (
        <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <AgentIcon className="h-6 w-6 text-primary" aria-hidden />
          <p>Send a message to try {agentName} as it is now.</p>
          <p className="text-xs">Edit the agent between messages: each one runs the latest draft.</p>
        </div>
      ) : (
        <div className="space-y-4" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} data-message-id={message.id} className="space-y-2 empty:hidden">
              {trial.draftChangedBefore.has(message.id) ? <DraftChangedDivider /> : null}
              <ChatMessage
                message={message}
                isEditing={false}
                AgentIcon={AgentIcon}
                resolveMessageAgent={() => agent}
                copiedId={copiedId}
                onCopy={copy}
                onLike={noop}
                onDislike={noop}
                readOnly
                isStreaming={active}
                onFlashUserActionBar={noop}
                userActionVisibilityClass="opacity-0 transition-opacity group-hover/message:opacity-100"
                thinkingState={null}
                expandedThinking={expandedThinking}
                onToggleThinking={(key, next) =>
                  setExpandedThinking((prev) => ({ ...prev, [key]: next ?? !prev[key] }))
                }
                streamingMessageId={streamingId}
                liveTimeline={streamingId === message.id ? (run?.timeline ?? null) : null}
                isImageFile={isImage}
                onDownloadAttachment={download}
                onLoadAttachment={(attachment, message) => trial.load(attachment as { blobId?: string }, message)}
                onPreviewAttachment={download}
                onImageClick={noop}
                branchData={{ parentId: message.parentMessageId ?? null, selectionIndex: 0 }}
              />
            </div>
          ))}
          <AiTransitionIndicator visible={trial.awaitingSignal} />
        </div>
      )}
      <div ref={endRef} />
    </SidePanel>
  );
}

function DraftChangedDivider() {
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border/60" aria-hidden />
      <GitCommitHorizontal className="h-3 w-3" aria-hidden />
      Draft changed
      <span className="h-px flex-1 bg-border/60" aria-hidden />
    </div>
  );
}
