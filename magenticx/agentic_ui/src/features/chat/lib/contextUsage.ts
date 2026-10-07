import type { ConversationStats, InferenceRun, MessageOut, RunContextUsage } from "@/shared/lib/types";
import { countRunActivity } from "@/features/inference";

/**
 * Where the composer's context gauge reads from.
 *
 * The number that matters is the main agent's prompt on its LATEST model call —
 * system prompt, tools and history, as the provider counted them — against
 * that model's window. While a run is live that is the run timeline's
 * `context` (it updates after every call); otherwise it is the most recent AI
 * message on the visible branch that recorded one. Older messages, other
 * branches and sub-agents never feed it.
 */
export function selectConversationContext(
  messages: MessageOut[],
  liveRun?: InferenceRun | null,
): RunContextUsage | null {
  const live = liveRun?.timeline?.context;
  if (live && typeof live.tokens === "number") return live;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.sender !== "ai" || typeof message.contextTokens !== "number") continue;
    const window = message.contextWindow;
    return {
      model: message.modelName,
      tokens: message.contextTokens,
      window,
      percent: window ? Math.round((1000 * message.contextTokens) / window) / 10 : undefined,
      compactionPercent: message.compactionPercent,
    };
  }
  return null;
}

/** How full the window is, for colour: plenty of room, getting close, or about to compact. */
export function contextLevel(context: RunContextUsage): "ok" | "high" | "critical" {
  const percent = context.percent ?? 0;
  const compactAt = context.compactionPercent ?? 100;
  if (percent >= compactAt - 5) return "critical";
  if (percent >= 70) return "high";
  return "ok";
}

/**
 * The "This conversation" block of the composer's context card.
 *
 * Sums every FINISHED answer in the conversation tree (one that recorded token
 * usage), not just the visible branch: a retried or edited-away answer was
 * still paid for, so it counts, and `replaced` says how many those are. The
 * in-flight answer joins once it finishes. Null until there is one answer.
 */
export function selectConversationStats(
  allMessages: MessageOut[],
  activeMessages: MessageOut[],
): ConversationStats | null {
  const visible = new Set(activeMessages.map((message) => message.id));
  const stats: ConversationStats = {
    answers: 0,
    replaced: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    modelMs: 0,
    timedCalls: 0,
  };
  for (const message of allMessages) {
    if (message.sender !== "ai") continue;
    if (typeof message.inputTokens !== "number" && typeof message.outputTokens !== "number") continue;
    const activity = countRunActivity(message.rawEvents);
    stats.answers += 1;
    if (!visible.has(message.id)) stats.replaced += 1;
    stats.modelCalls += activity.modelCalls;
    stats.toolCalls += activity.toolCalls;
    stats.inputTokens += message.inputTokens ?? 0;
    stats.cachedInputTokens += message.cachedInputTokens ?? 0;
    stats.outputTokens += message.outputTokens ?? 0;
    if (typeof message.modelLatencyMs === "number" && activity.modelCalls > 0) {
      stats.modelMs += message.modelLatencyMs;
      stats.timedCalls += activity.modelCalls;
    }
  }
  return stats.answers > 0 ? stats : null;
}

