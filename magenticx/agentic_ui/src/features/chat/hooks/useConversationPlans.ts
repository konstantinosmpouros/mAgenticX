import { useMemo } from "react";

import {
  buildConversationPlans,
  collectPlanAnswers,
  type ConversationPlans,
} from "@/features/chat/lib/conversationPlans";
import type { MessageOut, RunTimeline } from "@/shared/lib/types";

/**
 * The plans of the branch the user sees: `messages` is the same list the chat
 * body renders, and the live answer takes the active run's timeline while it
 * streams. Settled answers' plans are read once per event log and rebuilt only
 * when they change (lib/conversationPlans), so a streamed frame rebuilds one.
 */
export function useConversationPlans(
  messages: MessageOut[],
  liveMessageId: string | null,
  liveTimeline: RunTimeline | null,
): ConversationPlans {
  return useMemo(
    () =>
      buildConversationPlans(
        collectPlanAnswers(messages, { messageId: liveMessageId, timeline: liveTimeline }),
      ),
    [messages, liveMessageId, liveTimeline],
  );
}
