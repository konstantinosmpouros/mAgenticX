import type {
  AgentEffortChoice,
  AttachmentIn,
  CommandRef,
  EffortLevel,
  MessageIn,
  MessageOut,
} from "@/shared/lib/types";

/**
 * The user message of an inference start (modes new, send, edit and
 * shared_continue, and the queued send). `effort` goes on the wire only when
 * one is given — never as an empty key — so an agent whose model takes no
 * effort never receives one.
 */
export function buildUserMessage({
  parentMessageId,
  content,
  attachments,
  command,
  effort,
}: {
  parentMessageId: string | null;
  content?: string;
  attachments?: AttachmentIn[];
  command?: CommandRef;
  effort?: EffortLevel | null;
}): MessageIn {
  return {
    sender: "user",
    parentMessageId,
    content,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(command ? { command } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** The picked effort when the run goes to the agent it was picked for; otherwise none. */
export function effortForAgent(
  choice: AgentEffortChoice | null | undefined,
  agentId: string | null | undefined,
): EffortLevel | undefined {
  return choice && agentId && choice.agentId === agentId ? (choice.level ?? undefined) : undefined;
}

/**
 * The effort an edited message runs with. The edit is answered by the agent
 * that answered the original (the bridge reuses it), so the composer's pick
 * decides whenever that is the agent it was picked for (no level: none);
 * otherwise the edit keeps the effort the original was sent with, like it
 * keeps its command.
 */
export function effortForEdit(
  choice: AgentEffortChoice | null | undefined,
  target: MessageOut,
  messages: readonly MessageOut[],
  conversationAgentId: string | null | undefined,
): EffortLevel | undefined {
  const reply = messages.find((m) => m.parentMessageId === target.id && m.sender === "ai");
  const answeringAgentId = reply?.agentId ?? conversationAgentId ?? null;
  if (choice && answeringAgentId && choice.agentId === answeringAgentId) {
    return choice.level ?? undefined;
  }
  return target.effort ?? undefined;
}
