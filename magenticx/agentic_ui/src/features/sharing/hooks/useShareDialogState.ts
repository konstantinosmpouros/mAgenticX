import { useEffect, useState } from "react";

import { defaultShareExpiresAt } from "@/features/sharing/handlers/share";
import type { ConversationShareMode, MessageOut } from "@/shared/lib/types";

/**
 * State for the share dialog.
 *
 * Deliberately state-only: the behaviour lives in `createShareConversationHandlers`,
 * which needs the current conversation, the active branch path and the message
 * list to build a link — none of which belong to a dialog. This hook owns the
 * values and setters that factory reads and writes, so ChatPage no longer
 * carries eight loose `useState` calls whose only relationship is that they are
 * all consumed by one dialog.
 */
export function useShareDialogState() {
  const [shareDialogUrl, setShareDialogUrl] = useState<string | null>(null);
  /** Non-null is what opens the dialog — the message being shared up to. */
  const [shareTargetMessage, setShareTargetMessage] = useState<MessageOut | null>(null);
  const [shareMode, setShareMode] = useState<ConversationShareMode>("full");
  const [shareForceFullConversation, setShareForceFullConversation] = useState(false);
  const [shareExpiresAt, setShareExpiresAt] = useState<Date | null>(() => defaultShareExpiresAt());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [isExportingSharePdf, setIsExportingSharePdf] = useState(false);
  /** Drives the "Copied" flash on the copy button; self-clearing. */
  const [isShareCopyPulse, setIsShareCopyPulse] = useState(false);

  useEffect(() => {
    if (!isShareCopyPulse) return;
    const timeout = window.setTimeout(() => setIsShareCopyPulse(false), 1100);
    return () => window.clearTimeout(timeout);
  }, [isShareCopyPulse]);

  return {
    shareDialogUrl,
    setShareDialogUrl,
    shareTargetMessage,
    setShareTargetMessage,
    shareMode,
    setShareMode,
    shareForceFullConversation,
    setShareForceFullConversation,
    shareExpiresAt,
    setShareExpiresAt,
    isCreatingShareLink,
    setIsCreatingShareLink,
    isExportingSharePdf,
    setIsExportingSharePdf,
    isShareCopyPulse,
    setIsShareCopyPulse,
  };
}
